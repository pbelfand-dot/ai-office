import type { Office } from "../office.js";
import type { ChatMessage } from "../types.js";
import { runTurn } from "../orchestrator/turn.js";
import { truncate } from "../util.js";
import { renderTranscript } from "./transcript.js";

export interface Routing {
  recipients: string[];
  /** One line on why these desks. Shown when the pick looks wrong. */
  reason: string;
  /**
   * Desks who may add something once the answer is in, and may decline.
   *
   * The difference between a room and a queue: someone who was not asked has
   * the thing worth hearing. Bounded, because the cheap version of this is
   * paging everyone and calling it culture.
   */
  alsoAsk: string[];
  /**
   * What the router says in the channel, when it is a desk people can see.
   *
   * An admin who assigns out loud tells the desk what angle to take; one who
   * narrates every message is noise. Absent is the normal case.
   */
  say?: string;
}

/** Enough to look something up before deciding, nothing to change with. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
export const NO_WRITES = ["Write", "Edit", "NotebookEdit", "Bash"];

/** More than this and the "everyone answers everything" problem is back. */
const MAX_RECIPIENTS = 3;

/** Volunteers are a flourish, and a flourish with a per-turn price. */
const MAX_VOLUNTEERS = 2;

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

  let parsed: { reply?: unknown; why?: unknown; maybe?: unknown; say?: unknown };
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.reply)) return null;

  const recipients = names(parsed.reply, known).slice(0, MAX_RECIPIENTS);
  const say = typeof parsed.say === "string" && parsed.say.trim() ? parsed.say.trim() : undefined;
  return {
    recipients,
    // A desk cannot both be told to answer and invited to consider answering.
    alsoAsk: names(parsed.maybe, known).filter((id) => !recipients.includes(id)).slice(0, MAX_VOLUNTEERS),
    reason: typeof parsed.why === "string" && parsed.why.trim() ? parsed.why.trim() : "the router picked them",
    ...(say ? { say } : {}),
  };
}

/** Ids we recognise, deduped, in the order given. Unknown names are dropped. */
function names(value: unknown, known: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const id = typeof entry === "string" ? canonical(entry, known) : null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
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
  const routerId = office.config.router;
  // A visible router is a desk in the room, but never one of its own
  // recipients: its turn is the routing decision, not an answer to route to.
  const participants = office.agentIds().filter((id) => id !== routerId);
  if (participants.length === 0) return { recipients: [], reason: "nobody is on the floor yet", alsoAsk: [] };

  const named = mentionsIn(message.body, participants);
  if (named.length) return { recipients: named.slice(0, MAX_RECIPIENTS), reason: "you named them", alsoAsk: [] };

  const orchestrator = office.config.orchestrator;
  const fallback = participants.includes(orchestrator) ? [orchestrator] : [];
  if (!office.roles.has(routerId)) {
    return { recipients: fallback, alsoAsk: [], reason: `no ${routerId} desk on this floor, so this went to ${orchestrator}` };
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
    return { recipients: fallback, alsoAsk: [], reason: `routing fell back to ${orchestrator}: ${why}` };
  }

  return parseRouting(outcome.result.text, participants)
    ?? { recipients: fallback, alsoAsk: [], reason: `the router did not answer in JSON, so this went to ${orchestrator}` };
}

function routingPrompt(office: Office, message: ChatMessage, history: ChatMessage[]): string {
  const routerId = office.config.router;
  const router = office.role(routerId);
  const roster = office.agentIds().filter((id) => id !== routerId).map((id) => {
    const role = office.role(id);
    const scope = role.scope.length ? role.scope.join(", ") : "the whole repo";
    const gist = truncate(role.briefing.split("\n").find((l) => l.trim())?.trim() ?? "", 140);
    return `- ${id} (${role.name}, ${role.title}) — owns ${scope}. ${gist}`;
  }).join("\n");

  // A hidden router is a classifier and should not be invited to have a voice.
  // A visible one is the boss: the room knows the call was theirs, so saying so
  // out loud is sometimes the whole point, and staying quiet is the default.
  const who = router.hidden
    ? [
        "You are the switchboard for an office chat. Decide who should answer the",
        "last message. You never reply in the channel yourself and nobody there",
        "knows you exist.",
      ]
    : [
        `You are ${router.name}, ${router.title}, and you see every message in this`,
        "room. Decide who answers the last one.",
        "",
        "You may also say one line yourself, in the \"say\" field -- but only when it",
        "changes what happens: assigning with an angle, overruling, breaking a tie,",
        "or stopping something expensive. Leave it out otherwise. You are not here",
        "to acknowledge, agree, summarise, or greet, and a boss who comments on",
        "everything is one nobody listens to. Most messages need no line from you.",
      ];

  return [
    ...who,
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
    "- \"maybe\" is for a desk whose own work this answer changes, or who would",
    "  visibly disagree with it. They see the answer first and may pass, so a",
    "  name here is cheap and a missing one is a point nobody made. If your own",
    "  reason names a second desk, that desk belongs in \"maybe\".",
    "",
    "## Answer format",
    "",
    "One fenced ```json block and nothing else:",
    "",
    "```json",
    '{"reply":["agent-id"],"maybe":[],"why":"six words on why them"' +
      (router.hidden ? "" : ',"say":"one line, only when it changes what happens"') + "}",
    "```",
  ].join("\n");
}
