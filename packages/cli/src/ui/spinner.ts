/**
 * One live line that rewrites in place while a stage runs. On a non-interactive
 * stream each distinct line is printed once (no animation, no carriage returns),
 * so logs stay readable.
 */
import type { Terminal } from "./tty.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export interface Spinner {
  update(line: string): void;
  /** Stop animating; print `finalLine` (or the last line) permanently. */
  stop(finalLine?: string): void;
  /** Stop animating silently — for error paths, so no timer outlives the command. */
  cancel(): void;
}

export interface WritableLike {
  write(s: string): unknown;
}

export function createSpinner(stream: WritableLike, terminal: Terminal, paint: (frame: string) => string = (f) => f): Spinner {
  let line = "";
  let last = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const draw = () => {
    stream.write(`\r\x1b[K${paint(FRAMES[frame % FRAMES.length])} ${line}`);
    frame++;
  };

  if (!terminal.interactive) {
    return {
      update(l) {
        if (l !== last) { stream.write(l + "\n"); last = l; }
        line = l;
      },
      stop(final) {
        const out = final ?? line;
        if (out && out !== last) stream.write(out + "\n");
      },
      cancel() {},
    };
  }

  return {
    update(l) {
      line = l;
      if (!timer) { draw(); timer = setInterval(draw, INTERVAL_MS); (timer as { unref?: () => void }).unref?.(); }
    },
    stop(final) {
      if (timer) { clearInterval(timer); timer = null; }
      stream.write(`\r\x1b[K${final ?? line}\n`);
    },
    cancel() {
      if (timer) { clearInterval(timer); timer = null; stream.write("\r\x1b[K"); }
    },
  };
}
