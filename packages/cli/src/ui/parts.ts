/**
 * The direction-D building blocks: wordmark banner, hairline, eyebrows, the
 * stage rail, block bars, the label/value ledger and aligned tables. Each
 * returns plain lines (joined with \n) and never exceeds `width`.
 */
import type { Theme } from "./theme.js";
import { fit, padEnd, padStart, visibleLength } from "./tty.js";

export const LABEL_COL = 22;

export function letterSpaced(s: string): string {
  return [...s.toUpperCase()].join(" ");
}

/** `ESFERA` in the ramp, the environment right-aligned, then a hairline. */
export function banner(theme: Theme, width: number, right: string): string {
  const mark = theme.bold(theme.brand(letterSpaced("ESFERA")));
  const gap = Math.max(2, width - visibleLength(mark) - right.length);
  return [fit(mark + " ".repeat(gap) + theme.dim(right), width), theme.faint("─".repeat(width))].join("\n");
}

/** `● E S F E R A` (white wordmark), the session right-aligned, then the full-width ramp bar. */
export function sessionBanner(theme: Theme, width: number, right: string): string {
  const mark = theme.brandOrange("●") + " " + theme.bold(theme.fg(letterSpaced("ESFERA")));
  const gap = Math.max(2, width - visibleLength(mark) - right.length);
  return [fit(mark + " ".repeat(gap) + theme.dim(right), width), theme.rampBar(width)].join("\n");
}

/** `  C O M M A N D   detail` — the line under the banner naming what runs. */
export function heading(theme: Theme, width: number, command: string, detail?: string): string {
  const head = theme.bold(theme.fg(letterSpaced(command)));
  return fit(detail ? `${head}   ${theme.dim(detail)}` : head, width);
}

export function eyebrow(theme: Theme, text: string): string {
  return "  " + theme.dim(letterSpaced(text));
}

export function bar(theme: Theme, pct: number, width: number): string {
  const w = Math.max(4, width);
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w);
  return theme.brand("█".repeat(filled)) + theme.faint("░".repeat(w - filled));
}

export interface StageRow {
  state: "done" | "active" | "pending";
  label: string;
  detail?: string;
  bar?: { pct: number };
  suffix?: string;
}

/** The rail: ✓ done · ◆ active · · pending, labels in a fixed column. */
export function stages(theme: Theme, rows: StageRow[], width: number): string {
  const barWidth = Math.max(10, Math.min(28, width - LABEL_COL - 2 - 32));
  return rows
    .map((r) => {
      const glyph = r.state === "done" ? theme.success("✓") : r.state === "active" ? theme.brand("◆") : theme.faint("·");
      const label = r.state === "active" ? theme.bold(theme.fg(r.label)) : r.state === "pending" ? theme.faint(r.label) : theme.fg(r.label);
      let rest = "";
      if (r.bar) {
        const pct = padStart(`${Math.round(r.bar.pct)}%`, 4);
        rest = `${bar(theme, r.bar.pct, barWidth)}  ${theme.fg(pct)}${r.suffix ? `   ${theme.dim(r.suffix)}` : ""}`;
      } else if (r.detail) {
        rest = theme.dim(r.detail);
      }
      return fit(`${glyph} ${padEnd(label, LABEL_COL)}${rest}`, width);
    })
    .join("\n");
}

/** Two-column label/value rows with an optional dim note. */
export function ledger(theme: Theme, rows: [label: string, value: string, note?: string][], width: number): string {
  return rows.map(([l, v, n]) => fit(`  ${padEnd(theme.dim(l), 12)}${v}${n ? `   ${theme.dim(n)}` : ""}`, width)).join("\n");
}

export interface Column<T> {
  key: keyof T | ((row: T) => string);
  header?: string;
  align?: "left" | "right";
  /** Paint for the cell text; receives the row so a column can colour by state. */
  paint?: (text: string, row: T) => string;
  /** Hard cap on the column's width; the text is truncated with … */
  max?: number;
}

/** Aligned columns, two spaces apart; the whole row is fitted to `width`. */
export function table<T>(theme: Theme, opts: { columns: Column<T>[]; rows: T[]; width: number; indent?: number; rowPaint?: (row: T) => ((s: string) => string) | null }): string {
  const indent = " ".repeat(opts.indent ?? 2);
  // Cells may already carry colour (a status glyph), so every measurement is on visible text.
  const cell = (c: Column<T>, r: T) => {
    const raw = typeof c.key === "function" ? c.key(r) : String(r[c.key] ?? "");
    return c.max && visibleLength(raw) > c.max ? fit(raw, c.max) : raw;
  };
  const widths = opts.columns.map((c, i) => Math.max(c.header?.length ?? 0, ...opts.rows.map((r) => visibleLength(cell(c, r))), i === opts.columns.length - 1 ? 0 : 1));
  const lines: string[] = [];
  if (opts.columns.some((c) => c.header)) {
    lines.push(fit(indent + opts.columns.map((c, i) => padEnd(theme.dim((c.header ?? "").toLowerCase()), widths[i])).join("  "), opts.width));
  }
  for (const r of opts.rows) {
    const rowPaint = opts.rowPaint?.(r) ?? null;
    const cells = opts.columns.map((c, i) => {
      const text = cell(c, r);
      const padded = c.align === "right" ? padStart(text, widths[i]) : padEnd(text, widths[i]);
      if (rowPaint) return rowPaint(padded);
      return c.paint ? c.paint(padded, r) : theme.fg(padded);
    });
    lines.push(fit(indent + cells.join("  "), opts.width));
  }
  return lines.join("\n");
}

// ── Formatting helpers shared by the screens ─────────────────────────────────

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function fmtClock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function relTime(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return iso.slice(0, 10);
}

export function hoursUntil(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const h = Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 3_600_000));
  return `${h} h`;
}

export function profileLabel(id: string | null | undefined): string {
  if (!id || id === "auto") return "auto";
  return id.replace(/^(.)/, (m) => m.toUpperCase()).replace("-enhanced", "-Enhanced").replace("-advanced", "-Advanced");
}
