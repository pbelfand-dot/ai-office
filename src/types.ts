/** Core domain types for the office. */

/**
 * Which CLI, and therefore which subscription, a desk draws on.
 *
 * This is the axis the whole budget is organised around. Two agents on the same
 * provider share one allowance; two on different providers do not, and that is
 * the only way to get more concurrency without paying for more of one plan.
 */
export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Tiers, cheapest first, as an abstraction over both providers' model names.
 * The scheduler demotes along this ladder; office.config.json maps each rung to
 * a real model per provider.
 */
export const TIERS = ["small", "mid", "large"] as const;
export type Tier = (typeof TIERS)[number];

export type AgentStatus =
  | "idle"
  | "queued"
  | "working"
  | "blocked" // waiting on a human decision
  | "parked"; // circuit breaker stopped it

/** A role definition, authored as markdown in office/agents/<id>.md. */
export interface Role {
  id: string;
  name: string;
  title: string;
  /** Which CLI runs this desk, and so which allowance it spends. */
  provider: Provider;
  /** Model tier this role runs at by default. */
  tier: Tier;
  /** Glob-ish path prefixes this agent may write to. Empty = whole repo. */
  scope: string[];
  /** Tool names to hand the CLI via --allowedTools. Empty = CLI default. */
  allowedTools: string[];
  /** Tool names to deny via --disallowedTools. */
  disallowedTools: string[];
  /** How much rope: what this agent may do before a human sees it. */
  autonomy: Autonomy;
  /**
   * A hidden desk is staff, not a colleague: it never appears on the roster,
   * the planner never assigns to it, and it is not a participant in the chat.
   * The router is one, because a group chat with the router in it is a group
   * chat you have to talk around.
   */
  hidden: boolean;
  /** The briefing, i.e. the markdown body of the role file. */
  briefing: string;
}

/**
 * Autonomy is not a vibe, it is a set of gates.
 * - "ask": every write escalates. Good for a new role you do not trust yet.
 * - "scoped": writes inside `scope` are free, anything outside escalates.
 * - "trusted": writes are free, only destructive ops and spend escalate.
 */
export type Autonomy = "ask" | "scoped" | "trusted";

export interface Message {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Set when this message is a reply, so threads can be reconstructed. */
  inReplyTo?: string;
  /** Task this message belongs to, if any. */
  taskId?: string;
  sentAt: string;
  readAt?: string;
}

/** The id every chat message from you carries. Agents use their own. */
export const HUMAN = "human";
/** Messages the office writes about itself: a failed reply, a dropped turn. */
export const SYSTEM = "system";

/**
 * One line in a channel, readable by everyone on the floor.
 *
 * Deliberately not a `Message`. Mail is addressed to one agent and moves
 * through outbox -> inbox -> archive; a channel line is addressed to the room
 * and never changes once written, so it is a log, not a queue.
 */
export interface ChatMessage {
  id: string;
  channel: string;
  /** An agent id, or HUMAN, or SYSTEM. */
  from: string;
  body: string;
  at: string;
  /** The message this one answers, so replies group under what prompted them. */
  replyTo?: string;
}

export type TaskState = "pending" | "assigned" | "running" | "done" | "failed" | "blocked";

export interface Task {
  id: string;
  briefId: string;
  title: string;
  /** The instruction handed to the agent verbatim. */
  instruction: string;
  assignee: string;
  state: TaskState;
  /** Task ids that must reach "done" before this one may start. */
  dependsOn: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  lastError?: string;
  /** Free-form result summary written back by the agent. */
  result?: string;
}

export interface Brief {
  id: string;
  text: string;
  createdAt: string;
  tasks: string[];
}

/** One accounting row per CLI turn. Appended to .office/ledger.jsonl. */
export interface LedgerEntry {
  at: string;
  agent: string;
  taskId?: string;
  /** Absent on rows written before the office knew about a second provider. */
  provider?: Provider;
  model: string;
  tier: Tier;
  /** USD as reported by the CLI. On a subscription this is notional, not billed. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  turns: number;
  ok: boolean;
}

export type EscalationKind =
  | "out-of-scope"
  | "destructive"
  | "spend"
  | "breaker"
  | "explicit";

export interface Escalation {
  id: string;
  agent: string;
  taskId?: string;
  kind: EscalationKind;
  summary: string;
  detail: string;
  raisedAt: string;
  decidedAt?: string;
  decision?: "approve" | "deny";
  note?: string;
}

export interface AgentState {
  id: string;
  status: AgentStatus;
  /** Claude Code session id, so the agent keeps one continuous thread. */
  sessionId?: string;
  /**
   * The agent's *conversation* thread, kept apart from its work thread. An
   * afternoon of chat should not be the context a task starts from, and a
   * half-finished refactor should not be what it remembers in the channel.
   */
  chatSessionId?: string;
  currentTaskId?: string;
  /** Circuit breaker stage: 0 none, 1 steer, 2 constrain, 3 stop. */
  breakerStage: 0 | 1 | 2 | 3;
  /** Rolling fingerprints of recent turns, for loop detection. */
  recentFingerprints: string[];
  /** Turns since anything observable changed (files touched or mail sent). */
  idleTurns: number;
  /** Tier override applied by the breaker, if any. */
  tierOverride?: Tier;
  updatedAt: string;
}
