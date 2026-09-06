import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Office } from "../office.js";
import type { Escalation, Message, Provider, Task } from "../types.js";
import { weigh, providerOf } from "../budget/ledger.js";
import { enabledProviders } from "../config.js";

export interface DeskView {
  id: string;
  name: string;
  title: string;
  provider: Provider;
  tier: string;
  effectiveTier: string;
  autonomy: string;
  scope: string[];
  status: string;
  breakerStage: number;
  idleTurns: number;
  unread: number;
  currentTask: { id: string; title: string } | null;
  branch: string | null;
  dirty: boolean;
  lastNote: { at: string; tag?: string; text: string } | null;
  turnsToday: number;
  weightedToday: number;
}

export interface PoolView {
  provider: Provider;
  maxConcurrent: number;
  windowHours: number;
  softStopPct: number;
  window: { used: number; limit: number; pct: number };
  week: { used: number; limit: number; pct: number };
  costUsd: number;
  turns: number;
}

export interface FloorSnapshot {
  now: string;
  plan: string;
  desks: DeskView[];
  /** One per enabled provider. Separate allowances, shown separately. */
  pools: PoolView[];
  tasks: Task[];
  escalations: Escalation[];
  /** Recent messages, so the client can fly an envelope for ones it has not seen. */
  mail: (Message & { delivered: boolean })[];
  /** One point per turn, newest last, for the burn sparkline. */
  burn: { at: string; agent: string; provider: Provider; tier: string; weighted: number; ok: boolean }[];
}

const RECENT_MAIL_MS = 5 * 60_000;
const MAIL_PER_BOX = 30;

/**
 * One read of everything the floor knows, shaped for a browser.
 *
 * Built fresh on every request rather than kept in memory: the state on disk is
 * the truth, and agents write to it from their own processes. A cached view
 * would drift the moment an agent finished a turn outside this process.
 */
export async function snapshot(office: Office): Promise<FloorSnapshot> {
  const [tasks, escalations, ledger] = await Promise.all([
    office.tasks(),
    office.escalations.list(),
    office.ledger.entries(),
  ]);

  const pools: PoolView[] = [];
  for (const provider of enabledProviders(office.config)) {
    const b = office.config.providers[provider];
    const [window, week] = await Promise.all([
      office.ledger.windowUsage(provider),
      office.ledger.weeklyUsage(provider),
    ]);
    pools.push({
      provider,
      maxConcurrent: b.maxConcurrentAgents,
      windowHours: b.windowHours,
      softStopPct: b.softStopPct,
      window: { used: window.weightedTokens, limit: b.windowTokenBudget, pct: window.weightedTokens / b.windowTokenBudget },
      week: { used: week.weightedTokens, limit: b.weeklyTokenBudget, pct: week.weightedTokens / b.weeklyTokenBudget },
      costUsd: week.costUsd,
      turns: week.turns,
    });
  }

  const dayAgo = Date.now() - 24 * 3_600_000;
  const desks: DeskView[] = [];

  for (const id of office.agentIds()) {
    const role = office.role(id);
    const [state, unread, info, journal] = await Promise.all([
      office.state(id),
      office.mail.inbox(id, { unreadOnly: true }),
      office.worktrees.info(id).catch(() => null),
      office.memory.journal(id),
    ]);

    const current = tasks.find((t) => t.assignee === id && (t.state === "running" || t.state === "assigned")) ?? null;
    const mine = ledger.filter((e) => e.agent === id && Date.parse(e.at) >= dayAgo);
    const last = journal.at(-1);

    desks.push({
      id,
      name: role.name,
      title: role.title,
      provider: role.provider,
      tier: role.tier,
      effectiveTier: state.tierOverride ?? role.tier,
      autonomy: role.autonomy,
      scope: role.scope,
      status: state.status,
      breakerStage: state.breakerStage,
      idleTurns: state.idleTurns,
      unread: unread.length,
      currentTask: current ? { id: current.id, title: current.title } : null,
      branch: info?.branch ?? null,
      dirty: info?.dirty ?? false,
      lastNote: last ? { at: last.at, tag: last.tag, text: last.text } : null,
      turnsToday: mine.length,
      weightedToday: mine.reduce((sum, e) => sum + weigh(e), 0),
    });
  }

  return {
    now: new Date().toISOString(),
    plan: office.config.plan,
    desks,
    pools,
    tasks,
    escalations,
    mail: await recentMail(office),
    burn: ledger.slice(-60).map((e) => ({ at: e.at, agent: e.agent, provider: providerOf(e), tier: e.tier, weighted: weigh(e), ok: e.ok })),
  };
}

/**
 * Messages from the last few minutes, wherever they currently sit.
 *
 * Undelivered ones are still in a sender's outbox; delivered ones have moved to
 * an inbox or been archived. The client only needs enough to animate the ones
 * it has not drawn yet, so the archive is sampled rather than read whole --
 * message ids sort roughly by time, which is enough to take the newest.
 */
async function recentMail(office: Office): Promise<(Message & { delivered: boolean })[]> {
  const cutoff = Date.now() - RECENT_MAIL_MS;
  const out: (Message & { delivered: boolean })[] = [];

  for (const id of office.agentIds()) {
    for (const [dir, delivered] of [
      [office.paths.outbox(id), false],
      [office.paths.inbox(id), true],
      [office.paths.archive(id), true],
    ] as const) {
      for (const msg of await readBox(dir)) {
        if (Date.parse(msg.sentAt) >= cutoff) out.push({ ...msg, delivered });
      }
    }
  }

  const seen = new Set<string>();
  return out
    .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)))
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}

async function readBox(dir: string): Promise<Message[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().slice(-MAIL_PER_BOX);
  } catch {
    return [];
  }
  const out: Message[] = [];
  for (const file of files) {
    try {
      out.push(JSON.parse(await readFile(join(dir, file), "utf8")) as Message);
    } catch {
      continue;
    }
  }
  return out;
}
