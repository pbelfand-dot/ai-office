import { randomUUID } from "node:crypto";
import type { Autonomy } from "../types.js";
import type { Driver, TurnRequest, TurnResult } from "./types.js";
import { failed } from "./types.js";
import { runProcess } from "./spawn.js";

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
 * bypassPermissions is never selected here.
 */
export function permissionModeFor(_autonomy: Autonomy): string {
  return "acceptEdits";
}

export class ClaudeDriver implements Driver {
  readonly name = "claude" as const;

  constructor(private readonly bin = "claude") {}

  buildArgs(req: TurnRequest): { args: string[]; sessionId: string } {
    const sessionId = req.sessionId ?? randomUUID();
    const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode", permissionModeFor(req.autonomy),
      "--append-system-prompt", req.systemPrompt,
    ];
    if (req.model) args.push("--model", req.model);
    // Resuming keeps the agent's thread; a fresh id starts one we can resume.
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
    const model = req.model ?? "default";
    const proc = await runProcess(this.bin, args, { cwd: req.cwd, env: req.env, timeoutMs: req.timeoutMs });

    if (proc.spawnError) return failed(`could not start ${this.bin}: ${proc.spawnError}`, sessionId, model, Date.now() - started);
    if (proc.timedOut) return failed(`turn exceeded ${Math.round(req.timeoutMs / 1000)}s and was killed`, sessionId, model, Date.now() - started);

    const parsed = parseClaudeResult(proc.stdout, sessionId, model, Date.now() - started);
    if (parsed) return parsed;
    return failed(
      `${this.bin} exited ${proc.code} without a parseable result: ${(proc.stderr || proc.stdout).trim().slice(0, 500) || "no output"}`,
      sessionId, model, Date.now() - started,
    );
  }
}

/** Shape of the JSON the CLI prints under `-p --output-format json`. */
interface ClaudeResult {
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

export function parseClaudeResult(stdout: string, fallbackSession: string, fallbackModel: string, elapsedMs: number): TurnResult | null {
  const trimmed = stdout.trim();
  // Be forgiving: a stray banner line before the JSON should not lose the turn.
  const start = trimmed.indexOf("{");
  if (start === -1) return null;

  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(trimmed.slice(start)) as ClaudeResult;
  } catch {
    return null;
  }

  const usage = parsed.usage ?? {};
  return {
    ok: parsed.is_error !== true && parsed.subtype !== "error_during_execution",
    text: parsed.result ?? "",
    sessionId: parsed.session_id ?? fallbackSession,
    model: Object.keys(parsed.modelUsage ?? {})[0] ?? fallbackModel,
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
