import { nowIso } from "../util.js";
import type { Office } from "../office.js";
import type { AgentState, Task, Tier } from "../types.js";
import { buildSystemPrompt } from "./prompt.js";
import { applyObservation, evaluateBreaker, type BreakerDecision } from "../gate/breaker.js";
import { needsApproval } from "../gate/policy.js";
import { capTier } from "../budget/ledger.js";
import type { TurnResult } from "../runner/driver.js";

export interface TurnOutcome {
  ran: boolean;
  result?: TurnResult;
  /** Set when the turn did not run, or ran and then hit the gate. */
  blockedBy?: string;
  escalationId?: string;
  breakerStage: 0 | 1 | 2 | 3;
  touchedFiles: string[];
}

export interface TurnOptions {
  /**
   * Which of the desk's two threads this turn belongs to. "chat" resumes the
   * conversation session and is judged differently: see the breaker note below.
   */
  thread?: "work" | "chat";
  /** Ceiling on the tier, whatever the role asks for. */
  maxTier?: Tier;
  /** Override the role's tool lists, e.g. to keep a chat turn read-only. */
  allowedTools?: string[];
  disallowedTools?: string[];
  timeoutMs?: number;
}

/**
 * One agent, one turn.
 *
 * The order matters. Budget is checked before spawning, because the cheapest
 * turn is the one you do not start. The gate is checked after, because you
 * cannot know what an agent touched until it has touched it -- the worktree is
 * the containment, and the gate decides whether the work leaves it.
 */
