import { readJson, writeJsonAtomic } from "./util.js";
import type { Autonomy, Provider, Tier } from "./types.js";
import { PROVIDERS, TIERS } from "./types.js";

export type Plan = "pro" | "max5x" | "max20x" | "api";
export type CodexPlan = "none" | "go" | "plus" | "pro" | "api";

export interface ProviderConfig {
  /** A disabled provider is invisible to the scheduler; its desks never run. */
  enabled: boolean;
  /** The executable to spawn. Override if it is not on PATH under this name. */
  bin: string;
  /**
   * Tier to model name. Left empty means "pass no model flag and take the
   * CLI's default", which is the honest setting for a provider whose model
   * names you have not confirmed against your own account.
   */
  models: Partial<Record<Tier, string>>;
  /**
   * Agents from THIS provider that may run at once.
   *
   * Per provider, not global, because that is the entire point: when the Claude
   * pool is spent, the Codex desks are not.
   */
  maxConcurrentAgents: number;
  windowHours: number;
  /**
   * Your caps, not the vendor's. Neither Anthropic nor OpenAI publishes token
   * quotas for subscription plans, and both enforce an undisclosed weekly cap
   * on top of a rolling window. Run for a week, then `office budget
   * --calibrate` replaces these with what your plans actually tolerated.
   */
  windowTokenBudget: number;
  weeklyTokenBudget: number;
  /** Fraction of budget at which this provider's turns start running a tier down. */
  softStopPct: number;
  /** A single task whose notional cost exceeds this raises an escalation. */
  escalateAboveUsdPerTask: number;
}

export interface OfficeConfig {
  repo: string;
  /** Kept for the record: which plan the shipped defaults were scaled from. */
  plan: Plan;
  codexPlan: CodexPlan;
  providers: Record<Provider, ProviderConfig>;
  defaults: {
    provider: Provider;
    tier: Tier;
    autonomy: Autonomy;
    /** Wall-clock cap on one turn. Neither CLI has a usable max-turns flag. */
    turnTimeoutMs: number;
  };
  /** "real" spawns the CLIs. "fake" is for tests and dry runs. */
  driver: "real" | "fake";
  orchestrator: string;
  /** The hidden desk that decides who a chat message is for. */
  router: string;
  /**
   * A file at the repo root every desk reads before answering, copied into each
   * worktree so it counts even before you commit it. Empty means none.
   */
  brief?: string;
  chat: ChatConfig;
}

export interface ChatConfig {
  /** The channel `office chat` and the dashboard talk in by default. */
  channel: string;
  /**
   * Ceiling on a chat reply's tier, whatever the desk runs its work at.
   *
   * Chat spends the same allowance as the work does, and a floor that talks
   * all afternoon on the large tier is a floor with nothing left to build
   * with. Raise it when the budget can carry it.
   */
  maxTier: Tier;
  /** The router only picks names out of a roster; it never needs more. */
  routerTier: Tier;
  /** Chat should feel like chat: a much shorter leash than a work turn. */
  turnTimeoutMs: number;
  /** How much of the channel each reply and each routing decision sees. */
  historyDepth: number;
  /**
   * Turns the floor may spend working what the chat just assigned. 0 waits.
   *
   * Assigning work and then waiting to be told to do it is the difference
   * between staff and a suggestion box -- you ask, the desks answer, and then
   * nothing exists until you remember a second command. So the queue runs
   * itself, but on a leash: these are full work turns at full price, and the
   * ceiling is what stops one sentence from committing an afternoon of them.
   * The ledger and the gate still apply on top.
   */
  autoRun: number;
}

/** Scaled off the published plan multiples. Hypotheses, not quotas. */
const CLAUDE_PRESETS: Record<Plan, Pick<ProviderConfig, "maxConcurrentAgents" | "windowTokenBudget" | "weeklyTokenBudget">> = {
  pro:    { maxConcurrentAgents: 1, windowTokenBudget: 1_500_000,  weeklyTokenBudget: 20_000_000 },
  max5x:  { maxConcurrentAgents: 2, windowTokenBudget: 7_500_000,  weeklyTokenBudget: 100_000_000 },
  max20x: { maxConcurrentAgents: 4, windowTokenBudget: 30_000_000, weeklyTokenBudget: 400_000_000 },
  api:    { maxConcurrentAgents: 6, windowTokenBudget: Number.MAX_SAFE_INTEGER, weeklyTokenBudget: Number.MAX_SAFE_INTEGER },
};

const CODEX_PRESETS: Record<CodexPlan, Pick<ProviderConfig, "maxConcurrentAgents" | "windowTokenBudget" | "weeklyTokenBudget"> & { enabled: boolean }> = {
  none: { enabled: false, maxConcurrentAgents: 0, windowTokenBudget: 1, weeklyTokenBudget: 1 },
  go:   { enabled: true,  maxConcurrentAgents: 1, windowTokenBudget: 1_500_000, weeklyTokenBudget: 20_000_000 },
  plus: { enabled: true,  maxConcurrentAgents: 2, windowTokenBudget: 6_000_000, weeklyTokenBudget: 80_000_000 },
  pro:  { enabled: true,  maxConcurrentAgents: 4, windowTokenBudget: 30_000_000, weeklyTokenBudget: 400_000_000 },
  api:  { enabled: true,  maxConcurrentAgents: 6, windowTokenBudget: Number.MAX_SAFE_INTEGER, weeklyTokenBudget: Number.MAX_SAFE_INTEGER },
};

