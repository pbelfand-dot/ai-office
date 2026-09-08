import { resolve } from "node:path";
import { Paths } from "./paths.js";
import { loadConfig, type OfficeConfig } from "./config.js";
import { loadRoles } from "./agents/registry.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryIndex } from "./memory/search.js";
import { Mailbox } from "./mail/mailbox.js";
import { Router } from "./mail/router.js";
import { ChatStore } from "./chat/store.js";
import { Ledger } from "./budget/ledger.js";
import { EscalationStore } from "./gate/policy.js";
import { WorktreeManager } from "./workspace/worktree.js";
import { FakeDriver, driverFor, modelFor, type Driver } from "./runner/driver.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, nowIso, writeJsonAtomic, Mutex } from "./util.js";
import type { AgentState, Brief, Provider, Role, Task, Tier } from "./types.js";

/** Everything the floor needs, wired once and passed around. */
export class Office {
  readonly paths: Paths;
  readonly memory: MemoryStore;
  readonly index: MemoryIndex;
  readonly mail: Mailbox;
  readonly router: Router;
  readonly chat: ChatStore;
  readonly ledger: Ledger;
  readonly escalations: EscalationStore;
  readonly worktrees: WorktreeManager;
  private readonly drivers = new Map<Provider, Driver>();
  private readonly forcedDriver?: Driver;
  private readonly taskWrites = new Mutex();

  private constructor(readonly root: string, readonly config: OfficeConfig, readonly roles: Map<string, Role>, driver?: Driver) {
    this.paths = new Paths(root);
    this.memory = new MemoryStore(this.paths);
    this.index = new MemoryIndex(this.paths, this.memory);
    this.mail = new Mailbox(this.paths);
    this.router = new Router(this.paths);
    this.chat = new ChatStore(this.paths);
    this.ledger = new Ledger(this.paths.ledger, config);
    this.escalations = new EscalationStore(this.paths);
    this.worktrees = new WorktreeManager(resolve(root, config.repo), this.paths);
    this.forcedDriver = driver ?? (config.driver === "fake" ? new FakeDriver() : undefined);
  }

  /**
   * The CLI that runs a given provider's desks.
   *
   * A driver passed to `open` overrides every provider, which is how tests run
   * a whole two-provider floor without either binary installed.
   */
  driverFor(provider: Provider): Driver {
    if (this.forcedDriver) return this.forcedDriver;
    let driver = this.drivers.get(provider);
    if (!driver) {
      driver = driverFor(this.config, provider);
      this.drivers.set(provider, driver);
    }
    return driver;
  }

  modelFor(provider: Provider, tier: Tier): string | undefined {
    return modelFor(this.config, provider, tier);
  }

  static async open(root = process.cwd(), driver?: Driver): Promise<Office> {
    const paths = new Paths(root);
    const config = await loadConfig(paths.config);
    const roles = await loadRoles(paths.rolesDir, config.defaults);
    return new Office(root, config, roles, driver);
  }

  role(id: string): Role {
    const role = this.roles.get(id);
    if (!role) {
      const known = [...this.roles.keys()].join(", ") || "nobody yet -- run `office hire`";
      throw new Error(`no agent named "${id}". On the floor: ${known}`);
    }
    return role;
  }

  /**
   * The desks on the floor: everyone the planner can assign to, mail can reach,
   * and the chat can see. Hidden roles -- the router -- are staff and are
   * addressed by id where they are needed, never listed as colleagues.
   */
  agentIds(): string[] {
    return [...this.roles.values()].filter((role) => !role.hidden).map((role) => role.id);
  }

  async state(id: string): Promise<AgentState> {
    return readJson<AgentState>(this.paths.agentState(id), {
      id, status: "idle", breakerStage: 0, recentFingerprints: [], idleTurns: 0, updatedAt: nowIso(),
    });
  }

  async saveState(state: AgentState): Promise<void> {
    await this.paths.ensureAgent(state.id);
    await writeJsonAtomic(this.paths.agentState(state.id), { ...state, updatedAt: nowIso() });
  }

  async tasks(): Promise<Task[]> {
    return readJson<Task[]>(this.paths.tasks, []);
  }

  async saveTasks(tasks: Task[]): Promise<void> {
    await writeJsonAtomic(this.paths.tasks, tasks);
  }

  /** Serialised: the scheduler calls this from several agents in the same tick. */
  async upsertTask(task: Task): Promise<void> {
    await this.taskWrites.run(async () => {
      const tasks = await this.tasks();
      const i = tasks.findIndex((t) => t.id === task.id);
      if (i === -1) tasks.push(task);
      else tasks[i] = task;
      await this.saveTasks(tasks);
    });
  }

  /**
   * Put the floor's shared context where the desks can actually read it.
   *
   * Every desk works in a git worktree checked out from HEAD, so a file you
   * have written but not committed does not exist as far as they are
   * concerned -- and business.md is exactly the file you edit constantly and
   * commit rarely. The desks then ask you for what you already told them.
   * Copied rather than committed on your behalf: what goes in your history is
   * your decision, not a side effect of asking a question.
   */
  async syncBrief(worktree: string): Promise<void> {
    const name = this.config.brief;
    if (!name) return;
    try {
      const source = await readFile(resolve(this.root, this.config.repo, name), "utf8");
      const target = join(worktree, name);
      if (await readFile(target, "utf8").catch(() => null) === source) return;
      await writeFile(target, source, "utf8");
    } catch {
      // No brief written yet, or unreadable. The desks will say which blank
      // stopped them, which is the same outcome and a better message.
    }
  }

  /**
   * Append what the owner just told the room to the file the floor reads.
   *
   * Otherwise every fact said in chat is lost the moment the transcript rolls
   * past it, and the desks ask again next week. Appended under a heading of
   * their own and never woven into what the owner wrote: this file is his, and
   * a tool that edits your words in place is one you stop trusting to hold
   * them. Deduped, because the same fact said twice is still one fact.
   */
  async recordToBrief(facts: string[]): Promise<string[]> {
    const name = this.config.brief;
    if (!name || facts.length === 0) return [];

    const path = resolve(this.root, this.config.repo, name);
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === null) return [];

    // Deduped against the file and against the rest of this batch: a model
    // asked for facts will happily list the same one twice.
    const seen = new Set([current.toLowerCase()]);
    const fresh: string[] = [];
    for (const raw of facts) {
      const fact = raw.trim();
      if (!fact) continue;
      const key = fact.toLowerCase();
      if (current.toLowerCase().includes(key) || seen.has(key)) continue;
      seen.add(key);
      fresh.push(fact);
    }
    if (fresh.length === 0) return [];

    const heading = "## Recorded from the room";
    const lines = fresh.map((f) => `- ${f} _(${new Date().toISOString().slice(0, 10)})_`).join("\n");
    const next = current.includes(heading)
      ? current.replace(heading, `${heading}\n\n${lines}`)
      : `${current.replace(/\s*$/, "")}\n\n${heading}\n\nFacts the floor was told and wrote down. Move them into the sections above\nwhen you get a chance -- they count either way.\n\n${lines}\n`;

    await writeFile(path, next, "utf8");
    return fresh;
  }

  async briefs(): Promise<Brief[]> {
    return readJson<Brief[]>(this.paths.briefs, []);
  }

  async saveBriefs(briefs: Brief[]): Promise<void> {
    await writeJsonAtomic(this.paths.briefs, briefs);
  }
}
