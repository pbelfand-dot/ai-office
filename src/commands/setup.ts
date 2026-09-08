import { mkdir, writeFile, access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Paths } from "../paths.js";
import { defaultConfig, saveConfig, type CodexPlan, type Plan } from "../config.js";
import { floors } from "../agents/floors.js";
import { bold, dim, green, yellow } from "./format.js";

export interface InitOptions {
  root: string;
  plan: Plan;
  codexPlan: CodexPlan;
  force: boolean;
  seed: boolean;
  /** Which staffing template to hire. See `floors()`. */
  floor: string;
}

export async function init(opts: InitOptions): Promise<string> {
  const paths = new Paths(opts.root);
  const lines: string[] = [];

  if (!opts.force && (await exists(paths.config))) {
    throw new Error(`${paths.config} already exists. Pass --force to overwrite it.`);
  }

  const available = floors(opts.codexPlan !== "none");
  const floor = available[opts.floor];
  if (!floor) {
    throw new Error(`no floor called "${opts.floor}". Available: ${Object.keys(available).join(", ")}`);
  }

  const config = { ...defaultConfig(opts.plan, opts.codexPlan), router: floor.router, orchestrator: floor.orchestrator, brief: floor.brief?.path ?? "" };
  await saveConfig(paths.config, config);
  await paths.ensureOffice();
  await mkdir(paths.rolesDir, { recursive: true });
  lines.push(`${green("created")} office.config.json ${dim(`(claude ${opts.plan}${opts.codexPlan === "none" ? "" : `, codex ${opts.codexPlan}`})`)}`);

  if (opts.seed) {
    for (const [id, source] of Object.entries(floor.roles)) {
      const path = join(paths.rolesDir, `${id}.md`);
      if (!opts.force && (await exists(path))) {
        lines.push(`${dim("kept")}    office/agents/${id}.md`);
        continue;
      }
      await writeFile(path, source, "utf8");
      const title = /^title:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? "Staff";
      const note = /^hidden:\s*true$/m.test(source)
        ? "hidden: routes the chat, never in it"
        : id === floor.router ? `${title} -- reads everything, decides who acts` : title;
      lines.push(`${green("hired")}   ${id} ${dim(note)}`);
    }
  }

  // Re-hiring one floor over another leaves the old desks standing: they still
  // load, still get routed to, still bill. Only ones that are byte-identical to
  // what we seeded are let go -- anything you have edited is yours, and a tool
  // that silently deletes your writing is not one you can trust with --force.
  if (opts.seed) {
    for (const [name, other] of Object.entries(available)) {
      if (name === opts.floor) continue;
      for (const [id, source] of Object.entries(other.roles)) {
        if (floor.roles[id]) continue;
        const path = join(paths.rolesDir, `${id}.md`);
        const current = await read(path);
        if (current === null) continue;
        if (current === source) {
          await rm(path);
          lines.push(`${dim("let go")}  ${id} ${dim(`(was on the ${name} floor)`)}`);
        } else {
          lines.push(`${yellow("kept")}    ${id} ${dim("-- you edited this desk, so it stays. Delete it yourself if it should go.")}`);
        }
      }
    }
  }

  // .office holds a git worktree per desk. Committed by accident it turns every
  // `git add -A` into a warning about embedded repositories, and the state that
  // is meant to be disposable becomes history you have to clean up.
  const ignore = join(opts.root, ".gitignore");
  const ignored = (await read(ignore)) ?? "";
  if (!ignored.split("\n").some((line) => line.trim().replace(/\/$/, "") === ".office")) {
    const spacer = ignored && !ignored.endsWith("\n") ? "\n" : "";
    await writeFile(ignore, `${ignored}${spacer}\n# the office's own state: worktrees, ledger, chat\n.office/\n`, "utf8");
    lines.push(`${green("ignored")} .office/ ${dim("-- runtime state, not something to commit")}`);
  }

  // Never overwritten, not even by --force. --force is about this tool's own
  // files: the config and the desks it seeded. What is written here is the
  // owner's answers about their business, and re-running setup is not consent
  // to throw those away.
  if (floor.brief) {
    const path = join(opts.root, floor.brief.path);
    if (await exists(path)) {
      lines.push(`${dim("kept")}    ${floor.brief.path} ${dim("-- your answers, left alone")}`);
    } else {
      await writeFile(path, floor.brief.body, "utf8");
      lines.push(`${green("created")} ${floor.brief.path} ${dim("-- fill this in; every desk reads it first")}`);
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
  // Chat first, briefs second: talking to the floor costs one cheap turn and
  // tells you whether these desks understand your repo at all. A brief commits
  // the whole queue to that answer before you have any reason to trust it.
  lines.push(
    `${yellow("Next")}: ${dim('office chat "<anything>"')} to talk to the floor, ` +
    `${dim("office serve")} for the room in a browser,\n` +
    `      or ${dim('office brief "<what you want done>"')} once you want work queued.`,
  );
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

async function read(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
