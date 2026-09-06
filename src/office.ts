import { resolve } from "node:path";
import { Paths } from "./paths.js";
import { loadConfig, type OfficeConfig } from "./config.js";
import { loadRoles } from "./agents/registry.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryIndex } from "./memory/search.js";
import { Mailbox } from "./mail/mailbox.js";
import { Router } from "./mail/router.js";
import { Ledger } from "./budget/ledger.js";
import { EscalationStore } from "./gate/policy.js";
import { WorktreeManager } from "./workspace/worktree.js";
import { ClaudeCliDriver, FakeDriver, type Driver } from "./runner/driver.js";
import { readJson, nowIso, writeJsonAtomic, Mutex } from "./util.js";
import type { AgentState, Brief, Role, Task } from "./types.js";

/** Everything the floor needs, wired once and passed around. */
export class Office {
  readonly paths: Paths;
  readonly memory: MemoryStore;
  readonly index: MemoryIndex;
  readonly mail: Mailbox;
  readonly router: Router;
  readonly ledger: Ledger;
  readonly escalations: EscalationStore;
  readonly worktrees: WorktreeManager;
  readonly driver: Driver;
  private readonly taskWrites = new Mutex();

  private constructor(readonly root: string, readonly config: OfficeConfig, readonly roles: Map<string, Role>, driver?: Driver) {
    this.paths = new Paths(root);
    this.memory = new MemoryStore(this.paths);
    this.index = new MemoryIndex(this.paths, this.memory);
    this.mail = new Mailbox(this.paths);
    this.router = new Router(this.paths);
    this.ledger = new Ledger(this.paths.ledger, config.budget);
    this.escalations = new EscalationStore(this.paths);
    this.worktrees = new WorktreeManager(resolve(root, config.repo), this.paths);
    this.driver = driver ?? (config.driver === "fake" ? new FakeDriver() : new ClaudeCliDriver());
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

  agentIds(): string[] {
    return [...this.roles.keys()];
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

  async briefs(): Promise<Brief[]> {
    return readJson<Brief[]>(this.paths.briefs, []);
  }

  async saveBriefs(briefs: Brief[]): Promise<void> {
    await writeJsonAtomic(this.paths.briefs, briefs);
  }
}
