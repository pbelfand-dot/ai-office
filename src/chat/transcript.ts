import type { Office } from "../office.js";
import type { ChatMessage } from "../types.js";
import { HUMAN, SYSTEM } from "../types.js";
import { truncate } from "../util.js";

/** Long enough to carry an argument, short enough that ten of them are cheap. */
const MAX_BODY = 700;

/**
 * Who said it, as the room would say it.
 *
 * The human is "Human" here and "You" in the browser on purpose: the browser is
 * read by the human, and a transcript that calls the reader "You" reads
 * naturally. A model reading the same line has to know which of the two of them
 * "You" means.
 */
export function speakerName(office: Office, id: string): string {
  // "Owner", not "Human": on a floor whose admin desk is named after the person
  // who owns the business -- which is the natural thing to call it -- "Human"
  // and that desk's name are two labels for someone the model has to keep
  // apart, and it does not reliably. One of them says what the role is.
  if (id === HUMAN) return "Owner";
  if (id === SYSTEM) return "office";
  return office.roles.get(id)?.name ?? id;
}

export function renderTranscript(office: Office, messages: ChatMessage[]): string {
  return messages
    .map((m) => `${speakerName(office, m.from)}: ${truncate(m.body.trim().replace(/\s*\n\s*/g, " "), MAX_BODY)}`)
    .join("\n");
}
