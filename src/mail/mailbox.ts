import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso, shortId, writeJsonAtomic } from "../util.js";
import type { Message } from "../types.js";
import type { Paths } from "../paths.js";

/**
 * Mail is files on disk, not an in-process event bus.
 *
 * That is the whole point: an agent is a separate CLI process that may outlive
 * the harness, and a message that only exists in the orchestrator's heap is
 * gone the moment you close the app. A directory of JSON survives a crash, is
 * greppable, and an agent can drop a message in it with a shell redirect if
 * everything else is broken.
 */
export class Mailbox {
  constructor(private readonly paths: Paths) {}

  async send(msg: Omit<Message, "id" | "sentAt">): Promise<Message> {
    const full: Message = { ...msg, id: shortId("msg"), sentAt: nowIso() };
    await this.paths.ensureAgent(full.from);
    await writeJsonAtomic(join(this.paths.outbox(full.from), `${full.id}.json`), full);
    return full;
  }

  async outbox(agent: string): Promise<Message[]> {
    return this.readDir(this.paths.outbox(agent));
  }

  async inbox(agent: string, opts: { unreadOnly?: boolean } = {}): Promise<Message[]> {
    const all = await this.readDir(this.paths.inbox(agent));
    return opts.unreadOnly ? all.filter((m) => !m.readAt) : all;
  }

  /** Mark read in place, then move to archive so the inbox stays a to-do list. */
  async markRead(agent: string, ids: string[]): Promise<void> {
    await this.paths.ensureAgent(agent);
    for (const id of ids) {
      const src = join(this.paths.inbox(agent), `${id}.json`);
      let msg: Message;
      try {
        msg = JSON.parse(await readFile(src, "utf8")) as Message;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      msg.readAt = nowIso();
      await writeFile(src, `${JSON.stringify(msg, null, 2)}\n`, "utf8");
      await rename(src, join(this.paths.archive(agent), `${id}.json`));
    }
  }

  private async readDir(dir: string): Promise<Message[]> {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const messages: Message[] = [];
    for (const file of files) {
      try {
        messages.push(JSON.parse(await readFile(join(dir, file), "utf8")) as Message);
      } catch {
        // A half-written or hand-edited message should not take down the floor.
        continue;
      }
    }
    return messages.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }
}
