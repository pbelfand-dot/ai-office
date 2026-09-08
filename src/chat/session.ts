import type { Office } from "../office.js";
import type { ChatMessage } from "../types.js";
import { HUMAN, SYSTEM } from "../types.js";
import { runTurn, type TurnOutcome } from "../orchestrator/turn.js";
import { NO_WRITES, READ_ONLY_TOOLS, route, type Routing } from "./router.js";
import { renderTranscript, speakerName } from "./transcript.js";

export interface ChatExchange {
  posted: ChatMessage;
  routing: Routing;
  replies: ChatMessage[];
}

/**
 * Post a message to a channel and let whoever it was for answer.
 *
 * Replies run one after another, not in parallel, and each one is handed the
 * channel as it stands -- so the second desk sees the first one's answer and
 * can build on it or disagree with it, which is the entire difference between a
 * group chat and three private replies pasted together. It also means chat can
 * never exceed a provider's concurrency cap, since it only ever runs one turn.
 */
export async function say(office: Office, body: string, opts: { channel?: string; from?: string } = {}): Promise<ChatExchange> {
  const text = body.trim();
  if (!text) throw new Error("a chat message needs something in it");

  const channel = opts.channel ?? office.config.chat.channel;
  const from = opts.from ?? HUMAN;
  const depth = office.config.chat.historyDepth;

  const before = await office.chat.history(channel, depth);
  const posted = await office.chat.post({ channel, from, body: text });

  const routing = await route(office, posted, before);
  const replies: ChatMessage[] = [];
  for (const agentId of routing.recipients) {
    replies.push(await replyFrom(office, agentId, channel, posted));
  }

  return { posted, routing, replies };
}

/**
 * One desk's turn in the channel.
 *
 * Never throws. A desk that cannot answer -- spent budget, a parked breaker, a
 * CLI that fell over -- says so in the channel as a line from the office, so
 * silence in the room always means "nothing to add" and never "something broke
 * where you could not see it".
 */
async function replyFrom(office: Office, agentId: string, channel: string, prompt: ChatMessage): Promise<ChatMessage> {
  const history = await office.chat.history(channel, office.config.chat.historyDepth);
  const excuse = (why: string) =>
    office.chat.post({ channel, from: SYSTEM, body: `${speakerName(office, agentId)} did not answer: ${why}`, replyTo: prompt.id });

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn(office, agentId, null, replyPrompt(office, history), {
      thread: "chat",
      maxTier: office.config.chat.maxTier,
      // Read-only by construction on Claude. Codex takes no tool flags, so
      // there the worktree and the gate are what stop a chat turn editing.
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: NO_WRITES,
      timeoutMs: office.config.chat.turnTimeoutMs,
    });
  } catch (err) {
    return excuse(err instanceof Error ? err.message : String(err));
  }

  const text = (outcome.result?.text ?? "").trim();
  if (!outcome.ran || !text) {
    return excuse(outcome.blockedBy ?? outcome.result?.error ?? "the turn produced no reply");
  }
  return office.chat.post({ channel, from: agentId, body: text, replyTo: prompt.id });
}

function replyPrompt(office: Office, history: ChatMessage[]): string {
  const room = office.agentIds().map((id) => `${office.role(id).name} (${office.role(id).title})`).join(", ");
  return [
    "You are in the office group chat. Read the room, then reply to the last",
    "message as yourself.",
    "",
    `In the room: the human, ${room}.`,
    "",
    "## The channel",
    "",
    renderTranscript(office, history),
    "",
    "## Your reply",
    "",
    "Write the message you would send, and nothing else -- no name prefix, no",
    "preamble about what you are about to say, no summary of the thread. A few",
    "sentences at most. If you have nothing to add beyond agreeing, say that in",
    "one line rather than restating the thread.",
  ].join("\n");
}
