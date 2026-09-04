import { readdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../util.js";
import type { Office } from "../office.js";
import type { Task } from "../types.js";
import { runTurn, type TurnOutcome } from "./turn.js";

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

      const batch = runnable.slice(0, this.office.config.budget.maxConcurrentAgents);
      const outcomes = await Promise.all(batch.map((task) => this.runOne(task, maxAttempts, emit)));
      summary.turns += outcomes.filter((o) => o.ran).length;

      for (const outcome of outcomes) {
        if (outcome.completed) summary.completed.push(outcome.task.id);
        if (outcome.task.state === "blocked") summary.blocked.push(outcome.task.id);
        if (outcome.task.state === "failed") summary.failed.push(outcome.task.id);
      }

      const budgetStop = outcomes.find((o) => !o.ran && o.blockedBy?.includes("budget"));
      if (budgetStop) {
        summary.stoppedBecause = budgetStop.blockedBy as string;
        emit({ type: "budget", message: summary.stoppedBecause });
        break;
      }
      if (outcomes.every((o) => !o.ran)) {
        summary.stoppedBecause = outcomes[0]?.blockedBy ?? "every runnable task is blocked";
        emit({ type: "stalled", message: summary.stoppedBecause });
        break;
      }
    }

    if (summary.turns >= maxTurns) summary.stoppedBecause = `hit the ${maxTurns}-turn ceiling for this run`;
    return summary;
  }

  private async runOne(task: Task, maxAttempts: number, emit: (e: SchedulerEvent) => void): Promise<{ task: Task; ran: boolean; completed: boolean; blockedBy?: string } & Partial<TurnOutcome>> {
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

    const marker = await this.takeDoneMarker(task);
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
      if (state.status === "parked") reasons.add(`${task.assignee} is parked by the breaker`);
      else if (state.status === "blocked") reasons.add(`${task.assignee} is waiting on an approval`);
      else if (task.dependsOn.length) reasons.add(`${task.id} waits on ${task.dependsOn.join(", ")}`);
    }
    return [...reasons].join("; ") || "unclear";
  }

  private instructionFor(task: Task): string {
    return (
      `${task.instruction}\n\n` +
      `When this task is finished, run:\n\n` +
      `    office done "<one sentence on what you changed and why>"\n\n` +
      `The office does not consider the task complete until you do. If you cannot ` +
      `finish it, run \`office escalate\` with what is in the way instead of ` +
      `leaving it half-done.`
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
