import { spawn } from "node:child_process";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Run a CLI to completion, or kill it.
 *
 * A turn that ignores SIGTERM is exactly the runaway the office exists to stop,
 * so the timeout escalates to SIGKILL rather than waiting politely. Both
 * drivers share this because the difference between them is in the flags and
 * the output format, not in how a child process is supervised.
 */
export function runProcess(bin: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      finish({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs);

    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => finish({ code: null, stdout, stderr, timedOut: false, spawnError: err.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}
