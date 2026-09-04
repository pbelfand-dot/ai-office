import type { Message, Role } from "../types.js";
import { truncate } from "../util.js";

/**
 * The protocol every agent is told about.
 *
 * Agents cannot call each other in-process -- each one is a separate CLI with
 * its own context. So coordination happens through commands they can run in
 * their own shell, which means the office's own binary has to be on PATH
 * inside the worktree. Anything an agent cannot express as one of these four
 * commands, it cannot do to the rest of the floor.
 */
export const PROTOCOL = `## How this office works

You are one agent among several, each in a separate git worktree of the same
repository. You cannot see the others' terminals. You coordinate with them by
running these commands in your shell:

- \`office mail <agent> "<subject>" "<body>"\` — send a message. Use it when you
  need a decision, an interface, or a fact that another agent owns. Do not
  guess at something another agent has already settled.
- \`office inbox\` — read messages addressed to you. Do this first, every turn.
- \`office remember "<what you learned>"\` — write to your long-term memory. Use
  it for decisions and their reasons, not for narration. This survives restarts;
  your conversation may not.
- \`office recall "<query>"\` — search every agent's memory, not just your own.
  Check here before re-deriving something.
- \`office escalate "<question>"\` — stop and hand a decision to the human. Use it
  for anything irreversible, anything that spends money, and anything outside
  your scope. Escalating is not failure; guessing on these is.

Two rules that are not negotiable:

1. Work only inside your own worktree. It is your current directory.
2. If you are blocked, say so and escalate. Do not spin. A turn that repeats
   your last turn will be caught and your desk will be shut down.`;

export interface PromptContext {
  role: Role;
  memoryBrief: string;
  inbox: Message[];
  steer?: string;
  budgetNote?: string;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { role } = ctx;
  const parts: string[] = [
    `# You are ${role.name}, ${role.title}`,
    role.briefing,
    PROTOCOL,
  ];

  if (role.scope.length) {
    parts.push(
      `## Your scope\n\nYou may write to: ${role.scope.join(", ")}\n\n` +
      `Writing outside that list does not fail silently — it stops your turn and ` +
      `puts the change in front of a human before it lands. If the job genuinely ` +
      `needs a file outside your scope, mail the agent who owns it or escalate.`,
    );
  }

  if (ctx.memoryBrief.trim()) parts.push(`## Your memory\n\n${ctx.memoryBrief}`);

  if (ctx.inbox.length) {
    const rendered = ctx.inbox
      .map((m) => `- **from ${m.from}** — ${m.subject}\n  ${truncate(m.body.replace(/\s+/g, " "), 400)}`)
      .join("\n");
    parts.push(`## Unread mail (${ctx.inbox.length})\n\n${rendered}\n\nAnswer what needs answering before starting new work.`);
  }

  if (ctx.budgetNote) parts.push(`## Budget\n\n${ctx.budgetNote}`);
  if (ctx.steer) parts.push(`## Course correction\n\n${ctx.steer}`);

  return parts.join("\n\n");
}
