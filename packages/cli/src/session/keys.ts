/**
 * Incremental terminal key parser. Feed it raw stdin chunks; it returns the
 * complete key events and holds back anything partial (a split escape
 * sequence, an open bracketed paste, half a UTF-8 character).
 */
export type KeyEvent =
  | { kind: "char"; ch: string }
  | { kind: "enter" }
  | { kind: "tab" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "escape" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "pageup" }
  | { kind: "pagedown" }
  /** A mouse-wheel notch (SGR mouse reporting); other mouse reports are dropped. */
  | { kind: "wheel"; dir: "up" | "down" }
  | { kind: "ctrl"; ch: "c" | "d" | "l" | "u" | "k" | "a" | "e" | "w" }
  | { kind: "paste"; text: string }
  | { kind: "resize"; columns: number; rows?: number };

const PASTE_END = "\x1b[201~";

const CTRL: Record<string, "c" | "d" | "l" | "u" | "k" | "a" | "e" | "w"> = {
  "\x03": "c",
  "\x04": "d",
  "\x0c": "l",
  "\x15": "u",
  "\x0b": "k",
  "\x01": "a",
  "\x05": "e",
  "\x17": "w",
};

const FINAL_KEYS: Record<string, KeyEvent> = {
  A: { kind: "up" },
  B: { kind: "down" },
  C: { kind: "right" },
  D: { kind: "left" },
  H: { kind: "home" },
  F: { kind: "end" },
};

const TILDE_KEYS: Record<string, KeyEvent> = {
  "1": { kind: "home" },
  "7": { kind: "home" },
  "4": { kind: "end" },
  "8": { kind: "end" },
  "3": { kind: "delete" },
  "5": { kind: "pageup" },
  "6": { kind: "pagedown" },
};

export class KeyParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private buf = "";
  private inPaste = false;
  private pasteText = "";

  feed(chunk: Uint8Array | string): KeyEvent[] {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Emit a held lone ESC as `escape` (call after a short idle timeout). */
  flush(): KeyEvent[] {
    if (!this.inPaste && this.buf === "\x1b") {
      this.buf = "";
      return [{ kind: "escape" }];
    }
    return [];
  }

  private drain(): KeyEvent[] {
    const out: KeyEvent[] = [];
    let i = 0;
    const s = () => this.buf;

    while (i < s().length) {
      if (this.inPaste) {
        const rest = s().slice(i);
        const end = rest.indexOf(PASTE_END);
        if (end >= 0) {
          this.pasteText += rest.slice(0, end);
          out.push({ kind: "paste", text: this.pasteText.replace(/\r\n?/g, "\n") });
          this.pasteText = "";
          this.inPaste = false;
          i += end + PASTE_END.length;
          continue;
        }
        // Keep any tail that might be the start of the end marker.
        let keep = 0;
        for (let n = Math.min(PASTE_END.length - 1, rest.length); n > 0; n--) {
          if (PASTE_END.startsWith(rest.slice(rest.length - n))) {
            keep = n;
            break;
          }
        }
        this.pasteText += rest.slice(0, rest.length - keep);
        i = s().length - keep;
        break;
      }

      const c = s()[i]!;
      if (c === "\x1b") {
        if (i + 1 >= s().length) break; // held: could be the start of a sequence
        const next = s()[i + 1]!;
        if (next === "[") {
          let j = i + 2;
          while (j < s().length && s().charCodeAt(j) >= 0x30 && s().charCodeAt(j) <= 0x3f) j++;
          while (j < s().length && s().charCodeAt(j) >= 0x20 && s().charCodeAt(j) <= 0x2f) j++;
          if (j >= s().length) break; // incomplete CSI
          const fin = s()[j]!;
          const params = s().slice(i + 2, j);
          i = j + 1;
          if (fin === "~" && params === "200") {
            this.inPaste = true;
            this.pasteText = "";
          } else if (fin === "~") {
            const k = TILDE_KEYS[params];
            if (k) out.push(k);
          } else if (params.startsWith("<") && (fin === "M" || fin === "m")) {
            // SGR mouse: CSI < button ; x ; y M (press) / m (release). Buttons 64/65 are the
            // wheel, with shift/meta/ctrl in bits 2–4; everything else is a click we ignore.
            const button = parseInt(params.slice(1), 10) & ~28;
            if (fin === "M" && button === 64) out.push({ kind: "wheel", dir: "up" });
            else if (fin === "M" && button === 65) out.push({ kind: "wheel", dir: "down" });
          } else if (params === "" || /^1(;\d+)?$/.test(params)) {
            const k = FINAL_KEYS[fin];
            if (k) out.push(k);
          }
          continue;
        }
        if (next === "O") {
          if (i + 2 >= s().length) break;
          const k = FINAL_KEYS[s()[i + 2]!];
          if (k) out.push(k);
          i += 3;
          continue;
        }
        out.push({ kind: "escape" });
        i += 1;
        continue;
      }
      if (c === "\r") {
        out.push({ kind: "enter" });
        i += s()[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (c === "\n") out.push({ kind: "enter" });
      else if (c === "\t") out.push({ kind: "tab" });
      else if (c === "\x7f" || c === "\b") out.push({ kind: "backspace" });
      else if (CTRL[c]) out.push({ kind: "ctrl", ch: CTRL[c]! });
      else if (c.charCodeAt(0) >= 0x20) {
        const ch = String.fromCodePoint(s().codePointAt(i)!);
        out.push({ kind: "char", ch });
        i += ch.length;
        continue;
      }
      i += 1;
    }
    this.buf = this.buf.slice(i);
    return out;
  }
}
