import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Escalation, EscalationKind, Role } from "../types.js";
import { nowIso, shortId, writeJsonAtomic } from "../util.js";
import type { Paths } from "../paths.js";

/**
 * Commands that are cheap to run and expensive to undo. Matching is on the
 * command line the agent proposes, so this is a tripwire rather than a sandbox
 * -- the CLI's own permission system is the sandbox. This catches the honest
 * mistake, not a determined bypass.
 */
const DESTRUCTIVE = [
  /\bgit\s+push\b(?!.*--dry-run)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+(rebase|filter-branch)\b/,
  /--force\b|--force-with-lease\b|\s-f\b/,
  /\brm\s+-[a-z]*r[a-z]*f?\b|\brm\s+-[a-z]*f[a-z]*r?\b/,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\bnpm\s+publish\b|\bcargo\s+publish\b|\bpip\s+upload\b/,
  /\baws\s+\S+\s+delete\b|\bgcloud\s+\S+\s+delete\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
];

export interface ScopeCheck {
  allowed: string[];
  violations: string[];
}

/**
 * Does this path fall inside what the role was hired to touch?
 *
 * Prefix matching, deliberately. Real glob semantics invite the argument about
 * whether `src/**\/*.ts` covers `src/a/b.ts`, and a scope rule you have to
 * reason about is a scope rule someone will get wrong. A trailing slash means
 * a directory; anything else is a literal path or a prefix.
 */
export function inScope(path: string, scope: string[]): boolean {
  const normalized = path.replace(/^\.\//, "");
  // Checked before the empty-scope case on purpose: "no declared scope" means
  // the whole repo, never the whole filesystem.
  if (normalized.startsWith("../") || normalized.startsWith("/")) return false;
  if (scope.length === 0) return true;
  return scope.some((entry) => {
    const rule = entry.replace(/^\.\//, "").replace(/\*+$/, "");
    if (rule === "") return true;
    return rule.endsWith("/") ? normalized.startsWith(rule) : normalized === rule || normalized.startsWith(`${rule}/`);
  });
}

export function checkScope(paths: string[], role: Role): ScopeCheck {
  const allowed: string[] = [];
  const violations: string[] = [];
  for (const path of paths) (inScope(path, role.scope) ? allowed : violations).push(path);
  return { allowed, violations };
}

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(command));
}

/**
 * The gate: which of an agent's actions come back to a human.
 *
 * Autonomy is per role, so a new agent can start at "ask" and be promoted once
 * you have read a week of its diffs, rather than every agent sharing one
 * global slider you eventually turn off out of irritation.
 */
export function needsApproval(role: Role, event: { touchedFiles?: string[]; commands?: string[]; costUsd?: number }, escalateAboveUsd: number): { required: boolean; kind?: EscalationKind; detail: string } {
  const commands = event.commands ?? [];
  const destructive = commands.filter(isDestructive);
  if (destructive.length) {
    return { required: true, kind: "destructive", detail: `destructive command proposed:\n${destructive.join("\n")}` };
  }

  if (event.costUsd !== undefined && event.costUsd > escalateAboveUsd) {
    return { required: true, kind: "spend", detail: `turn cost $${event.costUsd.toFixed(2)}, over the $${escalateAboveUsd.toFixed(2)} per-task ceiling` };
  }

  const touched = event.touchedFiles ?? [];
  if (role.autonomy === "ask" && touched.length) {
    return { required: true, kind: "out-of-scope", detail: `autonomy "ask": every write needs sign-off\n${touched.join("\n")}` };
  }

  if (role.autonomy === "scoped" && touched.length) {
    const { violations } = checkScope(touched, role);
    if (violations.length) {
      return { required: true, kind: "out-of-scope", detail: `wrote outside ${role.scope.join(", ")}:\n${violations.join("\n")}` };
    }
  }

  return { required: false, detail: "" };
}

export class EscalationStore {
  constructor(private readonly paths: Paths) {}

  async raise(input: Omit<Escalation, "id" | "raisedAt">): Promise<Escalation> {
    const escalation: Escalation = { ...input, id: shortId("esc"), raisedAt: nowIso() };
    await writeJsonAtomic(join(this.paths.escalations, `${escalation.id}.json`), escalation);
    return escalation;
  }

  async list(opts: { openOnly?: boolean } = {}): Promise<Escalation[]> {
    let files: string[];
    try {
      files = (await readdir(this.paths.escalations)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Escalation[] = [];
    for (const file of files) {
      try {
        out.push(JSON.parse(await readFile(join(this.paths.escalations, file), "utf8")) as Escalation);
      } catch { continue; }
    }
    const sorted = out.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
    return opts.openOnly ? sorted.filter((e) => !e.decision) : sorted;
  }

  async decide(id: string, decision: "approve" | "deny", note?: string): Promise<Escalation> {
    const path = join(this.paths.escalations, `${id}.json`);
    const escalation = JSON.parse(await readFile(path, "utf8")) as Escalation;
    if (escalation.decision) throw new Error(`${id} was already ${escalation.decision}d at ${escalation.decidedAt}`);
    escalation.decision = decision;
    escalation.decidedAt = nowIso();
    escalation.note = note;
    await writeJsonAtomic(path, escalation);
    return escalation;
  }
}
