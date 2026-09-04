import type { Office } from "../office.js";
import { plan } from "../orchestrator/planner.js";
import { Scheduler, type SchedulerEvent } from "../orchestrator/scheduler.js";
import { bold, dim, green, red, table, yellow } from "./format.js";
import { runTurn } from "../orchestrator/turn.js";

export async function brief(office: Office, text: string, opts: { run: boolean; maxTurns: number }): Promise<string> {
  if (text.trim().length < 20) {
    throw new Error(
      "That brief is too short to split well. Say what should change, where, and what " +
      "done looks like -- a vague brief is how you end up paying four agents to " +
      "improve four different things.",
    );
  }

  const lines: string[] = [dim("Michelle is splitting the brief...")];
  const { brief: created, tasks } = await plan(office, text);

  const existing = await office.tasks();
  await office.saveTasks([...existing, ...tasks]);
  await office.saveBriefs([...(await office.briefs()), created]);

  lines.push("", bold(`${tasks.length} task(s)`), table([
    [dim("id"), dim("assignee"), dim("title"), dim("after")],
    ...tasks.map((t) => [
      t.id,
      bold(t.assignee),
      t.title,
      t.dependsOn.length ? t.dependsOn.join(", ") : dim("--"),
    ]),
  ]));

  if (!opts.run) {
    lines.push("", dim("Review the split, then run `office run`. Nothing has been executed yet."));
    return lines.join("\n");
  }

  lines.push("");
  lines.push(await run(office, { maxTurns: opts.maxTurns }));
  return lines.join("\n");
}

export async function run(office: Office, opts: { maxTurns: number }): Promise<string> {
  const lines: string[] = [];
  const scheduler = new Scheduler(office);

  const onEvent = (event: SchedulerEvent) => {
    const prefix = { turn: dim("  ->"), done: green("  ok"), blocked: yellow("  !!"), stalled: yellow("  --"), budget: red("  $$"), start: dim("  ..") }[event.type];
    const line = `${prefix} ${event.message}`;
    lines.push(line);
    if (process.stdout.isTTY) process.stdout.write(`${line}\n`);
  };

  const summary = await scheduler.run({ maxTurns: opts.maxTurns, onEvent });

  const tail = [
    "",
    bold("Run finished"),
    `  turns      ${summary.turns}`,
    `  completed  ${summary.completed.length ? green(String(summary.completed.length)) : "0"}`,
    `  blocked    ${summary.blocked.length ? yellow(String(summary.blocked.length)) : "0"}`,
    `  failed     ${summary.failed.length ? red(String(summary.failed.length)) : "0"}`,
    `  stopped    ${summary.stoppedBecause}`,
  ];

  const open = await office.escalations.list({ openOnly: true });
  if (open.length) tail.push("", yellow(`  ${open.length} decision(s) waiting -- office approvals`));

  return [...(process.stdout.isTTY ? [] : lines), ...tail].join("\n");
}

/** Hand one instruction straight to one agent, bypassing the planner. */
export async function ask(office: Office, agent: string, instruction: string): Promise<string> {
  const outcome = await runTurn(office, agent, null, instruction);
  if (!outcome.ran) return yellow(`${agent} did not run: ${outcome.blockedBy}`);

  const parts = [outcome.result?.text ?? ""];
  if (outcome.touchedFiles.length) {
    parts.push("", dim(`touched: ${outcome.touchedFiles.join(", ")}`));
  }
  if (outcome.escalationId) {
    parts.push("", yellow(`held for review (${outcome.escalationId}): ${outcome.blockedBy}`));
  }
  if (outcome.breakerStage >= 2) {
    parts.push("", red(`circuit breaker at stage ${outcome.breakerStage}`));
  }
  return parts.join("\n");
}

export async function tasks(office: Office, opts: { all: boolean }): Promise<string> {
  const all = await office.tasks();
  const shown = opts.all ? all : all.filter((t) => t.state !== "done");
  if (shown.length === 0) return dim(opts.all ? "No tasks yet." : "Nothing outstanding. Pass --all to see finished work.");

  const paint = (state: string) =>
    state === "done" ? green(state) : state === "failed" ? red(state) : state === "blocked" ? yellow(state) : state;

  return table([
    [dim("id"), dim("state"), dim("assignee"), dim("title"), dim("turns")],
    ...shown.map((t) => [t.id, paint(t.state), t.assignee, t.title, String(t.attempts)]),
  ]);
}
