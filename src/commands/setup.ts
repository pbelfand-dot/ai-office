import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Paths } from "../paths.js";
import { defaultConfig, saveConfig, type CodexPlan, type Plan } from "../config.js";
import { defaultRoles } from "../agents/defaults.js";
import { bold, dim, green, yellow } from "./format.js";

export interface InitOptions {
  root: string;
  plan: Plan;
  codexPlan: CodexPlan;
  force: boolean;
  seed: boolean;
}

export async function init(opts: InitOptions): Promise<string> {
  const paths = new Paths(opts.root);
  const lines: string[] = [];

  if (!opts.force && (await exists(paths.config))) {
    throw new Error(`${paths.config} already exists. Pass --force to overwrite it.`);
  }

  const config = defaultConfig(opts.plan, opts.codexPlan);
  await saveConfig(paths.config, config);
  await paths.ensureOffice();
  await mkdir(paths.rolesDir, { recursive: true });
  lines.push(`${green("created")} office.config.json ${dim(`(claude ${opts.plan}${opts.codexPlan === "none" ? "" : `, codex ${opts.codexPlan}`})`)}`);

  if (opts.seed) {
    const roles = defaultRoles(config.providers.codex.enabled ? "codex" : undefined);
    for (const [id, source] of Object.entries(roles)) {
      const path = join(paths.rolesDir, `${id}.md`);
      if (!opts.force && (await exists(path))) {
        lines.push(`${dim("kept")}    office/agents/${id}.md`);
        continue;
      }
      await writeFile(path, source, "utf8");
      const on = /provider:\s*(\w+)/.exec(source)?.[1] ?? "claude";
      lines.push(`${green("hired")}   ${id} ${dim(`on ${on}`)}`);
    }
  }

  lines.push("");
  lines.push(bold("The number that matters"));
  const claude = config.providers.claude;
  const codex = config.providers.codex;
  lines.push(
    `  Concurrency is capped per provider: ${bold(String(claude.maxConcurrentAgents))} on claude` +
    (codex.enabled ? `, ${bold(String(codex.maxConcurrentAgents))} on codex` : "") + `.\n` +
    `  Every agent on a provider signs in as the same subscription, so more desks on\n` +
    `  one provider do not buy more capacity -- they spend the same capacity faster.\n` +
    `  Desks on a different provider draw on a different allowance, which is the only\n` +
    `  way to add concurrency without buying more of one plan.`,
  );
  if (!codex.enabled) {
    lines.push("");
    lines.push(dim("  Already paying for ChatGPT? `office init --codex-plan plus` turns on a"));
    lines.push(dim("  second pool you are not currently using."));
  }
  lines.push("");
  lines.push(`${yellow("Next")}: ${dim("office roster")}, then ${dim('office brief "<what you want done>"')}`);
  return lines.join("\n");
}

export async function hire(root: string, id: string, opts: { title?: string; tier?: string; autonomy?: string; scope?: string[]; provider?: string }): Promise<string> {
  const paths = new Paths(root);
  const path = join(paths.rolesDir, `${id}.md`);
  if (await exists(path)) throw new Error(`${id} already has a desk at office/agents/${id}.md`);

  const scope = opts.scope?.length ? opts.scope : ["src/"];
  const autonomy = opts.autonomy ?? "ask";
  const body = [
    "---",
    `name: ${id.charAt(0).toUpperCase()}${id.slice(1)}`,
    `title: ${opts.title ?? "Staff"}`,
    `provider: ${opts.provider ?? "claude"}`,
    `tier: ${opts.tier ?? "mid"}`,
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