export function defaultConfig(plan: Plan = "max5x", codexPlan: CodexPlan = "none"): OfficeConfig {
  return {
    repo: ".",
    plan,
    codexPlan,
    providers: {
      claude: {
        ...CLAUDE_PRESETS[plan],
        enabled: true,
        bin: "claude",
        // Aliases the CLI resolves itself, so they survive a model release.
        models: { small: "haiku", mid: "sonnet", large: "opus" },
        windowHours: 5,
        softStopPct: 0.8,
        escalateAboveUsdPerTask: 2,
      },
      codex: {
        ...CODEX_PRESETS[codexPlan],
        bin: "codex",
        // Left empty on purpose: Codex model names are not guessed here. Set
        // them from `codex --help` on your own account, or leave it and take
        // whatever default your plan gives you.
        models: {},
        windowHours: 5,
        softStopPct: 0.8,
        escalateAboveUsdPerTask: 2,
      },
    },
    defaults: { provider: "claude", tier: "mid", autonomy: "scoped", turnTimeoutMs: 15 * 60_000 },
    driver: "real",
    orchestrator: "michelle",
    router: "switchboard",
    brief: "",
    chat: { channel: "floor", maxTier: "mid", routerTier: "small", turnTimeoutMs: 3 * 60_000, historyDepth: 14, autoRun: 3 },
  };
}

/** The shape written before the office knew about a second provider. */
interface LegacyConfig {
  plan?: Plan;
  driver?: string;
  budget?: Partial<ProviderConfig> & { maxConcurrentAgents?: number };
  defaults?: { tier?: string; autonomy?: Autonomy; turnTimeoutMs?: number };
}

export async function loadConfig(path: string, plan: Plan = "max5x"): Promise<OfficeConfig> {
  const raw = await readJson<(Partial<OfficeConfig> & LegacyConfig) | null>(path, null);
  if (!raw) return defaultConfig(plan);

  const base = defaultConfig(raw.plan ?? plan, raw.codexPlan ?? "none");
  const providers = { ...base.providers };
  for (const name of PROVIDERS) {
    providers[name] = { ...base.providers[name], ...raw.providers?.[name] };
  }

  // A config written before providers existed put one budget at the top level;
  // that budget was always Claude's, so that is where it lands.
  if (!raw.providers && raw.budget) {
    providers.claude = { ...providers.claude, ...raw.budget };
  }

  return validateConfig({
    ...base,
    ...raw,
    providers,
    defaults: { ...base.defaults, ...raw.defaults, tier: migrateTier(raw.defaults?.tier) ?? base.defaults.tier },
    chat: { ...base.chat, ...raw.chat },
    driver: raw.driver === "fake" ? "fake" : "real",
  });
}

/** Tiers used to be named after Anthropic's models. Old files still say so. */
export function migrateTier(tier: string | undefined): Tier | undefined {
  if (!tier) return undefined;
  const legacy: Record<string, Tier> = { haiku: "small", sonnet: "mid", opus: "large" };
  if (legacy[tier]) return legacy[tier];
  return TIERS.includes(tier as Tier) ? (tier as Tier) : undefined;
}

export async function saveConfig(path: string, config: OfficeConfig): Promise<void> {
  await writeJsonAtomic(path, validateConfig(config));
}

export function validateConfig(config: OfficeConfig): OfficeConfig {
  for (const name of PROVIDERS) {
    const p = config.providers[name];
    if (!p) throw new Error(`providers.${name} is missing`);
    if (!Number.isInteger(p.maxConcurrentAgents) || p.maxConcurrentAgents < 0) {
      throw new Error(`providers.${name}.maxConcurrentAgents must be a non-negative integer, got ${p.maxConcurrentAgents}`);
    }
    if (p.enabled && p.maxConcurrentAgents < 1) {
      throw new Error(`providers.${name} is enabled but allows 0 concurrent agents, so its desks would never run`);
    }
    if (p.windowHours <= 0) throw new Error(`providers.${name}.windowHours must be > 0`);
    if (p.softStopPct <= 0 || p.softStopPct > 1) throw new Error(`providers.${name}.softStopPct must be in (0, 1]`);
    if (p.windowTokenBudget <= 0 || p.weeklyTokenBudget <= 0) throw new Error(`providers.${name} token budgets must be > 0`);
    if (!p.bin.trim()) throw new Error(`providers.${name}.bin must name an executable`);
    for (const tier of Object.keys(p.models)) {
      if (!TIERS.includes(tier as Tier)) throw new Error(`providers.${name}.models has unknown tier "${tier}"`);
    }
  }

  if (!config.providers[config.defaults.provider].enabled) {
    throw new Error(`defaults.provider is "${config.defaults.provider}", which is disabled`);
  }
  if (!TIERS.includes(config.defaults.tier)) throw new Error(`unknown default tier ${config.defaults.tier}`);
  if (config.defaults.turnTimeoutMs < 1000) throw new Error("defaults.turnTimeoutMs must be at least 1000");
  if (!config.orchestrator.trim()) throw new Error("orchestrator must name an agent");
  if (!config.router.trim()) throw new Error("router must name an agent");
  if (!/^[\w.-]+$/.test(config.chat.channel)) throw new Error(`chat.channel must be a plain name, got "${config.chat.channel}"`);
  for (const tier of [config.chat.maxTier, config.chat.routerTier]) {
    if (!TIERS.includes(tier)) throw new Error(`unknown chat tier ${tier}`);
  }
  if (config.chat.turnTimeoutMs < 1000) throw new Error("chat.turnTimeoutMs must be at least 1000");
  if (config.chat.historyDepth < 1) throw new Error("chat.historyDepth must be at least 1");
  if (!Number.isInteger(config.chat.autoRun) || config.chat.autoRun < 0) {
    throw new Error(`chat.autoRun must be a turn ceiling of 0 or more, got ${config.chat.autoRun}`);
  }
  return config;
}

export function enabledProviders(config: OfficeConfig): Provider[] {
  return PROVIDERS.filter((p) => config.providers[p].enabled);
}
