import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter, asList } from "./frontmatter.js";
import type { Autonomy, Provider, Role, Tier } from "../types.js";
import { PROVIDERS, TIERS } from "../types.js";
import { migrateTier } from "../config.js";

const AUTONOMY: readonly Autonomy[] = ["ask", "scoped", "trusted"];

export function parseRole(id: string, source: string, defaults: { provider: Provider; tier: Tier; autonomy: Autonomy }): Role {
  const { data, body } = parseFrontmatter(source);

  const provider = (typeof data.provider === "string" ? data.provider : defaults.provider) as Provider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`role ${id}: unknown provider "${provider}" (expected ${PROVIDERS.join(", ")})`);
  }

  // Tiers were once named after Anthropic's models; old role files still are.
  const raw = typeof data.tier === "string" ? data.tier : defaults.tier;
  const tier = migrateTier(raw);
  if (!tier) throw new Error(`role ${id}: unknown tier "${raw}" (expected ${TIERS.join(", ")})`);

  const autonomy = (typeof data.autonomy === "string" ? data.autonomy : defaults.autonomy) as Autonomy;
  if (!AUTONOMY.includes(autonomy)) throw new Error(`role ${id}: unknown autonomy "${autonomy}" (expected ${AUTONOMY.join(", ")})`);

  if (!body.trim()) throw new Error(`role ${id}: the briefing body is empty, so the agent has no instructions`);

  const hidden = data.hidden === "true" || data.hidden === "yes";

  const scope = asList(data.scope);
  if (autonomy === "scoped" && scope.length === 0) {
    throw new Error(`role ${id}: autonomy "scoped" needs at least one scope entry, otherwise it is just "trusted" with extra steps`);
  }

  return {
    id,
    provider,
    name: typeof data.name === "string" && data.name ? data.name : id,
    title: typeof data.title === "string" && data.title ? data.title : "Staff",
    tier,
    autonomy,
    hidden,
    scope,
    allowedTools: asList(data.allowedTools),
    disallowedTools: asList(data.disallowedTools),
    briefing: body,
  };
}

export async function loadRoles(dir: string, defaults: { provider: Provider; tier: Tier; autonomy: Autonomy }): Promise<Map<string, Role>> {
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
