/**
 * What kind of terminal we are drawing into. Decided once per process and
 * passed down; every renderer is a pure function of (theme, width, data).
 *
 * Colour is OFF when stdout is not a TTY, when `NO_COLOR` is set to anything,
 * or when `TERM=dumb`. Truecolor needs `COLORTERM` = truecolor | 24bit; any
 * other colour-capable TTY gets the 256-colour approximations.
 */
export type Colour = "none" | "256" | "truecolor";

export interface Terminal {
  colour: Colour;
  /** Columns available, clamped to 60..160. 100 when unknown. */
  width: number;
  /** A TTY: spinners and in-place rewrites are allowed. */
  interactive: boolean;
}

export interface StreamLike {
  isTTY?: boolean;
  columns?: number;
}

export const MIN_WIDTH = 60;
export const MAX_WIDTH = 160;
export const DEFAULT_WIDTH = 100;

export function detectTerminal(env: Record<string, string | undefined>, stream: StreamLike): Terminal {
  const interactive = stream.isTTY === true;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stream.columns ?? DEFAULT_WIDTH));
  let colour: Colour = "none";
  if (interactive && env.NO_COLOR === undefined && env.TERM !== "dumb") {
    const ct = (env.COLORTERM ?? "").toLowerCase();
    colour = ct === "truecolor" || ct === "24bit" ? "truecolor" : "256";
  }
  return { colour, width, interactive };
}

/** Visible length of a string: ANSI escape sequences do not count. */
export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Truncate to `width` visible columns, keeping escapes intact, ending with `…` and a reset. */
export function fit(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  let out = "";
  let seen = 0;
  let i = 0;
  const limit = Math.max(0, width - 1);
  while (i < line.length && seen < limit) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += line[i++];
    seen++;
  }
  return out + "…" + (line.includes("\x1b[") ? "\x1b[0m" : "");
}

/**
 * Break a line into rows of at most `width` visible columns, at a space when
 * one falls in the second half of the row, otherwise mid-word. Continuation
 * rows are indented; escapes in force at a break are closed and reopened.
 */
export function wrap(line: string, width: number, indent = 2): string[] {
  if (width <= 0 || visibleLength(line) <= width) return [line];
  const cells: { pre: string; ch: string }[] = [];
  let pre = "";
  for (let i = 0; i < line.length;) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      pre += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    cells.push({ pre, ch: line[i]! });
    pre = "";
    i++;
  }
  const tail = pre;
  const out: string[] = [];
  let active = "";
  let start = 0;
  while (start < cells.length) {
    const first = out.length === 0;
    const room = first ? width : Math.max(1, width - indent);
    let end = Math.min(cells.length, start + room); // exclusive
    let next = end;
    if (end < cells.length) {
      // Break at a space (which is then dropped), looking from the first column that
      // does not fit back to the middle of the row.
      for (let k = end; k > start + Math.floor(room / 2); k--) {
        if (cells[k]!.ch === " ") { end = k; next = k + 1; break; }
      }
    }
    let piece = (first ? "" : " ".repeat(indent)) + active;
    for (let k = start; k < end; k++) {
      const c = cells[k]!;
      piece += c.pre + c.ch;
      if (c.pre) active = c.pre.includes("\x1b[0m") ? c.pre.slice(c.pre.lastIndexOf("\x1b[0m") + 4) : active + c.pre;
    }
    if (next >= cells.length) piece += tail;
    else if (active) piece += "\x1b[0m";
    out.push(piece);
    start = next;
  }
  return out;
}

/**
 * A plain (escape-free) text field cut to `width` so the character at `cursor`
 * is always on screen: the window slides with the cursor and `…` marks each
 * cut side.
 */
export function fitAround(text: string, cursor: number, width: number): string {
  const w = Math.max(3, width);
  if (text.length <= w) return text;
  const at = Math.max(0, Math.min(cursor, text.length - 1));
  if (at < w - 1) return text.slice(0, w - 1) + "…";
  // A leading …, then the window; the cursor sits inside it, with one column spare after it.
  let start = at + 2 - (w - 1);
  let end = start + (w - 2);
  if (end >= text.length) { end = text.length; start = Math.max(0, end - (w - 1)); return "…" + text.slice(start); }
  return "…" + text.slice(start, end) + "…";
}

/** Pad to `n` visible columns (never truncates). */
export function padEnd(s: string, n: number): string {
  const gap = n - visibleLength(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

export function padStart(s: string, n: number): string {
  const gap = n - visibleLength(s);
  return gap > 0 ? " ".repeat(gap) + s : s;
}
