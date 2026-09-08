import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage } from "../types.js";
import type { Paths } from "../paths.js";
import { Mutex, nowIso, shortId } from "../util.js";

/**
 * A channel transcript: append-only JSONL, one file per channel.
 *
 * Mail is a queue and stays one -- a message addressed to a single agent that
 * moves outbox -> inbox -> archive as it is handled. A channel line is
 * addressed to the room and is never handled, only read, so it is a log. The
 * ledger is the same shape for the same reason, and the two share the failure
 * mode they were built for: a torn last line after a hard kill costs one row,
 * not the file.
 */
export class ChatStore {
  private readonly appends = new Mutex();

  constructor(private readonly paths: Paths) {}

  /**
   * Serialised, because appendFile from two turns finishing in the same tick
   * can interleave inside one line. Atomic writes do not help here: there is no
   * rename to be atomic about, only a shared file handle and two writers.
   */
  async post(msg: Omit<ChatMessage, "id" | "at">): Promise<ChatMessage> {
    const full: ChatMessage = { ...msg, id: shortId("chat"), at: nowIso() };
    await this.appends.run(async () => {
      const path = this.paths.chat(full.channel);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");
    });
    return full;
  }

  /** The tail of a channel, oldest first. `limit` of 0 means everything. */
  async history(channel: string, limit = 0): Promise<ChatMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.paths.chat(channel), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const out: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ChatMessage);
      } catch {
        // A half-written final line should not blank the channel.
      }
    }
    return limit > 0 ? out.slice(-limit) : out;
  }
}
