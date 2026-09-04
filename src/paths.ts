import { join } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Everything the office remembers lives under .office/ in the repo root.
 * It is gitignored on purpose: it is state, not source.
 */
export class Paths {
  constructor(readonly root: string) {}

  get office() { return join(this.root, ".office"); }
  get config() { return join(this.root, "office.config.json"); }
  get rolesDir() { return join(this.root, "office", "agents"); }
  get ledger() { return join(this.office, "ledger.jsonl"); }
  get tasks() { return join(this.office, "tasks.json"); }
  get briefs() { return join(this.office, "briefs.json"); }
  get escalations() { return join(this.office, "escalations"); }
  get worktrees() { return join(this.office, "worktrees"); }
  get logs() { return join(this.office, "logs"); }

  agent(id: string) { return join(this.office, "agents", id); }
  agentState(id: string) { return join(this.agent(id), "state.json"); }
  inbox(id: string) { return join(this.agent(id), "inbox"); }
  outbox(id: string) { return join(this.agent(id), "outbox"); }
  archive(id: string) { return join(this.agent(id), "archive"); }
  memoryDir(id: string) { return join(this.agent(id), "memory"); }
  journal(id: string) { return join(this.memoryDir(id), "journal.md"); }
  facts(id: string) { return join(this.memoryDir(id), "facts.md"); }
  worktree(id: string) { return join(this.worktrees, id); }
  log(id: string) { return join(this.logs, `${id}.log`); }

  /** Create the directory tree an agent needs. Idempotent. */
  async ensureAgent(id: string): Promise<void> {
    await Promise.all([
      mkdir(this.inbox(id), { recursive: true }),
      mkdir(this.outbox(id), { recursive: true }),
      mkdir(this.archive(id), { recursive: true }),
      mkdir(this.memoryDir(id), { recursive: true }),
    ]);
  }

  async ensureOffice(): Promise<void> {
    await Promise.all([
      mkdir(this.office, { recursive: true }),
      mkdir(this.escalations, { recursive: true }),
      mkdir(this.worktrees, { recursive: true }),
      mkdir(this.logs, { recursive: true }),
    ]);
  }
}
