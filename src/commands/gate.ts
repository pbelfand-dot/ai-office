import type { Office } from "../office.js";
import { bold, dim, green, red, yellow } from "./format.js";

export async function approvals(office: Office, opts: { all: boolean }): Promise<string> {
  const list = await office.escalations.list({ openOnly: !opts.all });
  if (list.length === 0) return dim(opts.all ? "No escalations recorded." : "Nothing waiting on you.");

  return list
    .map((e) => {
      const head = e.decision
        ? `${e.decision === "approve" ? green("approved") : red("denied")} ${dim(e.decidedAt ?? "")}`
        : yellow("waiting on you");
      return [
        `${bold(e.id)}  ${dim(e.kind)}  ${head}`,
        `  ${e.summary}`,
        e.detail.split("\n").map((l) => `  ${dim(l)}`).join("\n"),
        e.note ? `  ${dim(`note: ${e.note}`)}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export async function decide(office: Office, id: string, decision: "approve" | "deny", note?: string): Promise<string> {
  const escalation = await office.escalations.decide(id, decision, note);

  // Unblock the agent, but only if this was the last thing holding it.
  const stillOpen = (await office.escalations.list({ openOnly: true })).some((e) => e.agent === escalation.agent);
  if (!stillOpen) {
    const state = await office.state(escalation.agent);
    if (state.status === "blocked") await office.saveState({ ...state, status: "idle" });
  }

  // A denial the agent never sees is a denial it will repeat next turn.
  await office.memory.remember(
    escalation.agent,
    `${decision === "approve" ? "Approved" : "Denied"}: ${escalation.summary}.${note ? ` Human said: ${note}` : ""}`,
    "decision",
  );

  const lines = [
    `${decision === "approve" ? green("approved") : red("denied")} ${escalation.id}`,
    dim(`  Recorded in ${escalation.agent}'s memory, so it carries into the next turn.`),
  ];
  if (stillOpen) lines.push(yellow(`  ${escalation.agent} is still blocked by another open escalation.`));
  else lines.push(dim(`  ${escalation.agent} is unblocked. Run \`office run\` to continue.`));

  if (decision === "deny" && !note) {
    lines.push(yellow("  You denied this without saying why. The agent will likely try it again."));
  }
  return lines.join("\n");
}
