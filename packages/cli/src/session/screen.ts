import type { Theme } from "../ui/theme.js";
import { sessionBanner } from "../ui/parts.js";
import { fit, fitAround, padEnd, visibleLength, wrap } from "../ui/tty.js";

export interface ScreenState { width: number; live: string[]; prompt: string; promptHint: string; status: string }

/** Synchronized output (DEC 2026): terminals that know it paint the frame at once; the rest ignore it. */
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
/** Rows the banner owns at the top of the window. */
const BANNER_ROWS = 2;

/**
 * The interactive session's layout: a sticky banner on the top rows, a sticky
 * block (`live lines + the input box + status`) on the bottom rows, and the
 * transcript scrolling in the viewport between them.
 *
 * With a known window height the session runs on the terminal's alternate
 * screen, the way full-screen TUIs do, and owns scrolling itself: the mouse
 * wheel and PageUp/PageDown move a window over the transcript model, new
 * output snaps the view back to the end, and every frame is drawn with
 * absolute cursor positions (no cursor-up arithmetic, no reliance on the
 * terminal's own scrolling). Leaving the session restores the main screen and
 * replays the transcript there, so it lands in the shell's scrollback.
 *
 * Without a height (tests, logs, a pty that reports none) the block is written
 * inline after the transcript and erased by cursor-up before each redraw.
 *
 * Pure drawing: no timers, no stdin. The session hides the hardware cursor and the
 * prompt draws its own.
 */
export class Screen {
  private state: Omit<ScreenState, "width"> | null = null;
  private columns: number;
  /** Terminal height; 0 = unknown, which selects the inline layout. */
  private rows: number;
  /** Everything printed this session, newest last — the model every frame draws from. */
  private transcript: string[] = [];
  private static readonly TRANSCRIPT_MAX = 4000;
  /** The banner is width-dependent (the ramp bar), so each repaint regenerates it. */
  private bannerRight: string | null = null;

  // ── full-screen layout (rows known) ──
  /** On the alternate screen. */
  private alt = false;
  /** Transcript lines scrolled up from the end; 0 = following the newest output. */
  private offset = 0;
  /** The banner and viewport rows need drawing (the block is drawn every frame). */
  private viewDirty = true;
  /** Where the viewport ended last frame: a block that changes height moves it. */
  private lastBottom = 0;
  /** The transcript wrapped into rows at one width; extended as lines arrive, rebuilt on a width change. */
  private rowCache: { width: number; lines: number; rows: string[] } = { width: 0, lines: 0, rows: [] };

  // ── inline layout (rows unknown) ──
  /** Visible length of each line of the block on screen; erase turns these into physical rows. */
  private drawn: number[] = [];

  /**
   * `width` is the layout width (clamped by the caller); `columns` is the real
   * terminal width, which is what the terminal wraps — and re-wraps on resize — at.
   */
  constructor(private readonly write: (s: string) => void, private readonly theme: Theme, private width: number, columns = width, rows = 0) {
    this.columns = columns;
    this.rows = rows;
  }

  banner(right: string): void {
    this.bannerRight = right;
    if (this.rows > 0) { this.viewDirty = true; this.paint(); return; }
    const lines = sessionBanner(this.theme, this.lineWidth(), right).split("\n");
    this.write(lines.join("\n") + "\n");
    this.remember(lines);
  }

  print(lines: string): void {
    const raw = lines.replace(/\n$/, "").split("\n");
    if (this.rows > 0) {
      // Logical lines are kept whole; the frame wraps them to whatever width it has.
      this.remember(raw);
      this.offset = 0; this.viewDirty = true; this.paint(); return;
    }
    const body = raw.map((l) => fit(l, this.lineWidth()));
    this.remember(body);
    this.erase();
    this.write(body.join("\n") + "\n");
    this.draw();
  }

  live(state: Omit<ScreenState, "width">): void {
    this.state = state;
    if (this.rows > 0) { this.paint(); return; }
    this.erase();
    this.draw();
  }

  /** The terminal re-wrapped everything before this arrived: the next draw repaints the window. */
  resize(width: number, columns = width, rows = this.rows): void {
    this.width = width;
    this.columns = columns;
    this.rows = rows;
    this.viewDirty = true;
  }

  /** Move the view over the transcript: positive = towards older lines. Clamped; a no-op draws nothing. */
  scrollBy(lines: number): void {
    if (this.rows === 0) return;
    const next = Math.max(0, Math.min(this.maxOffset(), this.offset + lines));
    if (next === this.offset) return;
    this.offset = next;
    this.viewDirty = true;
    this.paint();
  }

  /** A page is the viewport less one row of overlap. */
  scrollPage(direction: 1 | -1): void {
    this.scrollBy(direction * Math.max(1, this.viewportRows() - 1));
  }

  /**
   * Take the block down and hand the terminal to whoever prints next (a cooked-mode
   * login): back to the main screen; the next `live()` returns and repaints.
   */
  clear(): void {
    if (this.rows > 0) {
      if (this.alt) { this.write(ALT_OFF); this.alt = false; }
      this.state = null;
      this.viewDirty = true;
      return;
    }
    this.erase();
    this.state = null;
  }

