import { describe, expect, it } from "vitest";
import { cleanPath, completePath, pickerInit, pickerReduce, pickerSetCompletions, renderPicker, type PickerState } from "../../src/session/picker.js";
import type { KeyEvent } from "../../src/session/keys.js";
import { makeTheme, } from "../../src/ui/theme.js";
import { stripAnsi, visibleLength } from "../../src/ui/tty.js";

const items = [
  { label: "eclipsa", detail: "Eclipsa Audio", value: "eclipsa" },
  { label: "iamf-2", detail: "needs 2.0", value: "iamf-2", disabled: "engine too old" },
  { label: "stereo", detail: "plain", value: "stereo" },
];
function run(s: PickerState, ...keys: KeyEvent[]): [PickerState, unknown] {
  let eff: unknown = null;
  for (const k of keys) [s, eff] = pickerReduce(s, k);
  return [s, eff];
}
const down: KeyEvent = { kind: "down" };
const up: KeyEvent = { kind: "up" };

describe("picker", () => {
  it("navigates list to field and back", () => {
    const [s0] = run(pickerInit(items, { field: true }), down, down);
    expect(s0.index).toBe(2);
    const [s1] = run(s0, down);
    expect(s1.focus).toBe("field");
    const [s2] = run(s1, up);
    expect(s2.focus).toBe("list");
    const [s3] = run(pickerInit(items, {}), down, down, down);
    expect(s3.focus).toBe("list");
    expect(s3.index).toBe(2);
  });
  it("enter picks; disabled cannot be picked", () => {
    expect(run(pickerInit(items, {}), { kind: "enter" })[1]).toEqual({ kind: "pick", value: "eclipsa" });
    expect(run(pickerInit(items, {}), down, { kind: "enter" })[1]).toBeNull();
  });
  it("escape goes back", () => {
    expect(run(pickerInit(items, {}), { kind: "escape" })[1]).toEqual({ kind: "back" });
  });
  it("pasted path is trimmed and picked", () => {
    const [s0] = run(pickerInit(items, { field: true }), down, down, down);
    const [, eff] = run(s0, { kind: "paste", text: "  /Users/ben/Masters/Moment 2 (Atmos).wav  " });
    expect(eff).toEqual({ kind: "pick", value: "/Users/ben/Masters/Moment 2 (Atmos).wav" });
    const [, e2] = run(s0, { kind: "paste", text: "/a/Moment\\ 2.wav\n" });
    expect(e2).toEqual({ kind: "pick", value: "/a/Moment 2.wav" });
  });
  it("keeps the backslashes of a Windows path (only shell escapes are unescaped)", () => {
    expect(cleanPath("C:\\Users\\me\\Masters\\a.wav")).toBe("C:\\Users\\me\\Masters\\a.wav");
    expect(cleanPath("/a/b\\ c\\&d.wav")).toBe("/a/b c&d.wav");
  });
  it("dropped paths: quoted, fully backslash-escaped, and pasted while the list has focus", () => {
    const want = { kind: "pick", value: "/a/b (1).wav" };
    const field = run(pickerInit(items, { field: true }), down, down, down)[0];
    expect(run(field, { kind: "paste", text: '"/a/b (1).wav"' })[1]).toEqual(want);
    expect(run(field, { kind: "paste", text: "'/a/b (1).wav'\n" })[1]).toEqual(want);
    expect(run(field, { kind: "paste", text: "/a/b\\ \\(1\\).wav" })[1]).toEqual(want);
    const [s, eff] = run(pickerInit(items, { field: true }), { kind: "paste", text: "/a/b\\ \\(1\\).wav " });
    expect(eff).toEqual(want);
    expect(s.focus).toBe("field");
    expect(s.field.text).toBe("/a/b (1).wav");
    // a list-only picker has nowhere to put a path
    expect(run(pickerInit(items, {}), { kind: "paste", text: "/a/b.wav" })[1]).toBeNull();
  });
  it("field typing, enter with text picks, empty does nothing", () => {
    const [s] = run(pickerInit(items, { field: true }), down, down, down);
    expect(run(s, { kind: "enter" })[1]).toBeNull();
    const [t, eff] = run(s, { kind: "char", ch: "a" }, { kind: "char", ch: "b" }, { kind: "backspace" }, { kind: "enter" });
    expect(t.field.text).toBe("a");
    expect(eff).toEqual({ kind: "pick", value: "a" });
  });
  it("tab completes then cycles", () => {
    const [s] = run(pickerInit(items, { field: true, initialText: "~/M" }), down, down, down);
    const [, eff] = run(s, { kind: "tab" });
    expect(eff).toEqual({ kind: "complete", text: "~/M" });
    let c = pickerSetCompletions(s, ["~/Masters/", "~/Mixes/"]);
    expect(c.field.text).toBe("~/Masters/");
    expect(c.field.completionIndex).toBe(0);
    [c] = run(c, { kind: "tab" });
    expect(c.field.text).toBe("~/Mixes/");
    [c] = run(c, { kind: "tab" });
    expect(c.field.text).toBe("~/Masters/");
    [c] = run(c, { kind: "char", ch: "x" });
    expect(c.field.completions).toEqual([]);
    expect(c.field.completionIndex).toBeNull();
  });
  it("a pristine suggestion is replaced by the first character and cleared by backspace; moving the cursor keeps it", () => {
    const start = { ...pickerInit([], { field: true, initialText: "/a/b/out.iamf", pristine: true }), focus: "field" as const };
    let [s] = run(start, { kind: "char", ch: "~" });
    expect(s.field.text).toBe("~");
    expect(s.field.pristine).toBe(false);
    [s] = run(start, { kind: "backspace" });
    expect(s.field.text).toBe("");
    [s] = run(start, { kind: "left" }, { kind: "char", ch: "x" });
    expect(s.field.text).toBe("/a/b/out.iamxf");
    expect(run(start, { kind: "enter" })[1]).toEqual({ kind: "pick", value: "/a/b/out.iamf" });
  });
  it("the field line keeps the cursor on screen when the path is wider than the window", () => {
    const theme = makeTheme({ colour: "none", width: 60, isTTY: false } as never);
    const long = "/Volumes/Blueberry/Work/Orbit Spatial/Orbit/Test Media/Test_Files/Illuma - Demo Track - Orbit.iamf";
    const s = { ...pickerInit([], { field: true, initialText: long }), focus: "field" as const };
    const [, field] = renderPicker(theme, 60, s, "output", "Enter accepts").map(stripAnsi);
    expect(visibleLength(field!)).toBeLessThanOrEqual(60);
    expect(field!.endsWith("Orbit.iamf▏")).toBe(true);
    expect(field!.startsWith("  › …")).toBe(true);
    const [t] = run(s, { kind: "char", ch: "Z" });
    const [, after] = renderPicker(theme, 60, t, "output", "Enter accepts").map(stripAnsi);
    expect(after!.endsWith("Orbit.iamfZ▏")).toBe(true);
  });
  it("renders within width", () => {
    const theme = makeTheme({ colour: "none", width: 60, isTTY: false } as never);
    const s = pickerInit(items, { field: true });
    const lines = renderPicker(theme, 60, s, "format", "enter to pick");
    expect(lines.every((l) => visibleLength(l) <= 60)).toBe(true);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("❯ eclipsa");
    expect(plain).toContain("engine too old");
    expect(plain).toContain("›");
  });
});

