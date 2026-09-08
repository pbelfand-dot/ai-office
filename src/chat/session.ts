import type { Office } from "../office.js";
import type { ChatMessage, Task } from "../types.js";
import { HUMAN, SYSTEM } from "../types.js";
import { runTurn, type TurnOutcome } from "../orchestrator/turn.js";
import { NO_WRITES, READ_ONLY_TOOLS, followUpPrompt, parseFollowUp, route, type Assignment, type Routing } from "./router.js";
import { nowIso, shortId, truncate } from "../util.js";
import { renderTranscript, speakerName } from "./transcript.js";

export interface ChatExchange {
  posted: ChatMessage;
  routing: Routing;
  replies: ChatMessage[];
  /** Work the router put on the queue, if it assigned any. */
  queued: Task[];
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

  // The assignment lands before the work does, so the desk answering has
  // already been told what angle to take -- which is the difference between a
  // boss and a caption on someone else's message.
  if (routing.say) {
    replies.push(await office.chat.post({ channel, from: office.config.router, body: routing.say, replyTo: posted.id }));
  }

  for (const agentId of routing.recipients) {
    const reply = await replyFrom(office, agentId, channel, posted);
    if (reply) replies.push(reply);
  }

  // Volunteers speak last on purpose: they are answering the room, not the
  // question, and a desk with nothing to add says so by staying out of it.
  for (const agentId of routing.alsoAsk) {
    const spoke = await replyFrom(office, agentId, channel, posted, { mayPass: true });
    if (spoke) replies.push(spoke);
  }

  const queued = await assign(office, routing.assignments, channel, posted);

  // The boss gets the last word, because it is the only point at which he has
  // heard the answers. A desk that just named a blocker has told him what to
  // assign; before the replies, that information did not exist yet.
  const closing = await followUp(office, channel, posted, replies.length > 0);
  // Saying the same thing twice reads as a bug even when it is only a boss
  // who has not changed his mind.
  if (closing.say && closing.say !== routing.say) replies.push(await office.chat.post({ channel, from: office.config.router, body: closing.say, replyTo: posted.id }));
  queued.push(...(await assign(office, closing.assignments, channel, posted)));

  return { posted, routing, replies, queued };
}

/** A second look from a visible boss, once the room has answered. */
async function followUp(office: Office, channel: string, prompt: ChatMessage, roomSpoke: boolean): Promise<{ assignments: Assignment[]; say?: string }> {
  const routerId = office.config.router;
  // A hidden switchboard is a classifier and has no standing to hand out work,
  // and there is nothing to follow up on when nobody said anything.
  if (!roomSpoke || !office.roles.has(routerId) || office.role(routerId).hidden) return { assignments: [] };

  const history = await office.chat.history(channel, office.config.chat.historyDepth);
  const known = office.agentIds().filter((id) => id !== routerId);

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn(office, routerId, null, followUpPrompt(office, history), {
      thread: "chat",
      maxTier: office.config.chat.routerTier,
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: NO_WRITES,
      timeoutMs: office.config.chat.turnTimeoutMs,
    });
  } catch {
    return { assignments: [] };
  }

  // Nothing assigned is the common outcome, so every failure here is silent:
  // the room already answered, and an error about the boss's second thoughts
  // helps nobody.
  if (!outcome.ran || !outcome.result?.ok) return { assignments: [] };
  return parseFollowUp(outcome.result.text, known);
}

/**
 * Turn the router's assignments into work the floor actually does.
 *
 * Chat turns are read-only by design, so a desk that "agreed to write the
 * sequence" in the channel has written nothing. A task is the difference: it
 * runs with real tools in the desk's own worktree, under the same gate and the
 * same budget as anything else, and it shows up in the queue where you can see
 * it. This is why the room stops being idle after you ask it for something.
 */
async function assign(office: Office, assignments: Assignment[], channel: string, prompt: ChatMessage): Promise<Task[]> {
  if (assignments.length === 0) return [];

  const tasks: Task[] = assignments.map(({ to, task }) => ({
    id: shortId("task"),
    briefId: prompt.id,
    title: truncate(task, 60),
    instruction: task,
    assignee: to,
    state: "pending",
    dependsOn: [],
    createdAt: nowIso(),
    attempts: 0,
  }));
  for (const task of tasks) await office.upsertTask(task);

  const lines = tasks.map((t) => `${speakerName(office, t.assignee)}: ${t.title}`);
  await office.chat.post({
    channel,
    from: SYSTEM,
    body: `On the queue now -- ${lines.join("; ")}. Run \`office run\` to work it.`,
    replyTo: prompt.id,
  });
  return tasks;
}

/**
 * A desk invited rather than assigned says nothing by returning this, and it
 * never reaches the channel. Silence has to be cheap or nobody stays quiet.
 */
const PASS = "PASS";

/**
 * One desk's turn in the channel.
 *
 * Never throws. A desk that cannot answer -- spent budget, a parked breaker, a
 * CLI that fell over -- says so in the channel as a line from the office, so
 * silence in the room always means "nothing to add" and never "something broke
 * where you could not see it".
 */
async function replyFrom(office: Office, agentId: string, channel: string, prompt: ChatMessage, opts: { mayPass?: boolean } = {}): Promise<ChatMessage | null> {
  const history = await office.chat.history(channel, office.config.chat.historyDepth);
  // A desk that was only invited fails quietly: an "X did not answer" line for
  // someone nobody asked is noise about a turn that was optional anyway.
  const excuse = (why: string) =>
    opts.mayPass
      ? null
      : office.chat.post({ channel, from: SYSTEM, body: `${speakerName(office, agentId)} did not answer: ${why}`, replyTo: prompt.id });

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn(office, agentId, null, replyPrompt(office, history, opts.mayPass ?? false), {
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
  if (opts.mayPass && (text === PASS || text.replace(/[.\s]/g, "").toUpperCase() === PASS)) return null;
  return office.chat.post({ channel, from: agentId, body: text, replyTo: prompt.id });
}

function replyPrompt(office: Office, history: ChatMessage[], mayPass: boolean): string {
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
    ...(mayPass
      ? [
          "",
          "Nobody asked you: you are speaking only if you have something the answer",
          `above is missing. If you do not, reply with exactly ${PASS} and nothing`,
          "else. Agreeing is not something worth adding, and neither is restating a",
          "point in your own words. Passing is the normal outcome.",
        ]
      : []),
  ].join("\n");
}
