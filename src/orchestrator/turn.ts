import { nowIso } from "../util.js";
import type { Office } from "../office.js";
import type { Task } from "../types.js";
import { buildSystemPrompt } from "./prompt.js";
import { applyObservation, evaluateBreaker } from "../gate/breaker.js";
import { needsApproval } from "../gate/policy.js";
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

/**
 * One agent, one turn.
 *
 * The order matters. Budget is checked before spawning, because the cheapest
 * turn is the one you do not start. The gate is checked after, because you
 * cannot know what an agent touched until it has touched it -- the worktree is
 * the containment, and the gate decides whether the work leaves it.
 */
export async function runTurn(office: Office, agentId: string, task: Task | null, instruction: string): Promise<TurnOutcome> {
  const role = office.role(agentId);
  const state = await office.state(agentId);

  if (state.status === "parked") {
    return { ran: false, blockedBy: `${agentId} is parked by the circuit breaker; run \`office revive ${agentId}\``, breakerStage: 3, touchedFiles: [] };
  }

  const requestedTier = state.tierOverride ?? role.tier;
  const verdict = await office.ledger.check(requestedTier);
  if (!verdict.allow) {
    return { ran: false, blockedBy: verdict.reason, breakerStage: state.breakerStage, touchedFiles: [] };
  }

  // Persist "working" before spawning, not after. The agent runs `office done`
  // and `office escalate` from inside its own turn, and both need to know which
  // task they belong to -- a state written afterwards is written too late.
  await office.saveState({ ...state, status: "working", currentTaskId: task?.id });

  const cwd = await office.worktrees.ensure(agentId);
  const before = await office.worktrees.touchedFiles(agentId);
  const outboxBefore = (await office.mail.outbox(agentId)).length;

  const inbox = await office.mail.inbox(agentId, { unreadOnly: true });
  const systemPrompt = buildSystemPrompt({
    role,
    memoryBrief: await office.memory.brief(agentId),
    inbox,
    steer: state.breakerStage === 1 ? lastSteer(state.recentFingerprints.length) : undefined,
    budgetNote: verdict.tier !== requestedTier
      ? `${verdict.reason}. Prefer the smallest change that finishes the task.`
      : undefined,
  });

  const result = await office.driver.run({
    agent: agentId,
    prompt: instruction,
    systemPrompt,
    cwd,
    tier: verdict.tier,
    autonomy: role.autonomy,
    sessionId: state.sessionId,
    allowedTools: role.allowedTools,
    disallowedTools: role.disallowedTools,
    timeoutMs: office.config.defaults.turnTimeoutMs,
    addDirs: [office.paths.agent(agentId)],
    env: { OFFICE_AGENT: agentId, OFFICE_ROOT: office.root },
  });

  await office.ledger.record({
    at: nowIso(),
    agent: agentId,
    taskId: task?.id,
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
  const decision = evaluateBreaker(state, observation, requestedTier);
  const next = applyObservation({ ...state, sessionId: result.sessionId ?? state.sessionId, currentTaskId: task?.id }, observation, decision);

  const gate = needsApproval(role, { touchedFiles, costUsd: result.costUsd }, office.config.budget.escalateAboveUsdPerTask);
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
  } else if (decision.stage < 3) {
    next.status = "idle";
  }

  await office.saveState(next);

  if (decision.stage >= 2 || gate.required) {
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

function lastSteer(_n: number): string {
  return (
    "Your previous turns did not move anything. State what is blocking you in one " +
    "sentence, then either mail the agent who can unblock you or escalate. Do not " +
    "retry the same approach."
  );
}
