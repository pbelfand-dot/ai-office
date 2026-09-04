import { readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Message } from "../types.js";
import type { Paths } from "../paths.js";
import { writeJsonAtomic } from "../util.js";

export interface DeliveryReport {
  delivered: number;
  dropped: { id: string; from: string; to: string; reason: string }[];
}

/**
 * Moves messages from every outbox into the addressed inbox.
 *
 * Delivery is a rename inside .office, which is atomic on one filesystem, so a
 * message is never both sent and not sent. Mail to an agent who does not exist
 * is dropped loudly rather than queued forever -- a typo'd recipient that
 * silently accumulates is how you end up with an agent waiting on a reply that
 * was never going to come.
 */
export class Router {
  constructor(private readonly paths: Paths) {}

  async deliverAll(known: Set<string>): Promise<DeliveryReport> {
    const report: DeliveryReport = { delivered: 0, dropped: [] };
    let agents: string[];
    try {
      agents = (await readdir(join(this.paths.office, "agents"), { withFileTypes: true }))
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return report;
      throw err;
    }

    for (const from of agents) {
      const dir = this.paths.outbox(from);
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
      } catch { continue; }

      for (const file of files) {
        const src = join(dir, file);
        let msg: Message;
        try {
          msg = JSON.parse(await readFile(src, "utf8")) as Message;
        } catch {
          report.dropped.push({ id: file, from, to: "?", reason: "unparseable message" });
          await this.quarantine(src, file);
          continue;
        }

        if (!known.has(msg.to)) {
          report.dropped.push({ id: msg.id, from, to: msg.to, reason: `no agent named "${msg.to}"` });
          await this.quarantine(src, file);
          continue;
        }

        await this.paths.ensureAgent(msg.to);
        await rename(src, join(this.paths.inbox(msg.to), `${msg.id}.json`));
        report.delivered++;
      }
    }
    return report;
  }

  private async quarantine(src: string, file: string): Promise<void> {
    const dest = join(this.paths.office, "dead-letters");
    await writeJsonAtomic(join(dest, `${file}.meta.json`), { quarantinedFrom: src });
    try {
      await rename(src, join(dest, file));
    } catch {
      await unlink(src).catch(() => {});
    }
  }
}
