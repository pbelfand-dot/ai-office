/**
 * A deliberately small frontmatter reader.
 *
 * It handles exactly what a role file needs -- scalars, comma lists, and
 * block lists -- and nothing else. Pulling in a YAML parser to read six keys
 * would be the wrong trade, and a partial YAML parser that silently
 * mis-reads anchors or nested maps would be worse than one that refuses them.
 */
export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

const FENCE = /^---\r?\n/;

export function parseFrontmatter(source: string): Frontmatter {
  if (!FENCE.test(source)) return { data: {}, body: source.trim() };

  const lines = source.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") { end = i; break; }
  }
  if (end === -1) throw new Error("frontmatter opened with --- but never closed");

  const data: Record<string, string | string[]> = {};
  let currentKey: string | null = null;

  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (!currentKey) throw new Error(`list item on line ${i + 1} has no key above it`);
      const list = data[currentKey];
      const value = unquote(item[1] ?? "");
      if (Array.isArray(list)) list.push(value);
      else data[currentKey] = [value];
      continue;
    }

    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`cannot parse frontmatter line ${i + 1}: ${line}`);
    const key = pair[1] as string;
    const rest = (pair[2] ?? "").trim();
    currentKey = key;
    if (rest === "") data[key] = [];
    else if (rest.includes(",")) data[key] = rest.split(",").map((s) => unquote(s.trim())).filter(Boolean);
    else data[key] = unquote(rest);
  }

  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
    const quote = trimmed[0] as string;
    if (trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.filter(Boolean) : value.split(",").map((s) => s.trim()).filter(Boolean);
}
