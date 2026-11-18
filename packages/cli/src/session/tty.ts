/** Raw-mode terminal wrapper: bracketed paste, resize, and a KeyParser on stdin. */
import { KeyParser, type KeyEvent } from "./keys.js";

export interface RawTerminal {
  write(s: string): void;
  columns: number;
  rows: number;
  onKey(fn: (e: KeyEvent) => void): void;
  onResize(fn: (cols: number) => void): void;
  /** Leave raw mode for a while (a cooked-mode prompt runs); keys stop arriving until resume. */
  suspend(): void;
  resume(): void;
  /** Idempotent: a second call does nothing. */
  close(): void;
}

/** How long a lone ESC is held before it counts as the Escape key. */
const ESC_IDLE_MS = 50;

export function openRawTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): RawTerminal {
  const parser = new KeyParser();
  const keyListeners: Array<(e: KeyEvent) => void> = [];
  const resizeListeners: Array<(cols: number) => void> = [];
  let escTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = (events: KeyEvent[]) => {
    for (const e of events) for (const fn of keyListeners) fn(e);
  };
  const onData = (chunk: Buffer | string) => {
    if (escTimer) clearTimeout(escTimer);
    emit(parser.feed(chunk));
    escTimer = setTimeout(() => emit(parser.flush()), ESC_IDLE_MS);
  };
  const onResize = () => {
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    term.columns = cols;
    term.rows = rows;
    for (const fn of resizeListeners) fn(cols);
    emit([{ kind: "resize", columns: cols, rows }]);
  };

  let raw = false;
  let closed = false;
  const enter = () => {
    if (raw || closed) return;
    stdin.setRawMode(true);
    stdin.resume();
    // Bracketed paste on, hardware cursor off (the prompt draws its own), mouse
    // reporting on in SGR form so the wheel scrolls the transcript. While it is
    // on, selecting text needs the terminal's modifier (Option-drag in Terminal.app).
    stdout.write("\x1b[?2004h\x1b[?25l\x1b[?1000h\x1b[?1006h");
    stdin.on("data", onData);
    raw = true;
  };
  const leave = () => {
    if (!raw) return;
    if (escTimer) clearTimeout(escTimer);
    stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h");
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    raw = false;
  };

  enter();
  stdout.on("resize", onResize);

  const term: RawTerminal = {
    write: (s) => void stdout.write(s),
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
    onKey: (fn) => void keyListeners.push(fn),
    onResize: (fn) => void resizeListeners.push(fn),
    suspend: leave,
    resume: enter,
    close() {
      if (closed) return;
      leave();
      closed = true;
      stdout.off("resize", onResize);
    },
  };
  return term;
}
