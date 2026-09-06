import type { Autonomy, Provider, Tier } from "../types.js";

export interface TurnRequest {
  agent: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  tier: Tier;
  autonomy: Autonomy;
  /** Resume this session so the agent keeps one continuous thread. */
  sessionId?: string;
  allowedTools: string[];
  disallowedTools: string[];
  timeoutMs: number;
  /** Extra directories the agent may read, e.g. its own mailbox. */
  addDirs: string[];
  /** Extra env, e.g. OFFICE_AGENT so `office mail` knows who is calling. */
  env?: Record<string, string>;
  /** Resolved model name, or undefined to take the CLI's own default. */
  model?: string;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  turns: number;
  error?: string;
}

export interface Driver {
  readonly name: Provider | "fake";
  run(req: TurnRequest): Promise<TurnResult>;
}

export function failed(error: string, sessionId: string, model: string, durationMs: number): TurnResult {
  return {
    ok: false, text: "", sessionId, model, costUsd: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    durationMs, turns: 0, error,
  };
}
