/** Core domain types for the office. */

/** Model tiers, cheapest first. The scheduler demotes along this ladder. */
export const TIERS = ["haiku", "sonnet", "opus"] as const;
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
