import { readdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../util.js";
import type { Office } from "../office.js";
import type { Provider, Task } from "../types.js";
import { enabledProviders } from "../config.js";
import { runTurn, type TurnOutcome } from "./turn.js";
import { canReportDone } from "../gate/policy.js";

/**
 * The completion signal an agent can give without a shell.
 *
 * `office done` stays the real protocol -- it carries the task id and survives a
 * chatty final message. But completion is the one thing that must never be
 * missed: a desk that finished and could not say so has its work thrown away
 * and redone at full price, up to the attempt ceiling, and from the outside the
 * floor just looks idle. So there is a second way to say it that needs nothing
 * but words.
 */
export const DONE_LINE = "OFFICE-DONE:";

/**
 * A completion stated in the reply, when the command was not run.
 *
 * Anchored to the start of a line so that talking about finishing is not
 * finishing, and tolerant of the markdown a model wraps around a label it is
 * trying to make prominent.
 */
export function spokenDone(text: string): string | null {
  const summary = /^[*_`\s]*OFFICE-DONE:[*_`\s]*(.+)$/m.exec(text)?.[1]?.trim();
  return summary ? summary.replace(/[*_`]+$/, "").trim() || null : null;
}

export interface SchedulerEvent {
  type: "start" | "turn" | "done" | "blocked" | "stalled" | "budget";
  agent?: string;
  taskId?: string;
  message: string;
}

export interface RunSummary {
  turns: number;
  completed: string[];
  blocked: string[];
  failed: string[];
  stoppedBecause: string;
}

export interface RunOptions {
  /** Hard ceiling on turns for this run, independent of the budget. */
  maxTurns?: number;
  onEvent?: (event: SchedulerEvent) => void;
  /** Give up on a task after this many turns without a completion marker. */
  maxAttemptsPerTask?: number;
}

/**
 * The floor's clock.
 *
 * Concurrency is capped by config, not by how many desks exist, because every
 * agent draws on the same subscription. Two agents is not a limitation of the
 * design -- on a Max 5x plan it is the honest number, and a queue that finishes
 * beats four agents that all stop mid-sentence when the window closes.
 */
export class Scheduler {
  constructor(private readonly office: Office) {}

  async run(opts: RunOptions = {}): Promise<RunSummary> {
    const maxTurns = opts.maxTurns ?? 50;
    const maxAttempts = opts.maxAttemptsPerTask ?? 8;
    const emit = opts.onEvent ?? (() => {});
    const summary: RunSummary = { turns: 0, completed: [], blocked: [], failed: [], stoppedBecause: "nothing left to do" };
    const spent = new Set<Provider>();

    while (summary.turns < maxTurns) {
      const delivery = await this.office.router.deliverAll(new Set(this.office.agentIds()));
      for (const drop of delivery.dropped) {
        emit({ type: "blocked", agent: drop.from, message: `mail to "${drop.to}" was dropped: ${drop.reason}` });
      }

      const tasks = await this.office.tasks();
      const runnable = await this.runnable(tasks);
      if (runnable.length === 0) {
        const waiting = tasks.filter((t) => t.state === "pending" || t.state === "assigned");
        if (waiting.length) {
          summary.stoppedBecause = `${waiting.length} task(s) cannot start: ${await this.explainStall(waiting)}`;
          emit({ type: "stalled", message: summary.stoppedBecause });
        }
        break;
      }

      // Ask each pool once, before dispatching, rather than letting every desk
      // discover a spent budget inside its own turn. Otherwise a stopped
      // provider still consumes slots and emits turn events for work that
      // cannot happen -- and worse, crowds out desks whose pool is fine.
      const blocked = new Set<Provider>();
      for (const provider of enabledProviders(this.office.config)) {
        const verdict = await this.office.ledger.check(provider, this.office.config.defaults.tier);
        if (verdict.allow) continue;
        blocked.add(provider);
        if (!spent.has(provider)) {
          spent.add(provider);
          emit({ type: "budget", message: verdict.reason });
        }
      }

      const batch = this.fillSlots(runnable, blocked);
      if (batch.length === 0) {
        const live = enabledProviders(this.office.config).filter((p) => !spent.has(p));
        summary.stoppedBecause = live.length === 0
          ? `every provider's budget is spent (${[...spent].join(", ")})`
          : `${runnable.length} task(s) are waiting on a spent pool (${[...spent].join(", ")})`;
        emit({ type: "budget", message: summary.stoppedBecause });
        break;
      }

      const outcomes = await Promise.all(batch.map((task) => this.runOne(task, maxAttempts, emit)));
      summary.turns += outcomes.filter((o) => o.ran).length;

      for (const outcome of outcomes) {
        if (outcome.completed) summary.completed.push(outcome.task.id);
        if (outcome.task.state === "blocked") summary.blocked.push(outcome.task.id);
        if (outcome.task.state === "failed") summary.failed.push(outcome.task.id);
      }

      // A spent pool stops that provider's desks, not the floor. The whole
      // point of a second subscription is that Claude hitting its wall leaves
      // the Codex desks working, so only stop when nothing anywhere can run.
      for (const outcome of outcomes) {
        if (!outcome.ran && outcome.blockedBy?.includes("budget spent")) {
          const provider = this.office.role(outcome.task.assignee).provider;
          if (!spent.has(provider)) {
            spent.add(provider);
            emit({ type: "budget", message: outcome.blockedBy });
          }
        }
      }

      if (outcomes.every((o) => !o.ran)) {
        const live = enabledProviders(this.office.config).filter((p) => !spent.has(p));
        summary.stoppedBecause = live.length === 0
          ? `every provider's budget is spent (${[...spent].join(", ")})`
          : outcomes[0]?.blockedBy ?? "every runnable task is blocked";
        emit({ type: spent.size ? "budget" : "stalled", message: summary.stoppedBecause });
        break;
      }
    }

    if (summary.turns >= maxTurns) summary.stoppedBecause = `hit the ${maxTurns}-turn ceiling for this run`;
    return summary;
  }

  private async runOne(task: Task, maxAttempts: number, emit: (e: SchedulerEvent) => void): Promise<{ task: Task; ran: boolean; completed: boolean; blockedBy?: string } & Partial<TurnOutcome>> {
    // Checked before spawning, because the failure it catches is invisible from
    // the outside: the desk does the work, cannot run `office done`, and the
    // task looks unfinished. Left alone that is eight identical turns and eight
    // times the bill for one file.
    const role = this.office.role(task.assignee);
    if (!canReportDone(role)) {
      task.state = "failed";
      task.finishedAt = nowIso();
      task.lastError =
        `${task.assignee} has no Bash tool, so it cannot run \`office done\` and no task of its can ever complete. ` +
        `Add Bash to allowedTools in office/agents/${task.assignee}.md, or remove it from disallowedTools.`;
      await this.office.upsertTask(task);
      emit({ type: "blocked", agent: task.assignee, taskId: task.id, message: task.lastError });
      return { task, ran: false, completed: false, blockedBy: task.lastError, breakerStage: 0, touchedFiles: [] };
    }

    task.state = "running";
    task.startedAt ??= nowIso();
    task.attempts += 1;
    await this.office.upsertTask(task);

    emit({ type: "turn", agent: task.assignee, taskId: task.id, message: `${task.assignee} → ${task.title} (attempt ${task.attempts})` });

    const outcome = await runTurn(this.office, task.assignee, task, this.instructionFor(task));

    if (!outcome.ran) {
      task.state = "assigned";
      task.attempts -= 1; // a turn that never started is not an attempt
      await this.office.upsertTask(task);
      return { ...outcome, task, ran: false, completed: false, blockedBy: outcome.blockedBy };
    }

    const marker = (await this.takeDoneMarker(task)) ?? spokenDone(outcome.result?.text ?? "");
    if (marker) {
      task.state = "done";
      task.finishedAt = nowIso();
      task.result = marker;
      await this.office.upsertTask(task);
      emit({ type: "done", agent: task.assignee, taskId: task.id, message: `${task.title}: ${marker.slice(0, 160)}` });
      return { ...outcome, task, ran: true, completed: true };
    }

    if (outcome.escalationId) {
      task.state = "blocked";
      await this.office.upsertTask(task);
      emit({ type: "blocked", agent: task.assignee, taskId: task.id, message: `held for review (${outcome.escalationId}): ${outcome.blockedBy}` });
      return { ...outcome, task, ran: true, completed: false, blockedBy: outcome.blockedBy };
    }

    if (outcome.breakerStage === 3 || task.attempts >= maxAttempts) {
      task.state = "failed";
      task.finishedAt = nowIso();
      task.lastError = outcome.blockedBy ?? `no completion after ${task.attempts} turns`;
      await this.office.upsertTask(task);
      emit({ type: "blocked", agent: task.assignee, taskId: task.id, message: `giving up: ${task.lastError}` });
      return { ...outcome, task, ran: true, completed: false, blockedBy: task.lastError };
    }

    task.state = "assigned";
    await this.office.upsertTask(task);
    return { ...outcome, task, ran: true, completed: false };
  }

  /**
   * Take runnable work up to each provider's own concurrency cap.
   *
   * One global cap would waste the second subscription: two Claude desks would
   * fill the batch and the Codex desks, drawing on an untouched allowance,
   * would wait behind them for no reason.
   */
  private fillSlots(runnable: Task[], blocked: Set<Provider>): Task[] {
    const used = new Map<Provider, number>();
    const batch: Task[] = [];
    for (const task of runnable) {
      const provider = this.office.role(task.assignee).provider;
      if (blocked.has(provider)) continue;
      const cap = this.office.config.providers[provider].maxConcurrentAgents;
      const running = used.get(provider) ?? 0;
      if (running >= cap) continue;
      used.set(provider, running + 1);
      batch.push(task);
    }
    return batch;
  }

  /** Tasks whose dependencies are met and whose assignee is free to work. */
  private async runnable(tasks: Task[]): Promise<Task[]> {
    const done = new Set(tasks.filter((t) => t.state === "done").map((t) => t.id));
    const busy = new Set(tasks.filter((t) => t.state === "running").map((t) => t.assignee));
    const out: Task[] = [];

    for (const task of tasks) {
      if (task.state !== "pending" && task.state !== "assigned") continue;
      if (!task.dependsOn.every((d) => done.has(d))) continue;
      if (busy.has(task.assignee)) continue;
      if (!this.office.roles.has(task.assignee)) continue;
      if (!this.office.config.providers[this.office.role(task.assignee).provider].enabled) continue;
      const state = await this.office.state(task.assignee);
      if (state.status === "parked" || state.status === "blocked") continue;
      out.push(task);
      busy.add(task.assignee);
    }
    return out;
  }

  private async explainStall(waiting: Task[]): Promise<string> {
    const reasons = new Set<string>();
    for (const task of waiting) {
      if (!this.office.roles.has(task.assignee)) { reasons.add(`no agent named "${task.assignee}"`); continue; }
      const state = await this.office.state(task.assignee);
      const provider = this.office.role(task.assignee).provider;
      if (!this.office.config.providers[provider].enabled) reasons.add(`${task.assignee} runs on ${provider}, which is disabled`);
      else if (state.status === "parked") reasons.add(`${task.assignee} is parked by the breaker`);
      else if (state.status === "blocked") reasons.add(`${task.assignee} is waiting on an approval`);
      else if (task.dependsOn.length) reasons.add(`${task.id} waits on ${task.dependsOn.join(", ")}`);
    }
    return [...reasons].join("; ") || "unclear";
  }

  private instructionFor(task: Task): string {
    return (
      `${task.instruction}\n\n` +
      `Talk to colleagues with \`office mail <agent> "<subject>" "<body>"\`. That is ` +
      `the only channel that reaches them; anything else goes nowhere.\n\n` +
      `When this task is finished, run:\n\n` +
      `    office done "<one sentence on what you changed and why>"\n\n` +
      `If that command is unavailable to you, end your reply with a line reading ` +
      `${DONE_LINE} followed by the same sentence. Finishing the work and not ` +
      `saying so is the one failure that costs the most: the office cannot see ` +
      `your files, only your signal, and without it this task runs again from ` +
      `scratch and bills again for what you already did.\n\n` +
      `If you cannot finish it, run \`office escalate\` with what is in the way ` +
      `instead of leaving it half-done.`
    );
  }

  /** Read and consume the marker the agent drops when it calls `office done`. */
  private async takeDoneMarker(task: Task): Promise<string | null> {
    const dir = this.office.paths.agent(task.assignee);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.startsWith("done-") && f.endsWith(".json"));
    } catch {
      return null;
    }
    if (files.length === 0) return null;

    let summary: string | null = null;
    for (const file of files) {
      const path = join(dir, file);
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { summary?: string; taskId?: string };
        if (parsed.taskId && parsed.taskId !== task.id) continue;
        summary = parsed.summary ?? "done";
      } catch {
        summary = "done";
      }
      await rm(path, { force: true });
    }
    return summary;
  }
}
