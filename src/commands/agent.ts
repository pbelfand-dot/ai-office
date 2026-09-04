import { join } from "node:path";
import type { Office } from "../office.js";
import { writeJsonAtomic, nowIso, truncate } from "../util.js";
import { bold, dim, green, table, yellow } from "./format.js";

/**
 * The commands an agent runs on itself.
 *
 * Each one resolves the caller from OFFICE_AGENT, which the harness sets on the
 * child process. A human can pass --as to stand in for an agent, which is how
 * you test a role without spending a turn on it.
 */
export function callerOf(explicit?: string): string {
  const agent = explicit ?? process.env.OFFICE_AGENT;
  if (!agent) {
    throw new Error(
      "This command has to know which agent is calling. Inside an agent's shell " +
      "OFFICE_AGENT is set automatically; from your own shell, pass --as <agent>.",
    );
  }
  return agent;
}

export async function mail(office: Office, from: string, to: string, subject: string, body: string, taskId?: string): Promise<string> {
  if (!office.roles.has(to)) {
    throw new Error(`there is no agent named "${to}". On the floor: ${office.agentIds().join(", ")}`);
  }
  if (to === from) throw new Error("an agent cannot mail itself; use `office remember` for notes to self");
  const msg = await office.mail.send({ from, to, subject, body, taskId });
  return `${green("sent")} ${msg.id} to ${bold(to)} ${dim("(delivered on the next scheduler tick)")}`;
}

export async function inbox(office: Office, agent: string, opts: { all: boolean; read: boolean }): Promise<string> {
  // Deliver first. Otherwise mail sent since the last scheduler tick is sitting
  // in someone's outbox and this reads as an empty inbox, which is a lie.
  await office.router.deliverAll(new Set(office.agentIds()));
  const messages = await office.mail.inbox(agent, { unreadOnly: !opts.all });
  if (messages.length === 0) return dim(opts.all ? "Nothing in the inbox." : "No unread mail.");

  const rendered = messages
    .map((m) => [
      `${bold(m.from)} ${dim("->")} ${bold(m.to)}  ${dim(m.sentAt)}`,
      bold(m.subject),
      m.body.trim(),
      dim(`  id ${m.id}${m.taskId ? ` · task ${m.taskId}` : ""}`),
    ].join("\n"))
    .join("\n\n---\n\n");

  if (opts.read) {
    await office.mail.markRead(agent, messages.map((m) => m.id));
    return `${rendered}\n\n${dim(`${messages.length} message(s) marked read and archived.`)}`;
  }
  return `${rendered}\n\n${dim("Run `office inbox --read` once you have acted on these.")}`;
}

export async function remember(office: Office, agent: string, text: string, tag?: string): Promise<string> {
  await office.memory.remember(agent, text, tag);
  return `${green("remembered")} ${dim(truncate(text.replace(/\s+/g, " "), 70))}`;
}

export async function recall(office: Office, query: string, opts: { agent?: string; limit: number }): Promise<string> {
  const hits = await office.index.search(query, opts.limit, { agent: opts.agent });
  if (hits.length === 0) return dim(`Nothing in the office's memory matches "${query}".`);
  return hits
    .map((h) => `${bold(h.agent)} ${dim(`${h.source}${h.at ? ` ${h.at}` : ""} · score ${h.score.toFixed(2)}`)}\n  ${truncate(h.text.replace(/\s+/g, " "), 300)}`)
    .join("\n\n");
}

export async function escalate(office: Office, agent: string, question: string, taskId?: string): Promise<string> {
  const escalation = await office.escalations.raise({
    agent,
    taskId,
    kind: "explicit",
    summary: `${agent} needs a decision`,
    detail: question,
  });
  const state = await office.state(agent);
  await office.saveState({ ...state, status: "blocked" });
  return [
    `${yellow("escalated")} ${escalation.id}`,
    dim(`  ${agent} is now blocked until this is answered.`),
    dim(`  Answer it with: office approve ${escalation.id} --note "<your decision>"`),
  ].join("\n");
}

/** Drop the marker the scheduler looks for to call a task complete. */
export async function done(office: Office, agent: string, summary: string, taskId?: string): Promise<string> {
  const state = await office.state(agent);
  const id = taskId ?? state.currentTaskId;
  await office.paths.ensureAgent(agent);
  await writeJsonAtomic(join(office.paths.agent(agent), `done-${id ?? "adhoc"}.json`), {
    taskId: id, agent, summary, at: nowIso(),
  });
  await office.memory.remember(agent, summary, "done");
  return `${green("done")} ${dim(id ? `task ${id}` : "ad-hoc work")}`;
}

export async function revive(office: Office, agent: string): Promise<string> {
  office.role(agent); // fail with the roster, not with a confusing empty result
  const state = await office.state(agent);
  if (state.status !== "parked" && state.breakerStage === 0) return dim(`${agent} is not parked.`);
  await office.saveState({ ...state, status: "idle", breakerStage: 0, recentFingerprints: [], idleTurns: 0, tierOverride: undefined });
  return [
    `${green("revived")} ${bold(agent)}`,
    dim("  The breaker is reset and the tier override is cleared. If nothing about the"),
    dim("  task changed, it will loop again -- change the instruction, not just the state."),
  ].join("\n");
}

export async function diff(office: Office, agent: string): Promise<string> {
  office.role(agent); // fail with the roster, not with a confusing empty result
  const info = await office.worktrees.info(agent);
  if (!info) return dim(`${agent} has no worktree yet; it has not been given any work.`);
  const patch = await office.worktrees.diff(agent);
  const header = table([
    [dim("branch"), info.branch],
    [dim("path"), info.path],
    [dim("dirty"), info.dirty ? yellow("yes") : "no"],
  ]);
  return patch.trim() ? `${header}\n\n${patch}` : `${header}\n\n${dim("No changes.")}`;
}
