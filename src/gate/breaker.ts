import type { AgentState, Tier } from "../types.js";
import { demote } from "../budget/ledger.js";
import { fingerprint } from "../util.js";

export interface BreakerConfig {
  /** Identical-looking turns before the breaker reacts. */
  repeatThreshold: number;
  /** Turns with no file change and no mail before the breaker reacts. */
  idleThreshold: number;
  /** Turns on one task before the breaker stops it outright. */
  maxTurnsPerTask: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  repeatThreshold: 3,
  idleThreshold: 4,
  maxTurnsPerTask: 25,
};

export interface TurnObservation {
  output: string;
  touchedFiles: string[];
  mailSent: number;
  turnsOnTask: number;
}

export interface BreakerDecision {
  stage: 0 | 1 | 2 | 3;
  /** Text injected into the next turn when the breaker is steering. */
  steer?: string;
  /** Tier the agent is forced down to when constrained. */
  tier?: Tier;
  reason: string;
  changed: boolean;
}

/**
 * Steer, then constrain, then stop.
 *
 * A looping agent is the most expensive failure in this whole category,
 * because it fails quietly and bills the whole time. But killing on the first
 * repeat is wrong too -- retrying a flaky test twice is normal work. So the
 * breaker escalates: first it tells the agent what it is doing, then it takes
 * away the expensive model, and only then does it park the desk.
 */
export function evaluateBreaker(state: AgentState, obs: TurnObservation, requestedTier: Tier, config: BreakerConfig = DEFAULT_BREAKER): BreakerDecision {
  const fp = fingerprint(obs.output.slice(0, 2000));
  const recent = [...state.recentFingerprints, fp].slice(-config.repeatThreshold * 2);
  const repeats = recent.filter((f) => f === fp).length;

  const madeProgress = obs.touchedFiles.length > 0 || obs.mailSent > 0;
  const idleTurns = madeProgress ? 0 : state.idleTurns + 1;

  if (obs.turnsOnTask >= config.maxTurnsPerTask) {
    return stage(3, state, `${obs.turnsOnTask} turns on one task without finishing it`);
  }
  if (repeats >= config.repeatThreshold && idleTurns >= config.idleThreshold) {
    return stage(3, state, `repeated the same output ${repeats}x with no progress for ${idleTurns} turns`);
  }
  if (repeats >= config.repeatThreshold || idleTurns >= config.idleThreshold) {
    return {
      ...stage(2, state, repeats >= config.repeatThreshold
        ? `same output ${repeats}x in a row`
        : `${idleTurns} turns without touching a file or sending mail`),
      tier: demote(requestedTier),
    };
  }
  if (repeats >= 2 || idleTurns >= 2) {
    return {
      ...stage(1, state, repeats >= 2 ? "output is starting to repeat" : "no visible progress in the last two turns"),
      steer:
        "You have now spent two turns without visible progress. Before doing anything else, " +
        "state in one sentence what is blocking you. If it is a decision only a human can make, " +
        "run `office escalate` and stop. If it is missing information, ask the agent who has it by " +
        "running `office mail`. Do not repeat your previous approach.",
    };
  }

  return { stage: 0, reason: "healthy", changed: state.breakerStage !== 0 };
}

function stage(next: 0 | 1 | 2 | 3, state: AgentState, reason: string): BreakerDecision {
  return { stage: next, reason, changed: state.breakerStage !== next };
}

/** Fold a turn's observations back into the agent's persisted state. */
export function applyObservation(state: AgentState, obs: TurnObservation, decision: BreakerDecision, config: BreakerConfig = DEFAULT_BREAKER): AgentState {
  const fp = fingerprint(obs.output.slice(0, 2000));
  const madeProgress = obs.touchedFiles.length > 0 || obs.mailSent > 0;
  return {
    ...state,
    recentFingerprints: [...state.recentFingerprints, fp].slice(-config.repeatThreshold * 2),
    idleTurns: madeProgress ? 0 : state.idleTurns + 1,
    breakerStage: decision.stage,
    tierOverride: decision.tier,
    status: decision.stage === 3 ? "parked" : state.status,
    updatedAt: new Date().toISOString(),
  };
}
