import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, rm } from "node:fs/promises";
import type { Paths } from "../paths.js";

const exec = promisify(execFile);

export interface WorktreeInfo {
  agent: string;
  path: string;
  branch: string;
  dirty: boolean;
  ahead: number;
}

/**
 * One git worktree per agent.
 *
 * Two agents editing the same checkout is the failure that eats a morning:
 * agent A stages a file agent B is mid-edit on, and the commit that lands
 * belongs to neither of them. Worktrees are git's own answer -- separate
 * directories, separate branches, one object store, no copying.
 */
export class WorktreeManager {
  constructor(private readonly repo: string, private readonly paths: Paths) {}

  private git(args: string[], cwd = this.repo) {
    return exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  }

  async assertRepo(): Promise<void> {
    try {
      await this.git(["rev-parse", "--git-dir"]);
    } catch {
      throw new Error(`${this.repo} is not a git repository -- run "git init" there first`);
    }
    const { stdout } = await this.git(["rev-list", "-n", "1", "--all"]);
    if (!stdout.trim()) {
      throw new Error("this repository has no commits yet; worktrees need at least one commit to branch from");
    }
  }

  branchFor(agent: string): string {
    return `office/${agent}`;
  }

  /** Create the agent's worktree if absent. Returns the path either way. */
  async ensure(agent: string, base = "HEAD"): Promise<string> {
    const path = this.paths.worktree(agent);
    if (await exists(path)) return path;

    const branch = this.branchFor(agent);
    const branchExists = await this.hasBranch(branch);
    const args = branchExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, base];
    await this.git(args);
    return path;
  }

  async hasBranch(branch: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async info(agent: string): Promise<WorktreeInfo | null> {
    const path = this.paths.worktree(agent);
    if (!(await exists(path))) return null;
    const branch = this.branchFor(agent);
    const { stdout: status } = await this.git(["status", "--porcelain"], path);
    let ahead = 0;
    try {
      const { stdout } = await this.git(["rev-list", "--count", `HEAD...${await this.defaultBranch()}`], path);
      ahead = Number.parseInt(stdout.trim(), 10) || 0;
    } catch { /* detached or unborn base; ahead stays 0 */ }
    return { agent, path, branch, dirty: status.trim().length > 0, ahead };
  }

  async defaultBranch(): Promise<string> {
    try {
      const { stdout } = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      return stdout.trim().replace(/^origin\//, "");
    } catch {
      const { stdout } = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
      return stdout.trim();
    }
  }

  /**
   * What the agent changed, as a diff against the branch it started from.
   *
   * Untracked files are included deliberately. An agent's most common action is
   * creating a file, and plain `git diff` shows none of them -- a review pane
   * that says "no changes" while three new modules sit on the branch is worse
   * than no review pane. They are rendered with --no-index rather than by
   * staging them, because touching the index of a worktree an agent is still
   * working in is not this method's business.
   */
  async diff(agent: string, base?: string, opts: { maxUntracked?: number } = {}): Promise<string> {
    const path = this.paths.worktree(agent);
    if (!(await exists(path))) return "";
    const against = base ?? (await this.defaultBranch());

    const parts: string[] = [];
    try {
      const { stdout } = await this.git(["diff", `${against}...HEAD`], path);
      parts.push(stdout);
    } catch {
      // No merge base yet (a branch cut from an unrelated root). Committed work
      // still shows through the uncommitted diff below.
    }

    const { stdout: uncommitted } = await this.git(["diff"], path);
    parts.push(uncommitted);

    for (const file of (await this.untrackedFiles(agent)).slice(0, opts.maxUntracked ?? 25)) {
      try {
        // --no-index exits 1 when the files differ, which is every time here.
        await this.git(["diff", "--no-index", "--", "/dev/null", file], path);
      } catch (err) {
        const stdout = (err as { stdout?: string }).stdout ?? "";
        if (stdout.trim()) parts.push(stdout);
      }
    }

    return parts.filter((s) => s.trim()).join("\n");
  }

  async untrackedFiles(agent: string): Promise<string[]> {
    const path = this.paths.worktree(agent);
    if (!(await exists(path))) return [];
    const { stdout } = await this.git(["ls-files", "--others", "--exclude-standard"], path);
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  /** Files touched since the given ref. Used to tell progress from spinning. */
  async touchedFiles(agent: string, since = "HEAD"): Promise<string[]> {
    const path = this.paths.worktree(agent);
    if (!(await exists(path))) return [];
    const { stdout: tracked } = await this.git(["diff", "--name-only", since], path);
    const { stdout: untracked } = await this.git(["ls-files", "--others", "--exclude-standard"], path);
    return [...tracked.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean);
  }

  async remove(agent: string, { force = false } = {}): Promise<void> {
    const path = this.paths.worktree(agent);
    if (!(await exists(path))) return;
    try {
      await this.git(["worktree", "remove", ...(force ? ["--force"] : []), path]);
    } catch (err) {
      if (!force) throw err;
      await rm(path, { recursive: true, force: true });
      await this.git(["worktree", "prune"]);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
