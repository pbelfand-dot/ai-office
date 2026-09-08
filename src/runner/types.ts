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
  /**
   * The turn died because the session it was told to resume is gone or was
   * never valid. The caller should forget the id rather than retry it: every
   * later turn would fail the same way, and a desk that can never start a turn
   * is indistinguishable from a broken one.
   */
  sessionLost?: boolean;
}

export interface Driver {
  readonly name: Provider | "fake";
  run(req: TurnRequest): Promise<TurnResult>;
}

/**
 * Why the CLI would not start, said in a way you can act on.
 *
 * ENOENT is almost never "you have no CLI". It is usually a shell alias or a
 * function -- `claude` works when you type it and does not exist as a file --
 * or an install somewhere the login shell adds to PATH and nothing else does.
 * "spawn claude ENOENT" is accurate and tells you none of that.
 */
export function startupFailure(bin: string, provider: Provider, spawnError: string): string {
  if (!/ENOENT/.test(spawnError)) return `could not start ${bin}: ${spawnError}`;
  return (
    `could not start "${bin}": there is no such executable on PATH. A shell alias or ` +
    `function will not do -- the office spawns the binary itself and never opens a shell. ` +
    `Run \`type -a ${bin}\`: if it names a real file, put that absolute path in ` +
    `providers.${provider}.bin in office.config.json. If it names nothing, that CLI is not installed.`
  );
}

export function failed(error: string, sessionId: string, model: string, durationMs: number): TurnResult {
  return {
    ok: false, text: "", sessionId, model, costUsd: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    durationMs, turns: 0, error,
  };
}
