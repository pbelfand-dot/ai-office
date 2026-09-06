import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEntry, Provider, Tier } from "../types.js";
import { PROVIDERS, TIERS } from "../types.js";
import type { OfficeConfig, ProviderConfig } from "../config.js";

export interface Usage {
  weightedTokens: number;
  costUsd: number;
  turns: number;
  since: string;
}

export interface Verdict {
  allow: boolean;
  /** The tier this provider may actually run at, after demotion. */
  tier: Tier;
  reason: string;
  windowPct: number;
  weeklyPct: number;
}

/**
 * Cache reads are roughly a tenth the price of fresh input on both providers,
 * so counting them one-for-one would make a well-cached agent look twice as
 * expensive as it is and throttle exactly the behaviour you want.
 */
const CACHE_READ_WEIGHT = 0.1;

export function weigh(entry: Pick<LedgerEntry, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">): number {
  return (
    entry.inputTokens +
    entry.outputTokens +
    entry.cacheCreationTokens +
    entry.cacheReadTokens * CACHE_READ_WEIGHT
  );
}

/** Rows written before the second provider existed were all Claude's. */
export const providerOf = (entry: LedgerEntry): Provider => entry.provider ?? "claude";

/**
 * The governor, one pool per provider.
 *
 * Every agent on a provider signs in as the same subscription, so that
 * provider has one budget however many desks draw on it. Agents on a
 * *different* provider draw on a different one, and that is the only way to add
 * concurrency without buying more of a single plan. So a spent Claude window
 * stops the Claude desks and leaves the Codex desks running -- which is the
 * whole reason the pools are separate rather than summed.
 */
export class Ledger {
  private cache: LedgerEntry[] | null = null;

  constructor(private readonly path: string, private readonly config: OfficeConfig) {}

  budgetFor(provider: Provider): ProviderConfig {
    return this.config.providers[provider];
  }

  async record(entry: LedgerEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    if (this.cache) this.cache.push(entry);
  }

  async entries(provider?: Provider): Promise<LedgerEntry[]> {
    if (!this.cache) this.cache = await this.read();
    return provider ? this.cache.filter((e) => providerOf(e) === provider) : this.cache;
  }

  private async read(): Promise<LedgerEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // A torn final line after a hard kill should not blind the governor.
      }
    }
    return out;
  }

  async usageSince(provider: Provider, sinceMs: number, now = Date.now()): Promise<Usage> {
    const cutoff = now - sinceMs;
    const rows = (await this.entries(provider)).filter((e) => Date.parse(e.at) >= cutoff);
    return {
      weightedTokens: rows.reduce((sum, e) => sum + weigh(e), 0),
      costUsd: rows.reduce((sum, e) => sum + e.costUsd, 0),
      turns: rows.length,
      since: new Date(cutoff).toISOString(),
    };
  }

  windowUsage(provider: Provider, now = Date.now()): Promise<Usage> {
    return this.usageSince(provider, this.budgetFor(provider).windowHours * 3_600_000, now);
  }

  weeklyUsage(provider: Provider, now = Date.now()): Promise<Usage> {
    return this.usageSince(provider, 7 * 24 * 3_600_000, now);
  }

  /**
   * Decide whether a turn on this provider may run, and at what tier.
   *
   * Below the soft stop everything runs as asked. Between the soft stop and the
   * cap, work continues but drops a tier -- a demoted agent that finishes beats
   * a premium agent cut off mid-refactor. At the cap, nothing on that provider
   * starts, because the alternative is discovering the wall by hitting it.
   */
  async check(provider: Provider, requested: Tier, now = Date.now()): Promise<Verdict> {
    const budget = this.budgetFor(provider);
    if (!budget.enabled) {
      return { allow: false, tier: requested, reason: `the ${provider} provider is disabled in office.config.json`, windowPct: 0, weeklyPct: 0 };
    }

    const [window, week] = await Promise.all([this.windowUsage(provider, now), this.weeklyUsage(provider, now)]);
    const windowPct = window.weightedTokens / budget.windowTokenBudget;
    const weeklyPct = week.weightedTokens / budget.weeklyTokenBudget;
    const worst = Math.max(windowPct, weeklyPct);

    if (worst >= 1) {
      const which = windowPct >= weeklyPct ? `${budget.windowHours}h window` : "week";
      return { allow: false, tier: requested, reason: `${provider} budget spent for this ${which} (${pct(worst)})`, windowPct, weeklyPct };
    }

    if (worst >= budget.softStopPct) {
      const demoted = demote(requested);
      return {
        allow: true,
        tier: demoted,
        reason: demoted === requested
          ? `${provider} at ${pct(worst)} of budget, already on the cheapest tier`
          : `${provider} at ${pct(worst)} of budget, running ${requested} work on ${demoted}`,
        windowPct,
        weeklyPct,
      };
    }

    return { allow: true, tier: requested, reason: `${provider} at ${pct(worst)} of budget`, windowPct, weeklyPct };
  }

  /**
   * Turn a week of observation into budget numbers you can defend.
   *
   * The shipped defaults are extrapolations from published plan multiples, not
   * quotas either vendor publishes. After a week of real turns, the busiest
   * window you actually completed is a far better cap than any guess.
   */
  async calibrate(provider: Provider, now = Date.now()): Promise<{ provider: Provider; suggestedWindow: number; suggestedWeekly: number; samples: number; peakWindow: number }> {
    const budget = this.budgetFor(provider);
    const rows = await this.entries(provider);
    if (rows.length === 0) {
      return { provider, suggestedWindow: budget.windowTokenBudget, suggestedWeekly: budget.weeklyTokenBudget, samples: 0, peakWindow: 0 };
    }

    const windowMs = budget.windowHours * 3_600_000;
    const sorted = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let peak = 0;
    let start = 0;
    let running = 0;
    for (let end = 0; end < sorted.length; end++) {
      running += weigh(sorted[end] as LedgerEntry);
      while (Date.parse((sorted[end] as LedgerEntry).at) - Date.parse((sorted[start] as LedgerEntry).at) > windowMs) {
        running -= weigh(sorted[start] as LedgerEntry);
        start++;
      }
      peak = Math.max(peak, running);
    }

    const week = await this.weeklyUsage(provider, now);
    return {
      provider,
      // 15% of headroom over the busiest window you survived.
      suggestedWindow: Math.round((peak * 1.15) / 100_000) * 100_000 || budget.windowTokenBudget,
      suggestedWeekly: Math.round((week.weightedTokens * 1.15) / 1_000_000) * 1_000_000 || budget.weeklyTokenBudget,
      samples: rows.length,
      peakWindow: peak,
    };
  }

  calibrateAll(now = Date.now()) {
    return Promise.all(PROVIDERS.map((p) => this.calibrate(p, now)));
  }
}

export function demote(tier: Tier): Tier {
  const i = TIERS.indexOf(tier);
  return (TIERS[Math.max(0, i - 1)] ?? tier) as Tier;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
