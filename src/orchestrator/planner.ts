import { nowIso, shortId } from "../util.js";
import type { Office } from "../office.js";
import type { Brief, Task } from "../types.js";
import { runTurn } from "./turn.js";

export interface PlanItem {
  title: string;
  instruction: string;
  assignee: string;
  dependsOn?: string[];
}

/**
 * Turn one plain-English brief into assigned work.
 *
 * The split is done by a model turn rather than by rules, because deciding
 * which agent should own which slice is the judgement you hired the
 * orchestrator for. What is *not* left to judgement is the shape of the answer:
 * a strict JSON block, validated here, so a rambling reply becomes a clean
 * failure instead of nine agents acting on a misparse.
 */
export async function plan(office: Office, briefText: string): Promise<{ brief: Brief; tasks: Task[]; raw: string }> {
  const orchestrator = office.config.orchestrator;
  office.role(orchestrator); // throws with a useful message if the desk is empty

  const roster = office
    .agentIds()
    .filter((id) => id !== orchestrator)
    .map((id) => {
      const role = office.role(id);
      const scope = role.scope.length ? role.scope.join(", ") : "the whole repo";
      return `- ${id} (${role.title}, ${role.tier}, autonomy ${role.autonomy}) — owns ${scope}`;
    })
    .join("\n");

  if (!roster) throw new Error(`only ${orchestrator} is on the floor; run \`office hire\` before briefing`);

  const instruction = [
    "Split the following brief into tasks and assign each one to an agent on the floor.",
    "",
    "## The brief",
    "",
    briefText,
    "",
    "## Who is on the floor",
    "",
    roster,
    "",
    "## Rules",
    "",
    "- Assign each task to the agent whose scope actually covers the files it touches.",
    "- A task is one agent's work. If two agents must both change something, that is two tasks plus a message between them.",
    "- Use dependsOn only for real ordering, not for tidiness. Independent tasks should run in parallel.",
    "- Write each instruction so it stands alone: the agent receiving it has not read this brief.",
    "- Prefer fewer, larger tasks. Every task is a fresh context that has to be paid for.",
    "",
    "## Answer format",
    "",
    "Reply with one fenced ```json block and nothing else. Shape:",
    "",
    '```json',
    '{"tasks":[{"title":"...","assignee":"agent-id","instruction":"...","dependsOn":[]}]}',
    "```",
    "",
    "dependsOn holds the *titles* of earlier tasks in this same list.",
  ].join("\n");

  const outcome = await runTurn(office, orchestrator, null, instruction);
  if (!outcome.ran) throw new Error(`could not plan: ${outcome.blockedBy}`);
  const raw = outcome.result?.text ?? "";
  if (!outcome.result?.ok) throw new Error(`the orchestrator's planning turn failed: ${outcome.result?.error ?? "no output"}`);

  const items = parsePlan(raw);
  const known = new Set(office.agentIds());
  const brief: Brief = { id: shortId("brief"), text: briefText, createdAt: nowIso(), tasks: [] };

  const byTitle = new Map<string, string>();
  const tasks: Task[] = items.map((item) => {
    if (!known.has(item.assignee)) {
      throw new Error(`the plan assigns "${item.title}" to "${item.assignee}", who is not on the floor (${[...known].join(", ")})`);
    }
    const task: Task = {
      id: shortId("task"),
      briefId: brief.id,
      title: item.title,
      instruction: item.instruction,
      assignee: item.assignee,
      state: "pending",
      dependsOn: [],
      createdAt: nowIso(),
      attempts: 0,
    };
    byTitle.set(item.title, task.id);
    return task;
  });

  items.forEach((item, i) => {
    const task = tasks[i] as Task;
    task.dependsOn = (item.dependsOn ?? [])
      .map((title) => byTitle.get(title))
      .filter((id): id is string => Boolean(id) && id !== task.id);
  });

  brief.tasks = tasks.map((t) => t.id);
  return { brief, tasks, raw };
}

export function parsePlan(raw: string): PlanItem[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`the orchestrator did not return a JSON plan. It said:\n${raw.slice(0, 500)}`);
  }

  let parsed: { tasks?: unknown };
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as { tasks?: unknown };
  } catch (err) {
    throw new Error(`the orchestrator's plan was not valid JSON (${(err as Error).message}). It said:\n${raw.slice(0, 500)}`);
  }

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error("the plan contained no tasks");
  }

  return parsed.tasks.map((entry, i) => {
    const item = entry as Partial<PlanItem>;
    if (!item.title?.trim()) throw new Error(`plan task ${i + 1} has no title`);
    if (!item.assignee?.trim()) throw new Error(`plan task "${item.title}" has no assignee`);
    if (!item.instruction?.trim()) throw new Error(`plan task "${item.title}" has no instruction`);
    return {
      title: item.title.trim(),
      assignee: item.assignee.trim(),
      instruction: item.instruction.trim(),
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((d): d is string => typeof d === "string") : [],
    };
  });
}
