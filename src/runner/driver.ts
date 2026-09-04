import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Autonomy, Tier } from "../types.js";

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
  /** Extra env for the child, e.g. OFFICE_AGENT so `office mail` knows who is calling. */
  env?: Record<string, string>;
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
  readonly name: string;
  run(req: TurnRequest): Promise<TurnResult>;
}

/** Tier names map to CLI model aliases, so a tier change is a flag change. */
export const TIER_MODEL: Record<Tier, string> = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};

/**
 * Every agent runs with edits accepted inside its own worktree.
 *
 * The tempting alternative is to run low-autonomy agents in "plan" mode so the
 * CLI itself refuses to write. It does not work here: plan mode also blocks the
 * shell commands the office protocol is built on, so an agent could no longer
 * send mail, record memory, or mark a task done -- it would look obedient and
 * be useless.
 *
 * So containment is the worktree, and the gate decides whether work leaves it.
 * A write by an "ask" agent lands on its own branch and stops there until a
 * human approves it. Tool restriction, not permission mode, is how a role is
 * narrowed -- see `allowedTools` on the role.
 *
 * bypassPermissions is never selected here. If you want it, pass it yourself
 * and own the consequences.
 */
export function permissionModeFor(_autonomy: Autonomy): string {
  return "acceptEdits";
}

export class ClaudeCliDriver implements Driver {
  readonly name = "claude";

  constructor(private readonly bin = "claude") {}

  buildArgs(req: TurnRequest): { args: string[]; sessionId: string } {
    const sessionId = req.sessionId ?? randomUUID();
    const args = [
      "-p",
      "--output-format", "json",
      "--model", TIER_MODEL[req.tier],
      "--permission-mode", permissionModeFor(req.autonomy),
      "--append-system-prompt", req.systemPrompt,
    ];
    // Resuming keeps the agent's thread; a fresh id starts one we can resume later.
    if (req.sessionId) args.push("--resume", req.sessionId);
    else args.push("--session-id", sessionId);
    if (req.allowedTools.length) args.push("--allowedTools", ...req.allowedTools);
    if (req.disallowedTools.length) args.push("--disallowedTools", ...req.disallowedTools);
    for (const dir of req.addDirs) args.push("--add-dir", dir);
    args.push(req.prompt);
    return { args, sessionId };
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const started = Date.now();
    const { args, sessionId } = this.buildArgs(req);

    return new Promise<TurnResult>((resolve) => {
      const child = spawn(this.bin, args, {
        cwd: req.cwd,
        env: { ...process.env, ...req.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        // A turn that ignores SIGTERM is exactly the runaway we are here to stop.
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        resolve(fail(`turn exceeded ${Math.round(req.timeoutMs / 1000)}s and was killed`, sessionId, req.tier, Date.now() - started));
      }, req.timeoutMs);

      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fail(`could not start ${this.bin}: ${err.message}`, sessionId, req.tier, Date.now() - started));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parsed = parseResult(stdout, sessionId, req.tier, Date.now() - started);
        if (parsed) return resolve(parsed);
        resolve(fail(
          `${this.bin} exited ${code} without a parseable result: ${(stderr || stdout).trim().slice(0, 500) || "no output"}`,
          sessionId, req.tier, Date.now() - started,
        ));
      });
    });
  }
}

/** Shape of the JSON the CLI prints under `-p --output-format json`. */
interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  modelUsage?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function parseResult(stdout: string, fallbackSession: string, tier: Tier, elapsedMs: number): TurnResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  // Be forgiving: a stray banner line before the JSON should not lose the turn.
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let parsed: CliResult;
  try {
    parsed = JSON.parse(trimmed.slice(start)) as CliResult;
  } catch {
    return null;
  }

  const usage = parsed.usage ?? {};
  const model = Object.keys(parsed.modelUsage ?? {})[0] ?? TIER_MODEL[tier];
  return {
    ok: parsed.is_error !== true && parsed.subtype !== "error_during_execution",
    text: parsed.result ?? "",
    sessionId: parsed.session_id ?? fallbackSession,
    model,
    costUsd: parsed.total_cost_usd ?? 0,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    durationMs: parsed.duration_ms ?? elapsedMs,
    turns: parsed.num_turns ?? 1,
    error: parsed.is_error ? parsed.result : undefined,
  };
}

function fail(error: string, sessionId: string, tier: Tier, durationMs: number): TurnResult {
  return {
    ok: false, text: "", sessionId, model: TIER_MODEL[tier], costUsd: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    durationMs, turns: 0, error,
  };
}

/** Deterministic stand-in so the floor can be exercised without spending a token. */
export class FakeDriver implements Driver {
  readonly name = "fake";
  readonly calls: TurnRequest[] = [];

  constructor(private readonly reply: (req: TurnRequest, n: number) => Partial<TurnResult> | Promise<Partial<TurnResult>> = () => ({})) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    this.calls.push(req);
    const override = await this.reply(req, this.calls.length);
    return {
      ok: true,
      text: `[fake ${req.agent}] ${req.prompt.slice(0, 120)}`,
      sessionId: req.sessionId ?? `fake-session-${req.agent}`,
      model: TIER_MODEL[req.tier],
      costUsd: 0.01,
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 500,
      durationMs: 10, turns: 1,
      ...override,
    };
  }
}
