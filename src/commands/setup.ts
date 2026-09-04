import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Paths } from "../paths.js";
import { defaultConfig, saveConfig, type Plan } from "../config.js";
import { DEFAULT_ROLES } from "../agents/defaults.js";
import { bold, dim, green, yellow } from "./format.js";

export interface InitOptions {
  root: string;
  plan: Plan;
  force: boolean;
  seed: boolean;
}

export async function init(opts: InitOptions): Promise<string> {
  const paths = new Paths(opts.root);
  const lines: string[] = [];

  if (!opts.force && (await exists(paths.config))) {
    throw new Error(`${paths.config} already exists. Pass --force to overwrite it.`);
  }

  const config = defaultConfig(opts.plan);
  await saveConfig(paths.config, config);
  await paths.ensureOffice();
  await mkdir(paths.rolesDir, { recursive: true });
  lines.push(`${green("created")} office.config.json ${dim(`(plan ${opts.plan})`)}`);

  if (opts.seed) {
    for (const [id, source] of Object.entries(DEFAULT_ROLES)) {
      const path = join(paths.rolesDir, `${id}.md`);
      if (!opts.force && (await exists(path))) {
        lines.push(`${dim("kept")}    office/agents/${id}.md`);
        continue;
      }
      await writeFile(path, source, "utf8");
      lines.push(`${green("hired")}   ${id}`);
    }
  }

  lines.push("");
  lines.push(bold("The number that matters"));
  lines.push(
    `  Concurrency is capped at ${bold(String(config.budget.maxConcurrentAgents))} for the ${opts.plan} plan. Every agent signs in as\n` +
    `  the same subscription, so more desks do not buy more capacity -- they spend\n` +
    `  the same capacity faster. Raise it in office.config.json once you have a week\n` +
    `  of ledger data and ${dim("office budget --calibrate")} tells you there is room.`,
  );
  lines.push("");
  lines.push(`${yellow("Next")}: ${dim("office roster")}, then ${dim('office brief "<what you want done>"')}`);
  return lines.join("\n");
}

export async function hire(root: string, id: string, opts: { title?: string; tier?: string; autonomy?: string; scope?: string[] }): Promise<string> {
  const paths = new Paths(root);
  const path = join(paths.rolesDir, `${id}.md`);
  if (await exists(path)) throw new Error(`${id} already has a desk at office/agents/${id}.md`);

  const scope = opts.scope?.length ? opts.scope : ["src/"];
  const autonomy = opts.autonomy ?? "ask";
  const body = [
    "---",
    `name: ${id.charAt(0).toUpperCase()}${id.slice(1)}`,
    `title: ${opts.title ?? "Staff"}`,
    `tier: ${opts.tier ?? "sonnet"}`,
    `autonomy: ${autonomy}`,
    "scope:",
    ...scope.map((s) => `  - ${s}`),
    "---",
    "",
    `You are the ${opts.title ?? "staff engineer"} on this floor.`,
    "",
    "Replace this with a real briefing. Be specific about what you own, what good",
    "work looks like here, and what you should refuse to decide alone. A vague",
    "briefing produces vague work, and you pay for both.",
    "",
  ].join("\n");

  await mkdir(paths.rolesDir, { recursive: true });
  await writeFile(path, body, "utf8");
  return [
    `${green("hired")} ${id} at office/agents/${id}.md`,
    autonomy === "ask"
      ? dim("  Starts at autonomy \"ask\": every write comes back to you. Promote it once you have read a few diffs.")
      : yellow(`  Starts at autonomy "${autonomy}". You are trusting an agent you have not watched work yet.`),
  ].join("\n");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