describe("completePath", () => {
  const tree: Record<string, string[]> = {
    "/home/ben/": ["Masters", "Mixes", "notes.txt", "Mon.wav"],
    "/home/ben/Masters/": ["a.wav", "b.BWF", "c.mp3", "Sub"],
    "./": ["x.bw64", "x.w64"],
  };
  const dirs = new Set(["/home/ben/Masters", "/home/ben/Mixes", "/home/ben/Masters/Sub"]);
  const fs = {
    readdir: (d: string) => {
      const r = tree[d];
      if (!r) throw new Error("ENOENT");
      return r;
    },
    isDir: (p: string) => dirs.has(p.replace(/\/$/, "")),
  };
  it("completes dirs with ~ and files with prefix", () => {
    expect(completePath("~/Mas", fs, "/home/ben")).toEqual(["~/Masters/"]);
    expect(completePath("~/M", fs, "/home/ben")).toEqual(["~/Masters/", "~/Mixes/", "~/Mon.wav"]);
  });
  it("only audio files inside a directory, dirs first", () => {
    expect(completePath("~/Masters/", fs, "/home/ben")).toEqual(["~/Masters/Sub/", "~/Masters/a.wav", "~/Masters/b.BWF"]);
  });
  it("bare prefix uses ./ and bad dir is empty", () => {
    expect(completePath("x", fs, "/h")).toEqual(["./x.bw64"]);
    expect(completePath("/nope/a", fs, "/h")).toEqual([]);
  });
});
