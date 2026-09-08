import type { Office } from "../office.js";
import { HUMAN, SYSTEM } from "../types.js";
import { say } from "../chat/session.js";
import { speakerName } from "../chat/transcript.js";
import { bold, dim, yellow } from "./format.js";

/**
 * The channel from a terminal.
 *
 * Same path the dashboard takes, minus the streaming: here the replies are
 * awaited and printed together, because a shell that returns before anyone has
 * answered has told you nothing.
 */
export async function chat(office: Office, message: string | undefined, opts: { channel?: string; limit: number }): Promise<string> {
  const channel = opts.channel ?? office.config.chat.channel;

  if (!message) {
    const history = await office.chat.history(channel, opts.limit);
    if (history.length === 0) return dim(`Nothing said in #${channel} yet. Start it: office chat "..."`);
    return history.map((m) => render(office, m.from, m.body, m.at)).join("\n\n");
  }

  const { posted, routing, replies } = await say(office, message, { channel });
  const lines = [render(office, posted.from, posted.body, posted.at), "", dim(`routed to ${routing.recipients.join(", ") || "nobody"} — ${routing.reason}`)];

  if (replies.length === 0) {
    lines.push("", dim("Nobody had anything to add. That is the switchboard doing its job, not a failure."));
  }
  for (const reply of replies) {
    lines.push("", render(office, reply.from, reply.body, reply.at));
  }
  return lines.join("\n");
}

function render(office: Office, from: string, body: string, at: string): string {
  const who = from === HUMAN ? "You" : speakerName(office, from);
  const name = from === SYSTEM ? yellow(who) : bold(who);
  return `${name} ${dim(new Date(at).toLocaleTimeString())}\n${body.trim()}`;
}
