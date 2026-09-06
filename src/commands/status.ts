import type { Office } from "../office.js";
import type { Provider } from "../types.js";
import { enabledProviders } from "../config.js";
import { bar, bold, dim, green, red, statusGlyph, table, yellow, pct } from "./format.js";

/** The floor at a glance: who is on what, and how much of each pool is left. */
export async function floor(office: Office): Promise<string> {
  const rows: string[][] = [[dim("  agent"), dim("role"), dim("on"), dim("tier"), dim("status"), dim("task")]];
  const tasks = await office.tasks();

  for (const id of office.agentIds()) {
    const role = office.role(id);
    const state = await office.state(id);
    const current = tasks.find((t) => t.assignee === id && (t.state === "running" || t.state === "assigned"));
    const tier = state.tierOverride && state.tierOverride !== role.tier
      ? `${yellow(state.tierOverride)} ${dim(`(was ${role.tier})`)}`
      : role.tier;
    const note = state.breakerStage > 0 ? red(` breaker:${state.breakerStage}`) : "";
    const provider = office.config.providers[role.provider].enabled ? role.provider : red(`${role.provider} off`);
    rows.push([
      `${statusGlyph(state.status)} ${bold(id)}`,
      role.title,
      provider,
      tier,
      state.status + note,
      current ? current.title : dim("--"),
    ]);
  }

  const parts = [
    bold(`The floor  ${dim(`(${describeFleet(office)})`)}`),
    "",
    table(rows),
    "",
    await budgetBlock(office),
  ];

  const open = (await office.escalations.list({ openOnly: true })).length;
  if (open > 0) parts.push("", yellow(`  ${open} decision(s) waiting on you -- office approvals`));
  return parts.join("\n");
}

function describeFleet(office: Office): string {
  return enabledProviders(office.config)
    .map((p) => `${p} x${office.config.providers[p].maxConcurrentAgents}`)
    .join(", ") || "no providers enabled";
}

async function budgetBlock(office: Office): Promise<string> {
  const lines = [bold("Budget"), dim("  Separate pools. A spent one stops its own desks, not the floor.")];

  for (const provider of enabledProviders(office.config)) {
    const b = office.config.providers[provider];
    const [window, week] = await Promise.all([
      office.ledger.windowUsage(provider),
      office.ledger.weeklyUsage(provider),
    ]);
    const wf = window.weightedTokens / b.windowTokenBudget;
    const kf = week.weightedTokens / b.weeklyTokenBudget;

    lines.push(
      "",
      `  ${bold(provider)} ${dim(`max ${b.maxConcurrentAgents} at once`)}`,
      `    ${`${b.windowHours}h window`.padEnd(11)}${bar(wf)} ${pct(wf).padStart(4)}  ${dim(`${fmt(window.weightedTokens)} of ${fmt(b.windowTokenBudget)}`)}`,
      `    ${"this week".padEnd(11)}${bar(kf)} ${pct(kf).padStart(4)}  ${dim(`${fmt(week.weightedTokens)} of ${fmt(b.weeklyTokenBudget)}`)}`,
      `    ${dim(`${week.turns} turns this week${week.costUsd > 0 ? ` · notional $${week.costUsd.toFixed(2)}` : ""}`)}`,
    );
    if (wf >= b.softStopPct) lines.push(yellow(`    Past the soft stop: new ${provider} turns run a tier down.`));
  }
  return lines.join("\n");
}

export async function roster(office: Office): Promise<string> {
  if (office.agentIds().length === 0) return dim("Nobody on the floor yet. Run `office init` or `office hire <name>`.");
  const rows: string[][] = [[dim("agent"), dim("title"), dim("provider"), dim("tier"), dim("autonomy"), dim("scope")]];
  for (const id of office.agentIds()) {
    const role = office.role(id);
    const enabled = office.config.providers[role.provider].enabled;
    rows.push([
      bold(id),
      role.title,
      enabled ? role.provider : red(`${role.provider} (disabled)`),
      role.tier,
      role.autonomy === "trusted" ? yellow(role.autonomy) : role.autonomy,
      role.scope.length ? role.scope.join(" ") : yellow("everything"),
    ]);
  }
  return table(rows);
}

export async function providers(office: Office): Promise<string> {
  const rows: string[][] = [[dim("provider"), dim("state"), dim("bin"), dim("max"), dim("models")]];
  for (const provider of ["claude", "codex"] as Provider[]) {
    const p = office.config.providers[provider];
    const models = Object.entries(p.models).map(([t, m]) => `${t}=${m}`).join(" ") || dim("CLI default");
    rows.push([
      bold(provider),
      p.enabled ? green("enabled") : dim("disabled"),
      p.bin,
      String(p.maxConcurrentAgents),
      models,
    ]);
  }
  return [
    table(rows),
    "",
    dim("  Each provider is a separate subscription and a separate allowance."),
    dim("  Enabling one does not divide the other -- that is the point of having two."),
    dim("  Set models per tier in office.config.json if your plan names them differently."),
  ].join("\n");
}

export async function budget(office: Office, calibrate: boolean): Promise<string> {
  const lines = [await budgetBlock(office), "",
    dim("  Weighted tokens count cache reads at 0.1x, since they cost roughly a tenth"),
    dim("  of fresh input. Notional spend is what a CLI reports the turn would have"),
    dim("  cost on the API; on a subscription you are not billed it, and Codex does"),
    dim("  not report one at all."),
  ];

  if (!calibrate) {
    lines.push("", dim("  Run `office budget --calibrate` after a week to replace the shipped"), dim("  guesses with numbers measured from your own ledger."));
    return lines.join("\n");
  }

  lines.push("", bold("Calibration"));
  for (const cal of await office.ledger.calibrateAll()) {
    if (!office.config.providers[cal.provider].enabled) continue;
    lines.push("", `  ${bold(cal.provider)}`);
    if (cal.samples === 0) {
      lines.push(dim("    No turns recorded yet."));
      continue;
    }
    const b = office.config.providers[cal.provider];
    lines.push(
      `    turns observed        ${cal.samples}`,
      `    busiest ${b.windowHours}h window   ${fmt(cal.peakWindow)}`,
      `    suggested window      ${green(fmt(cal.suggestedWindow))}  ${dim("(peak + 15%)")}`,
      `    suggested weekly      ${green(fmt(cal.suggestedWeekly))}`,
    );
  }
  lines.push(
    "",
    dim("  These describe what your plans tolerated, not quotas either vendor"),
    dim("  publishes. If you were never throttled, the real ceiling is higher than"),
    dim("  the peak you measured -- raise it one step at a time."),
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
