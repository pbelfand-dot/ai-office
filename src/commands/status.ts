import type { Office } from "../office.js";
import { bar, bold, dim, green, red, statusGlyph, table, yellow, pct } from "./format.js";

/** The floor at a glance: who is on what, and how much budget is left. */
export async function floor(office: Office): Promise<string> {
  const rows: string[][] = [[dim("  agent"), dim("role"), dim("tier"), dim("status"), dim("on")]];
  const tasks = await office.tasks();

  for (const id of office.agentIds()) {
    const role = office.role(id);
    const state = await office.state(id);
    const current = tasks.find((t) => t.assignee === id && (t.state === "running" || t.state === "assigned"));
    const tier = state.tierOverride && state.tierOverride !== role.tier
      ? `${yellow(state.tierOverride)} ${dim(`(was ${role.tier})`)}`
      : role.tier;
    const note = state.breakerStage > 0 ? red(` breaker:${state.breakerStage}`) : "";
    rows.push([
      `${statusGlyph(state.status)} ${bold(id)}`,
      role.title,
      tier,
      state.status + note,
      current ? current.title : dim("--"),
    ]);
  }

  const [window, week] = await Promise.all([office.ledger.windowUsage(), office.ledger.weeklyUsage()]);
  const b = office.config.budget;
  const windowFrac = window.weightedTokens / b.windowTokenBudget;
  const weekFrac = week.weightedTokens / b.weeklyTokenBudget;
  const open = (await office.escalations.list({ openOnly: true })).length;

  const parts = [
    bold(`The floor  ${dim(`(${office.config.plan}, max ${b.maxConcurrentAgents} at once)`)}`),
    "",
    table(rows),
    "",
    bold("Budget"),
    `  ${`${b.windowHours}h window`.padEnd(11)}${bar(windowFrac)} ${pct(windowFrac).padStart(4)}  ${dim(`${fmt(window.weightedTokens)} of ${fmt(b.windowTokenBudget)} weighted tokens`)}`,
    `  ${"this week".padEnd(11)}${bar(weekFrac)} ${pct(weekFrac).padStart(4)}  ${dim(`${fmt(week.weightedTokens)} of ${fmt(b.weeklyTokenBudget)}`)}`,
    `  ${dim(`notional spend: $${week.costUsd.toFixed(2)} this week across ${week.turns} turns (subscription, not billed)`)}`,
  ];

  if (open > 0) parts.push("", yellow(`  ${open} decision(s) waiting on you -- office approvals`));
  if (windowFrac >= b.softStopPct) {
    parts.push("", yellow(`  Past the soft stop. New turns run a tier down until the window rolls over.`));
  }
  return parts.join("\n");
}

export async function roster(office: Office): Promise<string> {
  if (office.agentIds().length === 0) return dim("Nobody on the floor yet. Run `office init` or `office hire <name>`.");
  const rows: string[][] = [[dim("agent"), dim("title"), dim("tier"), dim("autonomy"), dim("scope")]];
  for (const id of office.agentIds()) {
    const role = office.role(id);
    rows.push([
      bold(id),
      role.title,
      role.tier,
      role.autonomy === "trusted" ? yellow(role.autonomy) : role.autonomy,
      role.scope.length ? role.scope.join(" ") : yellow("everything"),
    ]);
  }
  return table(rows);
}

export async function budget(office: Office, calibrate: boolean): Promise<string> {
  const b = office.config.budget;
  const [window, week, cal] = await Promise.all([
    office.ledger.windowUsage(),
    office.ledger.weeklyUsage(),
    office.ledger.calibrate(),
  ]);

  const lines = [
    bold("Budget"),
    `  plan            ${office.config.plan}`,
    `  concurrency     ${b.maxConcurrentAgents} agent(s) at once`,
    `  ${b.windowHours}h window       ${fmt(window.weightedTokens)} / ${fmt(b.windowTokenBudget)}  ${pct(window.weightedTokens / b.windowTokenBudget)}`,
    `  this week       ${fmt(week.weightedTokens)} / ${fmt(b.weeklyTokenBudget)}  ${pct(week.weightedTokens / b.weeklyTokenBudget)}`,
    `  turns this week ${week.turns}`,
    `  notional spend  $${week.costUsd.toFixed(2)}`,
    "",
    dim("  Weighted tokens count cache reads at 0.1x, since they cost roughly a tenth"),
    dim("  of fresh input. Notional spend is what the CLI reports a turn would have"),
    dim("  cost on the API; on a subscription you are not billed it."),
  ];

  if (!calibrate) {
    lines.push("", dim("  Run `office budget --calibrate` after a week to replace the shipped"), dim("  guesses with numbers measured from your own ledger."));
    return lines.join("\n");
  }

  lines.push("", bold("Calibration"));
  if (cal.samples === 0) {
    lines.push(dim("  No turns recorded yet. Come back after the floor has done some work."));
    return lines.join("\n");
  }
  lines.push(
    `  turns observed        ${cal.samples}`,
    `  busiest ${b.windowHours}h window   ${fmt(cal.peakWindow)} weighted tokens`,
    "",
    `  suggested windowTokenBudget  ${green(fmt(cal.suggestedWindow))}  ${dim("(peak + 15%)")}`,
    `  suggested weeklyTokenBudget  ${green(fmt(cal.suggestedWeekly))}`,
    "",
    dim("  These describe what your plan tolerated, not a quota Anthropic publishes."),
    dim("  If you were never throttled, the real ceiling is higher than the peak you"),
    dim("  measured -- raise it deliberately, one step at a time."),
    "",
    dim("  Edit office.config.json to apply."),
  );
  return lines.join("\n");
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}
