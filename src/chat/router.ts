import type { Office } from "../office.js";
import type { ChatMessage } from "../types.js";
import { runTurn } from "../orchestrator/turn.js";
import { truncate } from "../util.js";
import { renderTranscript } from "./transcript.js";

export interface Assignment {
  to: string;
  /** Standalone instruction: the desk that runs it has not read the chat. */
  task: string;
}

export interface Routing {
  recipients: string[];
  /**
   * Work to put on the queue, not answers to give in the channel.
   *
   * A floor that only ever talks is a floor that is always idle. When the
   * message asks for something to exist -- a sequence, a price sheet, a list --
   * the honest response is a task somebody runs, not a paragraph about it.
   */
  assignments: Assignment[];
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

/**
 * Enough to look something up before deciding, nothing to change with.
 *
 * The web is in here because half of what a desk gets asked in a business is
 * a question about the world -- what the going rate is, what a competitor
 * charges -- and a desk that can only read its own files answers those from
 * memory, which is the one thing it must not do.
 */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];
export const NO_WRITES = ["Write", "Edit", "NotebookEdit", "Bash"];

/** More than this and the "everyone answers everything" problem is back. */
const MAX_RECIPIENTS = 3;

/** Volunteers are a flourish, and a flourish with a per-turn price. */
const MAX_VOLUNTEERS = 2;

/** One message should not be able to commit the floor to a week of work. */
const MAX_ASSIGNMENTS = 4;

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

  let parsed: { reply?: unknown; why?: unknown; maybe?: unknown; say?: unknown; assign?: unknown };
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.reply)) return null;

  const say = typeof parsed.say === "string" && parsed.say.trim() ? parsed.say.trim() : undefined;
  const recipients = names(parsed.reply, known).slice(0, MAX_RECIPIENTS);

  // Addressing a desk and not routing to it leaves a question hanging in the
  // room with nobody holding it. If the line names them, they are in.
  if (say) {
    for (const id of namedIn(say, known)) {
      if (recipients.length >= MAX_RECIPIENTS) break;
      if (!recipients.includes(id)) recipients.push(id);
    }
  }

  return {
    recipients,
    assignments: assignmentsIn(parsed.assign, known),
    // A desk cannot both be told to answer and invited to consider answering.
    alsoAsk: names(parsed.maybe, known).filter((id) => !recipients.includes(id)).slice(0, MAX_VOLUNTEERS),
    reason: typeof parsed.why === "string" && parsed.why.trim() ? parsed.why.trim() : "the router picked them",
    ...(say ? { say } : {}),
  };
}

/**
 * What the boss does once the room has spoken.
 *
 * Routing happens before any desk answers, so the decision that matters most --
 * "given what they just said, who does what" -- has nowhere to live without a
 * second look. This is that look: no recipients, because the talking is done.
 */
export function parseFollowUp(raw: string, known: string[]): { assignments: Assignment[]; say?: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return { assignments: [] };

  let parsed: { assign?: unknown; say?: unknown };
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as typeof parsed;
  } catch {
    return { assignments: [] };
  }
  const say = typeof parsed.say === "string" && parsed.say.trim() ? parsed.say.trim() : undefined;
  return { assignments: assignmentsIn(parsed.assign, known), ...(say ? { say } : {}) };
}

export function followUpPrompt(office: Office, history: ChatMessage[]): string {
  const routerId = office.config.router;
  const router = office.role(routerId);
  const roster = office.agentIds().filter((id) => id !== routerId).map((id) => {
    const role = office.role(id);
    return `- ${id} (${role.name}, ${role.title}) — writes to ${role.scope.join(", ") || "anywhere"}`;
  }).join("\n");

  return [
    `You are ${router.name}, ${router.title}. The room has just answered. Decide`,
    "what actually gets done about it.",
    "",
    "## Who works for you",
    "",
    roster,
    "",
    "## What was just said",
    "",
    renderTranscript(office, history),
    "",
    "## Your call",
    "",
    "The lines marked Owner are the person who owns this business and who you",
    "work for. Everyone else is a desk. If something needs to be asked of the",
    "owner, ask them directly -- never address a desk about something the owner",
    "said, and never treat the owner's own words as a desk's request.",
    "",
    "Assign the work this exchange just established. A desk that named a blocker",
    "has told you what to assign, and to whom. A desk that said it would do",
    "something has not done it: talk is read-only here, and only an assignment",
    "produces a file.",
    "",
    "Each assignment is one desk and one instruction that stands alone -- the",
    "desk running it has not read this chat, so name the deliverable and where it",
    "goes. Assign what this exchange established and nothing more; each one costs",
    "a full turn and does real work.",
    "",
    "Assign nothing when nothing was established: an opinion, a question already",
    "answered, small talk. An empty list is the common case and costs nothing.",
    "",
    "Never assign work whose premise nobody has confirmed. If a desk asked for a",
    "detail about a client, a booking or a deadline that has not been mentioned,",
    "the answer is to ask the owner in the channel -- not to send someone off to",
    "confirm a thing that may not exist. A task built on a guess costs a full",
    "turn and produces a file about nothing.",
    "",
    "One fenced ```json block and nothing else:",
    "",
    "```json",
    '{"assign":[{"to":"agent-id","task":"one standalone instruction"}],"say":"optional line, only if it changes what happens"}',
    "```",
  ].join("\n");
}

