/** Terminal formatting. No dependency, and it goes quiet when piped. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const ESC = String.fromCharCode(27);
const wrap = (code: number) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);

const ANSI = new RegExp(`${ESC}\\[\\d+m`, "g");

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  return rows
    .map((row) => row.map((cell, i) => cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell)))).join("  ").trimEnd())
    .join("\n");
}

function visibleLength(s: string): number {
  return s.replace(ANSI, "").length;
}

export function bar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const paint = clamped >= 1 ? red : clamped >= 0.8 ? yellow : green;
  return paint("#".repeat(filled)) + dim("-".repeat(width - filled));
}

export function statusGlyph(status: string): string {
  switch (status) {
    case "working": return green("*");
    case "queued": return blue("o");
    case "blocked": return yellow("!");
    case "parked": return red("x");
    default: return dim(".");
  }
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
