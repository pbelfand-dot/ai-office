import type { Driver, TurnRequest, TurnResult } from "./types.js";
import { failed } from "./types.js";
import { runProcess } from "./spawn.js";

/**
 * Codex, driven through `codex exec --json`.
 *
 * Three differences from Claude Code shape the whole file:
 *
 * 1. There is no --append-system-prompt. Codex takes project context from
 *    AGENTS.md, which is per-directory, not per-agent -- and several agents
 *    share this repo. So the role briefing is prepended to the prompt instead.
 * 2. Output is a JSONL event stream, not one result object, and the usage
 *    numbers arrive on the last turn.completed event.
 * 3. Approval flags are global and must precede `exec`, not follow it.
 *
 * Sessions are resumed by thread id. --ephemeral is deliberately NOT used: it
 * would drop the session file the next turn resumes from, and each agent has
 * its own worktree, so the shared-restore-file interference that --ephemeral
 * exists to avoid does not apply here.
 */
export class CodexDriver implements Driver {
  readonly name = "codex" as const;

  constructor(private readonly bin = "codex") {}

  buildArgs(req: TurnRequest): string[] {
    // -a is a global flag: it belongs before the subcommand, not after it.
    const args = ["-a", "never", "exec"];
    if (req.sessionId) args.push("resume", req.sessionId);

    args.push("--json", "--sandbox", "workspace-write", "--skip-git-repo-check");
    if (req.model) args.push("--model", req.model);
    // The worktree is the agent's cwd; the mailbox lives outside it.
    for (const dir of req.addDirs) args.push("--add-dir", dir);

    args.push(this.composePrompt(req));
    return args;
  }

  /** No system-prompt flag, so the briefing rides in front of the instruction. */
  private composePrompt(req: TurnRequest): string {
    return `${req.systemPrompt}\n\n---\n\n${req.prompt}`;
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const started = Date.now();
    const model = req.model ?? "default";
    const proc = await runProcess(this.bin, this.buildArgs(req), { cwd: req.cwd, env: req.env, timeoutMs: req.timeoutMs });

    if (proc.spawnError) return failed(`could not start ${this.bin}: ${proc.spawnError}`, req.sessionId ?? "", model, Date.now() - started);
    if (proc.timedOut) return failed(`turn exceeded ${Math.round(req.timeoutMs / 1000)}s and was killed`, req.sessionId ?? "", model, Date.now() - started);

    const parsed = parseCodexStream(proc.stdout, req.sessionId, model, Date.now() - started);
    if (parsed) return parsed;
    return failed(
      `${this.bin} exited ${proc.code} without a parseable event stream: ${(proc.stderr || proc.stdout).trim().slice(0, 500) || "no output"}`,
      req.sessionId ?? "", model, Date.now() - started,
    );
  }
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
}

/**
 * Fold the JSONL stream into one result.
 *
 * Unknown event types are ignored rather than treated as errors: the stream is
 * versioned by OpenAI, not by us, and a new event type appearing should cost a
 * field in the ledger, not the whole turn. A line that will not parse is
 * skipped for the same reason -- interleaved stderr should not lose the usage
 * numbers three lines later.
 */
export function parseCodexStream(stdout: string, fallbackSession: string | undefined, fallbackModel: string, elapsedMs: number): TurnResult | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let sessionId = fallbackSession;
  let text = "";
  let usage: CodexEvent["usage"];
  let error: string | undefined;
  let turns = 0;
  let sawAnything = false;

  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    sawAnything = true;

    switch (event.type) {
      case "thread.started":
        if (event.thread_id) sessionId = event.thread_id;
        break;
      case "turn.started":
        turns++;
        break;
      case "item.completed":
        // Reasoning items are also item.completed; only the message is output.
        if (event.item?.type === "agent_message" && event.item.text) {
          text += (text ? "\n" : "") + event.item.text;
        }
        break;
      case "turn.completed":
        if (event.usage) usage = event.usage;
        break;
      case "turn.failed":
      case "error":
        error = typeof event.error === "string" ? event.error : event.error?.message ?? "the turn failed";
        break;
      default:
        break;
    }
  }

  if (!sawAnything) return null;

  const input = usage?.input_tokens ?? 0;
  const cached = usage?.cached_input_tokens ?? 0;
  return {
    ok: !error,
    text,
    sessionId,
    model: fallbackModel,
    // Codex reports no cost on a subscription, and inventing one would put a
    // fabricated number in front of the spend gate. Zero is the honest value;
    // the token budget is what governs this provider.
    costUsd: 0,
    // cached_input_tokens is a subset of input_tokens, so subtract it out
    // rather than counting the cached portion at full weight twice.
    inputTokens: Math.max(0, input - cached),
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheCreationTokens: 0,
    durationMs: elapsedMs,
    turns: Math.max(1, turns),
    error,
  };
}
