import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export const nowIso = (): string => new Date().toISOString();

/** Short, sortable, human-typeable id. */
export function shortId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = randomUUID().slice(0, 4);
  return `${prefix}_${t}${r}`;
}

export function fingerprint(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a
 * half-written state file that the next run refuses to parse.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // The pid alone is not unique enough: two agents run concurrently inside one
  // harness process, and a shared temp name means the second rename finds the
  // file already gone.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Serialises read-modify-write on one file.
 *
 * Atomic writes stop a torn file; they do nothing about a lost update. Two
 * agents finishing in the same tick both read tasks.json, both edit their own
 * row, and the second write erases the first -- a task silently reverting to
 * "assigned" and being paid for twice. Concurrency is the point of this
 * harness, so the shared documents need a queue.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
