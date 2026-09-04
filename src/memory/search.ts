import { readdir } from "node:fs/promises";
import type { Paths } from "../paths.js";
import { MemoryStore } from "./store.js";

export interface Hit {
  agent: string;
  source: "journal" | "facts";
  at?: string;
  text: string;
  score: number;
}

const STOP = new Set([
  "the","a","an","and","or","but","if","then","of","to","in","on","for","with",
  "is","are","was","were","be","been","it","this","that","as","at","by","from",
  "we","you","i","he","she","they","not","no","do","does","did","so","up","out",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * BM25 over the office's markdown memory.
 *
 * Embeddings would rank better, but they cost a call per write and a vector
 * store to hold them, and the corpus here is a few thousand short notes. BM25
 * on a corpus this size is the boring answer that stays free and offline, and
 * every agent's grep habits already work the same way.
 */
export class MemoryIndex {
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(private readonly paths: Paths, private readonly store: MemoryStore) {}

  async search(query: string, limit = 8, opts: { agent?: string } = {}): Promise<Hit[]> {
    const docs = await this.collect(opts.agent);
    if (docs.length === 0) return [];

    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const tokenized = docs.map((d) => tokenize(d.text));
    const avgLen = tokenized.reduce((sum, t) => sum + t.length, 0) / tokenized.length || 1;

    const df = new Map<string, number>();
    for (const tokens of tokenized) {
      for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
    }

    const scored = docs.map((doc, i) => {
      const tokens = tokenized[i] as string[];
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

      let score = 0;
      for (const term of terms) {
        const f = counts.get(term);
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (tokens.length / avgLen))));
      }
      return { ...doc, score };
    });

    return scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async collect(only?: string): Promise<Omit<Hit, "score">[]> {
    const agents = only ? [only] : await this.agentIds();
    const out: Omit<Hit, "score">[] = [];
    for (const agent of agents) {
      const facts = await this.store.facts(agent);
      if (facts.trim()) out.push({ agent, source: "facts", text: facts.trim() });
      for (const entry of await this.store.journal(agent)) {
        out.push({ agent, source: "journal", at: entry.at, text: entry.text });
      }
    }
    return out;
  }

  private async agentIds(): Promise<string[]> {
    try {
      const entries = await readdir(`${this.paths.office}/agents`, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