export async function runTurn(office: Office, agentId: string, task: Task | null, instruction: string, opts: TurnOptions = {}): Promise<TurnOutcome> {
  const role = office.role(agentId);
  const state = await office.state(agentId);
  const chat = opts.thread === "chat";

  if (state.status === "parked") {
    return { ran: false, blockedBy: `${agentId} is parked by the circuit breaker; run \`office revive ${agentId}\``, breakerStage: 3, touchedFiles: [] };
  }

  const requestedTier = capTier(state.tierOverride ?? role.tier, opts.maxTier);
  const verdict = await office.ledger.check(role.provider, requestedTier);
  if (!verdict.allow) {
    return { ran: false, blockedBy: verdict.reason, breakerStage: state.breakerStage, touchedFiles: [] };
  }

  // Persist "working" before spawning, not after. The agent runs `office done`
  // and `office escalate` from inside its own turn, and both need to know which
  // task they belong to -- a state written afterwards is written too late. A
  // chat turn keeps whatever task the desk was already on: answering a question
  // in the channel does not mean it stopped working.
  await office.saveState({ ...state, status: "working", currentTaskId: chat ? state.currentTaskId : task?.id });

  const cwd = await office.worktrees.ensure(agentId);
  await office.syncBrief(cwd);
  const before = await office.worktrees.touchedFiles(agentId);
  const outboxBefore = (await office.mail.outbox(agentId)).length;

  // Mail is work, and a chat turn cannot answer it: no shell, no `office
  // inbox`. Showing it would only pull the reply off the subject of the room.
  const inbox = chat ? [] : await office.mail.inbox(agentId, { unreadOnly: true });
  const systemPrompt = buildSystemPrompt({
    role,
    chat,
    memoryBrief: await office.memory.brief(agentId),
    inbox,
    steer: state.breakerStage === 1 ? lastSteer(state.recentFingerprints.length) : undefined,
    budgetNote: verdict.tier !== requestedTier
      ? `${verdict.reason}. Prefer the smallest change that finishes the task.`
      : undefined,
  });

  const result = await office.driverFor(role.provider).run({
    agent: agentId,
    prompt: instruction,
    systemPrompt,
    cwd,
    tier: verdict.tier,
    model: office.modelFor(role.provider, verdict.tier),
    autonomy: role.autonomy,
    sessionId: chat ? undefined : resumable(state, task),
    allowedTools: opts.allowedTools ?? role.allowedTools,
    disallowedTools: opts.disallowedTools ?? role.disallowedTools,
    timeoutMs: opts.timeoutMs ?? office.config.defaults.turnTimeoutMs,
    addDirs: [office.paths.agent(agentId)],
    env: { OFFICE_AGENT: agentId, OFFICE_ROOT: office.root },
  });

  await office.ledger.record({
    at: nowIso(),
    agent: agentId,
    taskId: task?.id,
    provider: role.provider,
    model: result.model,
    tier: verdict.tier,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheCreationTokens: result.cacheCreationTokens,
    durationMs: result.durationMs,
    turns: result.turns,
    ok: result.ok,
  });

  const after = await office.worktrees.touchedFiles(agentId);
  const touchedFiles = after.filter((f) => !before.includes(f));
  const mailSent = (await office.mail.outbox(agentId)).length - outboxBefore;

  const observation = {
    output: result.text || result.error || "",
    touchedFiles,
    mailSent: Math.max(0, mailSent),
    turnsOnTask: (task?.attempts ?? 0) + 1,
  };
  // A chat turn is not judged by the breaker. The breaker calls a turn that
  // touched no file and sent no mail a turn going nowhere, which is exactly
  // what a conversation looks like -- four replies in the channel would
  // otherwise park the desk for talking.
  const decision: BreakerDecision = chat
    ? { stage: state.breakerStage, reason: "chat turn", changed: false }
    : evaluateBreaker(state, observation, requestedTier);
  // A session the CLI will not resume is worse than no session: kept, it fails
  // every future turn on this desk the same way, and the desk looks dead.
  // Forgetting it costs the thread and nothing else.
  const thread = (stored?: string) => (result.sessionLost ? undefined : result.sessionId ?? stored);
  const next: AgentState = chat
    ? { ...state, chatSessionId: undefined, updatedAt: nowIso() }
    : applyObservation(
        { ...state, sessionId: thread(state.sessionId), sessionTaskId: task?.id, currentTaskId: task?.id },
        observation,
        decision,
      );

  const gate = needsApproval(role, { touchedFiles, costUsd: result.costUsd }, office.config.providers[role.provider].escalateAboveUsdPerTask);
  let escalationId: string | undefined;
  if (gate.required) {
    const escalation = await office.escalations.raise({
      agent: agentId,
      taskId: task?.id,
      kind: gate.kind ?? "explicit",
      summary: `${agentId}: ${gate.kind} on ${task?.title ?? "an ad-hoc turn"}`,
      detail: gate.detail,
    });
    escalationId = escalation.id;
    next.status = "blocked";
  } else if (chat) {
    next.status = state.status;
  } else if (decision.stage < 3) {
    next.status = "idle";
  }

  await office.saveState(next);

  if ((!chat && decision.stage >= 2) || gate.required) {
    await office.memory.remember(
      agentId,
      gate.required ? `Turn held for review: ${gate.detail}` : `Circuit breaker at stage ${decision.stage}: ${decision.reason}`,
      gate.required ? "gate" : "breaker",
    );
  }

  return {
    ran: true,
    result,
    blockedBy: gate.required ? gate.detail : decision.stage === 3 ? decision.reason : undefined,
    escalationId,
    breakerStage: decision.stage,
    touchedFiles,
  };
}

/**
 * The work thread, but only within one task.
 *
 * A session resumed forever is a context that grows forever, and it is re-read
 * on every turn after it: the measured floor spent most of its money on cache
 * reads of a session nobody had pruned, against fresh input of a few dozen
 * tokens. Task instructions are written to stand alone, so a new task is the
 * natural place to start a new thread -- continuity inside a task is kept, the
 * accumulation across unrelated tasks is not.
 */
function resumable(state: AgentState, task: Task | null): string | undefined {
  if (!state.sessionId) return undefined;
  return state.sessionTaskId === task?.id ? state.sessionId : undefined;
}

function lastSteer(_n: number): string {
  return (
    "Your previous turns did not move anything. State what is blocking you in one " +
    "sentence, then either mail the agent who can unblock you or escalate. Do not " +
    "retry the same approach."
  );
}
