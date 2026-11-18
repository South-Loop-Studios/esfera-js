import { describe, expect, it } from "vitest";
import { KeyParser, type KeyEvent } from "../../src/session/keys.js";

const parse = (s: string) => new KeyParser().feed(s);

describe("KeyParser", () => {
  it("plain keys", () => {
    expect(parse("a\r\n\t\x7f\b")).toEqual([
      { kind: "char", ch: "a" }, { kind: "enter" }, { kind: "tab" }, { kind: "backspace" }, { kind: "backspace" },
    ]);
    expect(parse("\n")).toEqual([{ kind: "enter" }]);
  });
  it("escape sequences", () => {
    expect(parse("\x1b[3~")).toEqual([{ kind: "delete" }]);
    expect(parse("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([{ kind: "up" }, { kind: "down" }, { kind: "right" }, { kind: "left" }]);
    expect(parse("\x1b[H\x1b[F\x1b[1~\x1b[4~")).toEqual([{ kind: "home" }, { kind: "end" }, { kind: "home" }, { kind: "end" }]);
  });
  it("ctrl keys", () => {
    expect(parse("\x03\x04\x0c\x15\x0b\x01\x05\x17").map((e) => (e as { ch: string }).ch).join("")).toBe("cdlukaew");
  });
  it("escape followed by a non-sequence char is escape then the char", () => {
    expect(parse("\x1bx")).toEqual([{ kind: "escape" }, { kind: "char", ch: "x" }]);
  });
  it("a lone trailing ESC is held, then flushed or continued", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b")).toEqual([]);
    expect(p.flush()).toEqual([{ kind: "escape" }]);
    expect(p.feed("\x1b")).toEqual([]);
    expect(p.feed("[A")).toEqual([{ kind: "up" }]);
    expect(p.feed("\x1b")).toEqual([]);
    expect(p.feed("q")).toEqual([{ kind: "escape" }, { kind: "char", ch: "q" }]);
  });
  it("page keys and SGR mouse-wheel reports; clicks are dropped", () => {
    const p = new KeyParser();
    expect(p.feed("\x1b[5~\x1b[6~")).toEqual([{ kind: "pageup" }, { kind: "pagedown" }]);
    expect(p.feed("\x1b[<64;10;5M\x1b[<65;10;5M")).toEqual([{ kind: "wheel", dir: "up" }, { kind: "wheel", dir: "down" }]);
    expect(p.feed("\x1b[<68;10;5M")).toEqual([{ kind: "wheel", dir: "up" }]);   // shift held
    expect(p.feed("\x1b[<0;1;1M\x1b[<0;1;1m\x1b[<32;4;4M")).toEqual([]);     // click, release, drag
  });

  it("drops unknown CSI sequences", () => {
    expect(parse("\x1b[99Zb")).toEqual([{ kind: "char", ch: "b" }]);
  });
  it("paste in one chunk normalises line endings", () => {
    expect(parse("\x1b[200~a\r\nb\rc\x1b[201~")).toEqual([{ kind: "paste", text: "a\nb\nc" }]);
  });
  it("paste split across three chunks (even mid-marker) is one event", () => {
    const p = new KeyParser();
    const ev: KeyEvent[] = [];
    for (const c of ["\x1b[20", "0~hello \x1b[A wor", "ld\x1b[20", "1~z"]) ev.push(...p.feed(c));
    expect(ev).toEqual([{ kind: "paste", text: "hello \x1b[A world" }, { kind: "char", ch: "z" }]);
  });
  it("UTF-8 split across bytes is one char", () => {
    const p = new KeyParser();
    expect(p.feed(Uint8Array.of(0xc3))).toEqual([]);
    expect(p.feed(Uint8Array.of(0xa9))).toEqual([{ kind: "char", ch: "é" }]);
    expect(parse("😀")).toEqual([{ kind: "char", ch: "😀" }]);
  });
});
