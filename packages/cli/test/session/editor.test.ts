import { describe, expect, it } from "vitest";
import { editorInit, editorReduce, type EditorState } from "../../src/session/editor.js";
import type { KeyEvent } from "../../src/session/keys.js";

function run(s: EditorState, ...keys: KeyEvent[]): [EditorState, unknown] {
  let eff: unknown = null;
  for (const k of keys) [s, eff] = editorReduce(s, k);
  return [s, eff];
}
const ch = (c: string): KeyEvent => ({ kind: "char", ch: c });
const type = (t: string) => [...t].map(ch);

describe("editor", () => {
  it("types and moves the cursor", () => {
    const [s] = run(editorInit([]), ...type("helo"), { kind: "left" }, ch("l"));
    expect(s.text).toBe("hello");
    expect(s.cursor).toBe(4);
    const [h] = run(s, { kind: "home" }, { kind: "delete" });
    expect(h.text).toBe("ello");
  });
  it("does not mutate input", () => {
    const s0 = editorInit([]);
    editorReduce(s0, ch("a"));
    expect(s0.text).toBe("");
  });
  it("history restores the draft", () => {
    let [s] = run(editorInit(["one", "two"]), ...type("dra"));
    [s] = run(s, { kind: "up" });
    expect(s.text).toBe("two");
    [s] = run(s, { kind: "up" });
    expect(s.text).toBe("one");
    [s] = run(s, { kind: "down" }, { kind: "down" });
    expect(s.text).toBe("dra");
    expect(s.historyIndex).toBeNull();
  });
  it("ctrl-w, ctrl-u, ctrl-k", () => {
    const [s] = run(editorInit([]), ...type("foo bar baz"), { kind: "ctrl", ch: "w" });
    expect(s.text).toBe("foo bar ");
    const [u] = run(s, { kind: "ctrl", ch: "u" });
    expect(u.text).toBe("");
    const [k] = run(editorInit([]), ...type("abcd"), { kind: "left" }, { kind: "left" }, { kind: "ctrl", ch: "k" });
    expect(k.text).toBe("ab");
  });
  it("enter submits trimmed text and pushes history", () => {
    const [s, eff] = run(editorInit([]), ...type("  go  "), { kind: "enter" });
    expect(eff).toEqual({ kind: "submit", text: "go" });
    expect(s.text).toBe("");
    expect(s.history).toEqual(["go"]);
    const [, e2] = run(s, { kind: "enter" });
    expect(e2).toEqual({ kind: "submit", text: "" });
  });
  it("paste inserts; tab completes; escape clears then escapes", () => {
    const [s] = run(editorInit([]), { kind: "paste", text: "ab" });
    expect(s.text).toBe("ab");
    expect(run(s, { kind: "tab" })[1]).toEqual({ kind: "complete" });
    const [c, e1] = run(s, { kind: "escape" });
    expect(c.text).toBe("");
    expect(e1).toBeNull();
    expect(run(c, { kind: "escape" })[1]).toEqual({ kind: "escape" });
  });
});