  /** Leave for good: main screen back, the transcript replayed into it so the shell keeps it. */
  exit(): void {
    if (this.rows > 0) {
      this.clear();
      if (this.transcript.length) this.write(this.transcript.join("\n") + "\n");
      this.rows = 0; // anything printed after this is a plain line
      return;
    }
    this.clear();
  }

  private remember(lines: string[]): void {
    this.transcript.push(...lines);
    if (this.transcript.length > Screen.TRANSCRIPT_MAX) {
      this.transcript.splice(0, this.transcript.length - Screen.TRANSCRIPT_MAX);
      this.rowCache = { width: 0, lines: 0, rows: [] };
    }
  }

  /** The transcript as rows at width `w`, wrapped; cached and grown incrementally. */
  private rowsAt(w: number): string[] {
    const c = this.rowCache;
    if (c.width !== w) this.rowCache = { width: w, lines: 0, rows: [] };
    const r = this.rowCache;
    for (let i = r.lines; i < this.transcript.length; i++) r.rows.push(...wrap(this.transcript[i]!, w));
    r.lines = this.transcript.length;
    return r.rows;
  }

  // ── full-screen layout ──

  /** Last row of the viewport: the window less the block, never above the banner. */
  private viewportBottom(block: string[] | null): number {
    return Math.max(BANNER_ROWS + 1, this.rows - (block ? block.length : 0));
  }

  private viewportRows(): number {
    return this.viewportBottom(this.block()) - BANNER_ROWS;
  }

  private maxOffset(): number {
    return Math.max(0, this.rowsAt(this.lineWidth()).length - this.viewportRows());
  }

  private paint(): void {
    const block = this.block();
    const bottom = this.viewportBottom(block);
    let out = SYNC_ON;
    if (!this.alt) { out += ALT_ON; this.alt = true; this.viewDirty = true; }
    if (this.viewDirty || bottom !== this.lastBottom) {
      const w = this.lineWidth();
      const banner = this.bannerRight !== null ? sessionBanner(this.theme, w, this.bannerRight).split("\n") : [];
      const vh = bottom - BANNER_ROWS;
      const all = this.rowsAt(w);
      this.offset = Math.min(this.offset, Math.max(0, all.length - vh));
      const end = all.length - this.offset;
      const view = all.slice(Math.max(0, end - vh), end);
      const rows = [...banner, ...view];
      while (rows.length < bottom) rows.push("");
      rows.forEach((l, i) => { out += `\x1b[${i + 1};1H${l}\x1b[K`; });
      this.viewDirty = false;
      this.lastBottom = bottom;
    }
    if (block) block.forEach((l, i) => { out += `\x1b[${bottom + 1 + i};1H${l}\x1b[K`; });
    this.write(out + SYNC_OFF);
  }

  // ── shared ──

  private cols(): number {
    // A pty that reports no size (script(1), some CI) says 0 columns: wrap at the layout width then.
    return this.columns > 0 ? this.columns : Math.max(1, this.width);
  }

  /** Lines are fitted to the narrower of the layout and the terminal, so none of them wraps. */
  private lineWidth(): number {
    return Math.min(this.width, this.cols());
  }

  /** The live block as lines: live rows, the input box, the status line. Null until `live()` ran. */
  private block(): string[] | null {
    const s = this.state;
    if (!s) return null;
    const t = this.theme;
    const w = this.lineWidth();
    // The input box: ╭─╮ · │ › text   hint │ · ╰─╯, the hint right-aligned inside when it fits.
    const room = w - 4; // "│ " + " │"
    // A long command slides under the box so the cursor (▏) stays on screen.
    const cur = s.prompt.indexOf("▏");
    let inner = t.brand("› ") + (cur >= 0 ? fitAround(s.prompt, cur, room - 2) : s.prompt);
    if (s.promptHint) {
      const gap = room - visibleLength(inner) - s.promptHint.length;
      if (gap >= 2) inner = padEnd(inner, room - s.promptHint.length) + t.dim(s.promptHint);
    }
    inner = padEnd(fit(inner, room), room);
    const edge = t.faint;
    const box = [
      edge("╭" + "─".repeat(w - 2) + "╮"),
      edge("│ ") + inner + edge(" │"),
      edge("╰" + "─".repeat(w - 2) + "╯"),
    ];
    const status = this.offset > 0 ? `↑ ${this.offset} above · PgDn · ${s.status}` : s.status;
    return [...s.live, ...box, t.faint("  " + status)].map((l) => fit(l, w));
  }

  // ── inline layout ──

  /** Physical rows the drawn block takes now: a resize narrower re-wraps every line before we erase. */
  private blockRows(): number {
    const cols = this.cols();
    return this.drawn.reduce((n, len) => n + Math.max(1, Math.ceil(len / cols)), 0);
  }

  private erase(): void {
    const rows = this.blockRows();
    if (rows > 0) this.write(`\x1b[${rows}A\x1b[J`);
    this.drawn = [];
  }

  private draw(): void {
    const block = this.block();
    if (!block) return;
    this.write(block.join("\n") + "\n");
    this.drawn = block.map((l) => visibleLength(l));
  }
}
