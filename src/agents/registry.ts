import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter, asList } from "./frontmatter.js";
import type { Autonomy, Role, Tier } from "../types.js";
import { TIERS } from "../types.js";

const AUTONOMY: readonly Autonomy[] = ["ask", "scoped", "trusted"];

export function parseRole(id: string, source: string, defaults: { tier: Tier; autonomy: Autonomy }): Role {
  const { data, body } = parseFrontmatter(source);

  const tier = (typeof data.tier === "string" ? data.tier : defaults.tier) as Tier;
  if (!TIERS.includes(tier)) throw new Error(`role ${id}: unknown tier "${tier}" (expected ${TIERS.join(", ")})`);

  const autonomy = (typeof data.autonomy === "string" ? data.autonomy : defaults.autonomy) as Autonomy;
  if (!AUTONOMY.includes(autonomy)) throw new Error(`role ${id}: unknown autonomy "${autonomy}" (expected ${AUTONOMY.join(", ")})`);

  if (!body.trim()) throw new Error(`role ${id}: the briefing body is empty, so the agent has no instructions`);

  const scope = asList(data.scope);
  if (autonomy === "scoped" && scope.length === 0) {
    throw new Error(`role ${id}: autonomy "scoped" needs at least one scope entry, otherwise it is just "trusted" with extra steps`);
  }

  return {
    id,
    name: typeof data.name === "string" && data.name ? data.name : id,
    title: typeof data.title === "string" && data.title ? data.title : "Staff",
    tier,
    autonomy,
    scope,
    allowedTools: asList(data.allowedTools),
    disallowedTools: asList(data.disallowedTools),
    briefing: body,
  };
}

export async function loadRoles(dir: string, defaults: { tier: Tier; autonomy: Autonomy }): Promise<Map<string, Role>> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }

  const roles = new Map<string, Role>();
  for (const file of files.sort()) {
    const id = basename(file, ".md");
    const source = await readFile(join(dir, file), "utf8");
    roles.set(id, parseRole(id, source, defaults));
  }
  return roles;
}
