import type { Office } from "../office.js";
import type { ChatMessage } from "../types.js";
import { runTurn } from "../orchestrator/turn.js";
import { truncate } from "../util.js";
import { renderTranscript } from "./transcript.js";

export interface Routing {
  recipients: string[];
  /** One line on why these desks. Shown when the pick looks wrong. */
  reason: string;
}

/** Enough to look something up before deciding, nothing to change with. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
export const NO_WRITES = ["Write", "Edit", "NotebookEdit", "Bash"];

/** More than this and the "everyone answers everything" problem is back. */
const MAX_RECIPIENTS = 3;

/**
 * Desks named with @ win outright, before any model call.
 *
 * The router exists so you do not have to think about who owns what. When you
 * already know, paying a turn to be told again is waste, and being overruled by
 * a classifier is worse.
 */
export function mentionsIn(body: string, known: string[]): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/@([\w.-]+)/g)) {
    const id = canonical(match[1] ?? "", known);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Match a name the way a person types it, return it the way the floor spells it. */
function canonical(name: string, known: string[]): string | null {
  const wanted = name.trim().toLowerCase();
  return known.find((id) => id.toLowerCase() === wanted) ?? null;
}

/**
 * Read the routing decision out of the turn's text.
 *
 * Same contract as the planner's: one fenced JSON block, validated here, so a
 * chatty reply becomes a clean fallback rather than a guess at who was meant.
 * Names that are not on the floor are dropped rather than failing the parse --
 * a hallucinated desk should cost that name, not the whole decision.
 */
export function parseRouting(raw: string, known: string[]): Routing | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: { reply?: unknown; why?: unknown };
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as { reply?: unknown; why?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.reply)) return null;

  const recipients: string[] = [];
  for (const entry of parsed.reply) {
    const id = typeof entry === "string" ? canonical(entry, known) : null;
    if (id && !recipients.includes(id)) recipients.push(id);
  }
  return {
    recipients: recipients.slice(0, MAX_RECIPIENTS),
    reason: typeof parsed.why === "string" && parsed.why.trim() ? parsed.why.trim() : "the router picked them",
  };
}

/**
 * Who should answer this message.
 *
 * The decision is a model call rather than keyword rules because "the pricing
 * page feels off" names no file and no desk, and that is the normal case. It
 * runs on the cheapest tier and never fails the message: every way this can go
 * wrong -- no router desk, a spent budget, an unparseable reply -- falls back
 * to the orchestrator, who can at least say who to ask.
 */
export async function route(office: Office, message: ChatMessage, history: ChatMessage[]): Promise<Routing> {
  const participants = office.agentIds();
  if (participants.length === 0) return { recipients: [], reason: "nobody is on the floor yet" };

  const named = mentionsIn(message.body, participants);
  if (named.length) return { recipients: named.slice(0, MAX_RECIPIENTS), reason: "you named them" };

  const orchestrator = office.config.orchestrator;
  const fallback = participants.includes(orchestrator) ? [orchestrator] : [];
  const routerId = office.config.router;
  if (!office.roles.has(routerId)) {
    return { recipients: fallback, reason: `no ${routerId} desk on this floor, so this went to ${orchestrator}` };
  }

  const outcome = await runTurn(office, routerId, null, routingPrompt(office, message, history), {
    thread: "chat",
    maxTier: office.config.chat.routerTier,
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: NO_WRITES,
    timeoutMs: office.config.chat.turnTimeoutMs,
  });

  if (!outcome.ran || !outcome.result?.ok) {
    const why = outcome.blockedBy ?? outcome.result?.error ?? "the router turn produced nothing";
    return { recipients: fallback, reason: `routing fell back to ${orchestrator}: ${why}` };
  }

  return parseRouting(outcome.result.text, participants)
    ?? { recipients: fallback, reason: `the router did not answer in JSON, so this went to ${orchestrator}` };
}

function routingPrompt(office: Office, message: ChatMessage, history: ChatMessage[]): string {
  const roster = office.agentIds().map((id) => {
    const role = office.role(id);
    const scope = role.scope.length ? role.scope.join(", ") : "the whole repo";
    const gist = truncate(role.briefing.split("\n").find((l) => l.trim())?.trim() ?? "", 140);
    return `- ${id} (${role.name}, ${role.title}) — owns ${scope}. ${gist}`;
  }).join("\n");

  return [
    "You are the switchboard for an office chat. Decide who should answer the",
    "last message. You never reply in the channel yourself and nobody there",
    "knows you exist.",
    "",
    "## Who is in the room",
    "",
    roster,
    "",
    "## The channel so far",
    "",
    renderTranscript(office, history) || "(nothing yet)",
    "",
    "## The message to route",
    "",
    message.body,
    "",
    "## Rules",
    "",
    "- Pick the fewest desks who can actually answer. One is the common case.",
    "- Pick a second only when the answer genuinely needs both, not to be thorough.",
    "- Reply with an empty list for small talk, acknowledgements, and anything",
    "  already answered above. Silence is a valid routing decision and the",
    "  reason this office is cheaper than paging everyone.",
    "- Route on who owns the subject, not on who was talking most recently.",
    "",
    "## Answer format",
    "",
    "One fenced ```json block and nothing else:",
    "",
    "```json",
    '{"reply":["agent-id"],"why":"six words on why them"}',
    "```",
  ].join("\n");
}
