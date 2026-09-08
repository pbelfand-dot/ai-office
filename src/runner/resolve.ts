import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Where a CLI ends up when it is not on the PATH we were handed.
 *
 * All three of these are normal installs -- the native installer, the npm
 * global prefix under a version manager, Homebrew on Apple silicon -- and all
 * three are routinely added to PATH by an interactive login shell and by
 * nothing else. The office is spawned from that shell often enough to look
 * fine, and from anything else often enough to look broken.
 */
const FALLBACK_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".claude", "local"),
  join(homedir(), "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

/**
 * Find the executable, or hand back what we were given.
 *
 * Returning the bare name on failure is deliberate: spawn's own ENOENT, and
 * the message built from it, say more about what to do next than any error
 * this function could invent about where it looked.
 */
export function resolveBin(bin: string): string {
  if (bin.includes("/")) return bin;

  const fromPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...FALLBACK_DIRS]) {
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable. Both mean: keep looking.
    }
  }
  return bin;
}
