import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../util.js";
import type { Paths } from "../paths.js";

const ENTRY = /^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)(?:\s+·\s+(.*))?$/;

export interface MemoryEntry {
  at: string;
  tag?: string;
  text: string;
}

/**
 * Two files per agent, with different lifetimes.
 *
 * journal.md is what happened, append-only and rolled over when it gets long.
 * facts.md is what is still true, and only the agent rewrites it.
 *
 * There is no automatic summarisation here on purpose. Condensing a journal
 * well means reading it, and reading it means a model call -- so the office
 * would quietly spend your window compressing notes nobody asked for. Rolling
 * over is free; deciding what matters is the agent's job, on a turn you paid
 * for anyway.
 */
export class MemoryStore {
  constructor(private readonly paths: Paths, private readonly rolloverEntries = 200) {}

  async remember(agent: string, text: string, tag?: string): Promise<void> {
    await this.paths.ensureAgent(agent);
    const header = tag ? `## ${nowIso()} · ${tag}` : `## ${nowIso()}`;
    await appendFile(this.paths.journal(agent), `${header}\n\n${text.trim()}\n\n`, "utf8");
    await this.rolloverIfNeeded(agent);
  }

  async journal(agent: string): Promise<MemoryEntry[]> {
    return parseJournal(await read(this.paths.journal(agent)));
  }

  async facts(agent: string): Promise<string> {
    return read(this.paths.facts(agent));
  }

  async setFacts(agent: string, text: string): Promise<void> {
    await this.paths.ensureAgent(agent);
    await writeFile(this.paths.facts(agent), `${text.trim()}\n`, "utf8");
  }

  /** The slice of memory worth spending context on at the start of a turn. */
  async brief(agent: string, recentEntries = 8): Promise<string> {
    const [facts, entries] = await Promise.all([this.facts(agent), this.journal(agent)]);
    const recent = entries.slice(-recentEntries);
    const parts: string[] = [];
    if (facts.trim()) parts.push(`### What you know\n\n${facts.trim()}`);
    if (recent.length) {
      const rendered = recent.map((e) => `- ${e.at}${e.tag ? ` (${e.tag})` : ""}: ${e.text.replace(/\s+/g, " ").trim()}`).join("\n");
      parts.push(`### Recently\n\n${rendered}`);
    }
    return parts.join("\n\n");
  }

  private async rolloverIfNeeded(agent: string): Promise<void> {
    const entries = await this.journal(agent);
    if (entries.length <= this.rolloverEntries) return;

    const keep = entries.slice(-Math.floor(this.rolloverEntries / 2));
    const rolled = entries.slice(0, entries.length - keep.length);
    const archiveDir = join(this.paths.memoryDir(agent), "archive");
    await mkdir(archiveDir, { recursive: true });
    await appendFile(join(archiveDir, `journal-${nowIso().slice(0, 10)}.md`), rolled.map(render).join(""), "utf8");
    await writeFile(this.paths.journal(agent), keep.map(render).join(""), "utf8");
  }
}

function render(entry: MemoryEntry): string {
  const header = entry.tag ? `## ${entry.at} · ${entry.tag}` : `## ${entry.at}`;
  return `${header}\n\n${entry.text.trim()}\n\n`;
}

export function parseJournal(source: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let current: MemoryEntry | null = null;
  for (const line of source.split(/\r?\n/)) {
    const match = ENTRY.exec(line);
    if (match) {
      if (current) entries.push({ ...current, text: current.text.trim() });
      current = { at: match[1] as string, tag: match[2], text: "" };
    } else if (current) {
      current.text += `${line}\n`;
    }
  }
  if (current) entries.push({ ...current, text: current.text.trim() });
  return entries;
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}