/** Desks named in a sentence, with or without an @. */
function namedIn(text: string, known: string[]): string[] {
  const words: string[] = text.toLowerCase().match(/[\w.-]+/g) ?? [];
  return known.filter((id) => words.includes(id.toLowerCase()));
}

function assignmentsIn(value: unknown, known: string[]): Assignment[] {
  if (!Array.isArray(value)) return [];
  const out: Assignment[] = [];
  for (const entry of value.slice(0, MAX_ASSIGNMENTS)) {
    const item = entry as { to?: unknown; task?: unknown };
    const to = typeof item.to === "string" ? canonical(item.to, known) : null;
    const task = typeof item.task === "string" ? item.task.trim() : "";
    if (to && task) out.push({ to, task });
  }
  return out;
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
  if (participants.length === 0) return { recipients: [], reason: "nobody is on the floor yet", alsoAsk: [], assignments: [] };

  const named = mentionsIn(message.body, participants);
  if (named.length) return { recipients: named.slice(0, MAX_RECIPIENTS), reason: "you named them", alsoAsk: [], assignments: [] };

  // Somebody always has it. The old rule fell back to the orchestrator, which
  // on a floor whose boss is also the router resolves to a desk excluded from
  // its own recipient list -- so every failure landed on nobody and the room
  // sat in silence wondering what it did wrong.
  const orchestrator = office.config.orchestrator;
  const fallback = participants.includes(orchestrator)
    ? [orchestrator]
    : office.roles.has(routerId) && !office.role(routerId).hidden
      ? [routerId]
      : participants.slice(0, 1);
  const heldBy = fallback[0] ?? "nobody";

  if (!office.roles.has(routerId)) {
    return { recipients: fallback, alsoAsk: [], assignments: [], reason: `no ${routerId} desk on this floor, so this went to ${heldBy}` };
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
    return { recipients: fallback, alsoAsk: [], assignments: [], reason: `routing fell back to ${heldBy}: ${why}` };
  }

  const routing = parseRouting(outcome.result.text, participants)
    ?? { recipients: fallback, alsoAsk: [], assignments: [], reason: `the router did not answer in JSON, so this went to ${heldBy}` };

  // A question that reaches nobody is the worst outcome in the room: it looks
  // like the floor ignored you. Silence stays legal for acknowledgements, and
  // for a message the router answered itself, and nothing else.
  if (routing.recipients.length === 0 && routing.assignments.length === 0 && !routing.say && asksSomething(message.body)) {
    return { ...routing, recipients: fallback, reason: `${routing.reason} -- but you asked something, so ${heldBy} has it` };
  }
  return routing;
}

/** Does this want an answer, as opposed to being a nod at the last one? */
function asksSomething(body: string): boolean {
  const text = body.trim();
  if (text.includes("?")) return true;
  // Short acknowledgements are the case silence exists for; anything with real
  // substance in it is a request even when it is phrased as a statement.
  return text.split(/\s+/).length > 8;
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
        "",
        "When you do speak: one sentence, the way a busy person types it. No",
        "greeting, no preamble, no summary of what was said. Name the person and",
        "the thing. \"Dana, book it for Thursday\" is the whole message.",
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
    "- If your line names a desk, that desk is also in \"reply\". Asking someone a",
    "  question without routing to them leaves it hanging in an empty room.",
    "- An empty \"reply\" is only for acknowledgements and thanks. A question gets",
    "  a desk, always, even when the honest answer is that it is the wrong",
    "  question -- somebody has to be the one to say so.",
    "- \"maybe\" is for a desk whose own work this answer changes, or who would",
    "  visibly disagree with it. They see the answer first and may pass, so a",
    "  name here is cheap and a missing one is a point nobody made. If your own",
    "  reason names a second desk, that desk belongs in \"maybe\".",
    "",
    "## Putting work on the queue",
    "",
    "Talking is not doing. When what is wanted is a thing that should exist --",
    "a sequence written, a price sheet built, a list pulled together -- put it in",
    "\"assign\" as well as answering. Each assignment is one desk and one",
    "instruction that stands alone: the desk running it has not read this chat,",
    "so name the deliverable and where it goes. Assigned work is done for real,",
    "in files, and it costs a full turn each -- so assign what was asked for and",
    "not a programme of improvement around it.",
    "",
    "## Answer format",
    "",
    "One fenced ```json block and nothing else:",
    "",
    "```json",
    '{"reply":["agent-id"],"maybe":[],"assign":[{"to":"agent-id","task":"one standalone instruction"}],' +
      '"why":"six words on why them"' +
      (router.hidden ? "" : ',"say":"one line, only when it changes what happens"') + "}",
    "```",
  ].join("\n");
}
