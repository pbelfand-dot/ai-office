import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEntry, Tier } from "../types.js";
import { TIERS } from "../types.js";
import type { BudgetConfig } from "../config.js";

export interface Usage {
  weightedTokens: number;
  costUsd: number;
  turns: number;
  since: string;
}

export interface Verdict {
  allow: boolean;
  /** The tier the agent may actually run at, after demotion. */
  tier: Tier;
  reason: string;
  windowPct: number;
  weeklyPct: number;
}

/**
 * Cache reads are roughly a tenth the price of fresh input, so counting them
 * one-for-one would make a well-cached agent look twice as expensive as it is
 * and throttle exactly the behaviour you want to encourage.
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

/**
 * The governor.
 *
 * Every agent on the floor authenticates as the same subscription, so the
 * floor has one budget, not one per desk. Adding agents does not add capacity;
 * it spends the same capacity faster and in parallel. This class is the only
 * thing standing between "nine agents" and "nine agents that all stop at
 * 11am on a Tuesday".
 */
export class Ledger {
  private cache: LedgerEntry[] | null = null;

  constructor(private readonly path: string, private readonly budget: BudgetConfig) {}

  async record(entry: LedgerEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    if (this.cache) this.cache.push(entry);
  }

  async entries(): Promise<LedgerEntry[]> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return (this.cache = []);
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
    return (this.cache = out);
  }

  async usageSince(sinceMs: number, now = Date.now()): Promise<Usage> {
    const cutoff = now - sinceMs;
    const rows = (await this.entries()).filter((e) => Date.parse(e.at) >= cutoff);
    return {
      weightedTokens: rows.reduce((sum, e) => sum + weigh(e), 0),
      costUsd: rows.reduce((sum, e) => sum + e.costUsd, 0),
      turns: rows.length,
      since: new Date(cutoff).toISOString(),
    };
  }

  windowUsage(now = Date.now()): Promise<Usage> {
    return this.usageSince(this.budget.windowHours * 3_600_000, now);
  }

  weeklyUsage(now = Date.now()): Promise<Usage> {
    return this.usageSince(7 * 24 * 3_600_000, now);
  }

  /**
   * Decide whether a turn may run, and at what tier.
   *
   * Below the soft stop everything runs as asked. Between the soft stop and
   * the cap, work continues but drops a tier -- a demoted agent that finishes
   * beats a premium agent that gets cut off mid-refactor. At the cap, nothing
   * starts, because the alternative is discovering the wall by hitting it.
   */
  async check(requested: Tier, now = Date.now()): Promise<Verdict> {
    const [window, week] = await Promise.all([this.windowUsage(now), this.weeklyUsage(now)]);
    const windowPct = window.weightedTokens / this.budget.windowTokenBudget;
    const weeklyPct = week.weightedTokens / this.budget.weeklyTokenBudget;
    const worst = Math.max(windowPct, weeklyPct);

    if (worst >= 1) {
      const which = windowPct >= weeklyPct ? `${this.budget.windowHours}h window` : "week";
      return { allow: false, tier: requested, reason: `budget spent for this ${which} (${pct(worst)})`, windowPct, weeklyPct };
    }

    if (worst >= this.budget.softStopPct) {
      const demoted = demote(requested);
      return {
        allow: true,
        tier: demoted,
        reason: demoted === requested
          ? `at ${pct(worst)} of budget, already on the cheapest tier`
          : `at ${pct(worst)} of budget, running ${requested} work on ${demoted}`,
        windowPct,
        weeklyPct,
      };
    }

    return { allow: true, tier: requested, reason: `${pct(worst)} of budget used`, windowPct, weeklyPct };
  }

  /**
   * Turn a week of observation into budget numbers you can defend.
   *
   * The shipped defaults are extrapolations from the published plan multiples,
   * not quotas Anthropic publishes. After a week of real turns, the busiest
   * window you actually completed is a far better cap than any guess.
   */
  async calibrate(now = Date.now()): Promise<{ suggestedWindow: number; suggestedWeekly: number; samples: number; peakWindow: number }> {
    const rows = await this.entries();
    if (rows.length === 0) return { suggestedWindow: this.budget.windowTokenBudget, suggestedWeekly: this.budget.weeklyTokenBudget, samples: 0, peakWindow: 0 };

    const windowMs = this.budget.windowHours * 3_600_000;
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

    const week = await this.weeklyUsage(now);
    return {
      // 15% of headroom over the busiest window you survived, rounded to something legible.
      suggestedWindow: Math.round((peak * 1.15) / 100_000) * 100_000 || this.budget.windowTokenBudget,
      suggestedWeekly: Math.round((week.weightedTokens * 1.15) / 1_000_000) * 1_000_000 || this.budget.weeklyTokenBudget,
      samples: rows.length,
      peakWindow: peak,
    };
  }
}

export function demote(tier: Tier): Tier {
  const i = TIERS.indexOf(tier);
  return (TIERS[Math.max(0, i - 1)] ?? tier) as Tier;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
