import type { Provider, Tier } from "../types.js";
import type { OfficeConfig } from "../config.js";
import type { Driver, TurnRequest, TurnResult } from "./types.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";

export type { Driver, TurnRequest, TurnResult } from "./types.js";
export { ClaudeDriver, parseClaudeResult, permissionModeFor } from "./claude.js";
export { CodexDriver, parseCodexStream } from "./codex.js";

/** Resolve a tier to a model name, or undefined to take the CLI's default. */
export function modelFor(config: OfficeConfig, provider: Provider, tier: Tier): string | undefined {
  return config.providers[provider].models[tier];
}

export function driverFor(config: OfficeConfig, provider: Provider): Driver {
  const bin = config.providers[provider].bin;
  return provider === "codex" ? new CodexDriver(bin) : new ClaudeDriver(bin);
}

/** Deterministic stand-in so the floor can be exercised without spending a token. */
export class FakeDriver implements Driver {
  readonly name = "fake" as const;
  readonly calls: TurnRequest[] = [];

  constructor(private readonly reply: (req: TurnRequest, n: number) => Partial<TurnResult> | Promise<Partial<TurnResult>> = () => ({})) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    this.calls.push(req);
    const override = await this.reply(req, this.calls.length);
    return {
      ok: true,
      text: `[fake ${req.agent}] ${req.prompt.slice(0, 120)}`,
      sessionId: req.sessionId ?? `fake-session-${req.agent}`,
      model: req.model ?? "fake-model",
      costUsd: 0.01,
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 500,
      durationMs: 10, turns: 1,
      ...override,
    };
  }
}
