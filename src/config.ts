import { readJson, writeJsonAtomic } from "./util.js";
import type { Autonomy, Tier } from "./types.js";
import { TIERS } from "./types.js";

export type Plan = "pro" | "max5x" | "max20x" | "api";

export interface BudgetConfig {
  /**
   * Hard cap on agents running a CLI turn at the same time.
   *
   * This is the single most important number in this file. Every agent
   * authenticates as the same subscription, so N agents do not get N budgets --
   * they share one, N times faster.
   */
  maxConcurrentAgents: number;
  /** Length of the rolling window the ledger scores against, in hours. */
  windowHours: number;
  /**
   * Your cap on tokens burned per rolling window, and per week.
   *
   * These are NOT Anthropic's published quotas -- Anthropic does not publish
   * exact token numbers for subscription plans. They are your own governor.
   * Run the office for a week, then `office budget --calibrate` to replace the
   * guesses with what your plan actually tolerated.
   */
  windowTokenBudget: number;
  weeklyTokenBudget: number;
  /** Fraction of budget at which the scheduler starts demoting tiers. */
  softStopPct: number;
  /** A single task whose notional cost exceeds this raises an escalation. */
  escalateAboveUsdPerTask: number;
}

export interface OfficeConfig {
  /** Path to the git repo the office works in, relative to the office root. */
  repo: string;
  plan: Plan;
  budget: BudgetConfig;
  defaults: {
    tier: Tier;
    autonomy: Autonomy;
    /** Wall-clock cap on one CLI turn. There is no --max-turns in the CLI. */
    turnTimeoutMs: number;
  };
  /** "claude" runs the real CLI. "fake" is for tests and dry runs. */
  driver: "claude" | "fake";
  /** Which agent receives briefs and splits them up. */
  orchestrator: string;
}

/**
 * Starting points, scaled off the published plan multiples (Pro 1x, Max 5x,
 * Max 20x). Treat every number here as a hypothesis to be measured, not a
 * quota to be trusted.
 */
const PLAN_PRESETS: Record<Plan, Pick<BudgetConfig, "maxConcurrentAgents" | "windowTokenBudget" | "weeklyTokenBudget">> = {
  pro:    { maxConcurrentAgents: 1, windowTokenBudget: 1_500_000,  weeklyTokenBudget: 20_000_000 },
  max5x:  { maxConcurrentAgents: 2, windowTokenBudget: 7_500_000,  weeklyTokenBudget: 100_000_000 },
  max20x: { maxConcurrentAgents: 4, windowTokenBudget: 30_000_000, weeklyTokenBudget: 400_000_000 },
  api:    { maxConcurrentAgents: 6, windowTokenBudget: Number.MAX_SAFE_INTEGER, weeklyTokenBudget: Number.MAX_SAFE_INTEGER },
};

export function defaultConfig(plan: Plan = "max5x"): OfficeConfig {
  const preset = PLAN_PRESETS[plan];
  return {
    repo: ".",
    plan,
    budget: {
      ...preset,
      windowHours: 5,
      softStopPct: 0.8,
      escalateAboveUsdPerTask: 2,
    },
    defaults: { tier: "sonnet", autonomy: "scoped", turnTimeoutMs: 15 * 60_000 },
    driver: "claude",
    orchestrator: "michelle",
  };
}

export async function loadConfig(path: string, plan: Plan = "max5x"): Promise<OfficeConfig> {
  const raw = await readJson<Partial<OfficeConfig> | null>(path, null);
  if (!raw) return defaultConfig(plan);
  return validateConfig({ ...defaultConfig(raw.plan ?? plan), ...raw, budget: { ...defaultConfig(raw.plan ?? plan).budget, ...raw.budget } });
}

export async function saveConfig(path: string, config: OfficeConfig): Promise<void> {
  await writeJsonAtomic(path, validateConfig(config));
}

export function validateConfig(config: OfficeConfig): OfficeConfig {
  const b = config.budget;
  if (!Number.isInteger(b.maxConcurrentAgents) || b.maxConcurrentAgents < 1) {
    throw new Error(`budget.maxConcurrentAgents must be a positive integer, got ${b.maxConcurrentAgents}`);
  }
  if (b.windowHours <= 0) throw new Error("budget.windowHours must be > 0");
  if (b.softStopPct <= 0 || b.softStopPct > 1) throw new Error("budget.softStopPct must be in (0, 1]");
  if (b.windowTokenBudget <= 0 || b.weeklyTokenBudget <= 0) throw new Error("token budgets must be > 0");
  if (!TIERS.includes(config.defaults.tier)) throw new Error(`unknown default tier ${config.defaults.tier}`);
  if (config.defaults.turnTimeoutMs < 1000) throw new Error("defaults.turnTimeoutMs must be at least 1000");
  if (!config.orchestrator.trim()) throw new Error("orchestrator must name an agent");
  return config;
}
