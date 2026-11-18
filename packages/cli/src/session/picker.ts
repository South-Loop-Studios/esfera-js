/** Pure picker (list + optional path field) state machine and renderer. */
import type { KeyEvent } from "./keys.js";
import type { Theme } from "../ui/theme.js";
import { eyebrow } from "../ui/parts.js";
import { fit, fitAround } from "../ui/tty.js";
import { AUDIO_FILE } from "../audioFiles.js";

export interface PickerItem { label: string; detail: string; value: string; disabled?: string | null }
export interface PickerField {
  enabled: boolean; text: string; cursor: number; completions: string[]; completionIndex: number | null;
  /** The text is a suggestion nobody has touched: the first character typed replaces it. */
  pristine?: boolean;
}
export interface PickerState { items: PickerItem[]; index: number; field: PickerField; focus: "list" | "field" }
export type PickerEffect = { kind: "pick"; value: string } | { kind: "back" } | { kind: "complete"; text: string } | null;

export function pickerInit(items: PickerItem[], opts: { field?: boolean; initialText?: string; pristine?: boolean }): PickerState {
  const text = opts.initialText ?? "";
  return {
    items,
    index: 0,
    field: { enabled: !!opts.field, text, cursor: text.length, completions: [], completionIndex: null, ...(opts.pristine ? { pristine: true } : {}) },
    focus: "list",
  };
}

/**
 * A dropped or typed path as the shell would read it: trim, strip one pair of
 * surrounding quotes (GNOME Terminal, Konsole), then unescape every `\x` → `x`
 * (Terminal.app and iTerm2 escape spaces, `( ) ' & [ ]` and more).
 */
export function cleanPath(t: string): string {
  let p = t.trim();
  if (p.length >= 2 && (p[0] === "'" || p[0] === '"') && p[p.length - 1] === p[0]) return p.slice(1, -1).trim();
  // Shell-style escapes from a Finder/terminal drag: `\ `, `\(`, `\&`. A backslash
  // before a letter, digit or `\` is left alone so a Windows path survives.
  p = p.replace(/\\([ !"#$&'()*,;<=>?\[\]^`{|}~])/g, "$1");
  return p.trim();
}

export function pickerReduce(s: PickerState, e: KeyEvent): [PickerState, PickerEffect] {
  if (e.kind === "escape") return [s, { kind: "back" }];
  // A paste is a drop: it picks the path wherever focus is.
  if (e.kind === "paste" && s.field.enabled) {
    const text = cleanPath(e.text);
    if (!text) return [s, null];
    return [{ ...s, focus: "field", field: { ...s.field, text, cursor: text.length, completions: [], completionIndex: null } }, { kind: "pick", value: text }];
  }
  if (s.focus === "list") {
    if (e.kind === "up") return [{ ...s, index: Math.max(0, s.index - 1) }, null];
    if (e.kind === "down") {
      if (s.index < s.items.length - 1) return [{ ...s, index: s.index + 1 }, null];
      if (s.field.enabled) return [{ ...s, focus: "field" }, null];
      return [s, null];
    }
    if (e.kind === "enter") {
      const it = s.items[s.index];
      if (!it || it.disabled) return [s, null];
      return [s, { kind: "pick", value: it.value }];
    }
    return [s, null];
  }
  // field focus
  const f = s.field;
  const reset = { completions: [] as string[], completionIndex: null as number | null, pristine: false };
  const withField = (p: Partial<PickerField>): PickerState => ({ ...s, field: { ...f, ...p } });
  if (f.pristine) {
    // A suggested path behaves like selected text: typing replaces it, backspace clears it.
    if (e.kind === "char") return [withField({ text: e.ch, cursor: e.ch.length, ...reset }), null];
    if (e.kind === "backspace") return [withField({ text: "", cursor: 0, ...reset }), null];
  }
  switch (e.kind) {
    case "up":
      return [{ ...s, focus: "list", field: { ...f, ...reset } }, null];
    case "down":
      return [s, null];
    case "enter": {
      const text = cleanPath(f.text);
      return text ? [s, { kind: "pick", value: text }] : [s, null];
    }
    case "tab": {
      if (f.completions.length === 0) return [s, { kind: "complete", text: f.text }];
      const i = ((f.completionIndex ?? -1) + 1) % f.completions.length;
      const text = f.completions[i]!;
      return [withField({ text, cursor: text.length, completionIndex: i }), null];
    }
    case "char":
      return [withField({ text: f.text.slice(0, f.cursor) + e.ch + f.text.slice(f.cursor), cursor: f.cursor + e.ch.length, ...reset }), null];
    case "backspace":
      if (f.cursor === 0) return [withField({ ...reset }), null];
      return [withField({ text: f.text.slice(0, f.cursor - 1) + f.text.slice(f.cursor), cursor: f.cursor - 1, ...reset }), null];
    case "delete":
      return [withField({ text: f.text.slice(0, f.cursor) + f.text.slice(f.cursor + 1), ...reset }), null];
    case "left":
      return [withField({ cursor: Math.max(0, f.cursor - 1), ...reset }), null];
    case "right":
      return [withField({ cursor: Math.min(f.text.length, f.cursor + 1), ...reset }), null];
    case "home":
      return [withField({ cursor: 0, ...reset }), null];
    case "end":
      return [withField({ cursor: f.text.length, ...reset }), null];
    case "ctrl":
      if (e.ch === "u") return [withField({ text: "", cursor: 0, ...reset }), null];
      return [withField({ ...reset }), null];
    default:
      return [s, null];
  }
}

export function pickerSetCompletions(s: PickerState, completions: string[]): PickerState {
  if (completions.length === 0) return { ...s, field: { ...s.field, completions: [], completionIndex: null } };
  const text = completions[0]!;
  return { ...s, field: { ...s.field, completions: [...completions], completionIndex: 0, text, cursor: text.length } };
}

export function renderPicker(theme: Theme, width: number, s: PickerState, title: string, hint: string): string[] {
  const lines: string[] = [eyebrow(theme, title)];
  s.items.forEach((it, i) => {
    const focused = s.focus === "list" && i === s.index;
    const lead = focused ? "  " + theme.brand("❯") + " " : "    ";
    const label = it.disabled ? theme.faint(it.label) : focused ? theme.bold(theme.fg(it.label)) : theme.fg(it.label);
    const detail = it.disabled ? theme.faint(it.detail + "   · " + it.disabled) : theme.dim(it.detail);
    lines.push(lead + label + "  " + detail);
  });
  if (s.field.enabled) {
    const t = s.field.text;
    const focused = s.focus === "field";
    const text = focused ? t.slice(0, s.field.cursor) + "▏" + t.slice(s.field.cursor) : t;
    // Keep the cursor on screen however long the path is ("  › " takes 4 columns).
    const shown = fitAround(text, focused ? s.field.cursor : 0, width - 4);
    lines.push("  " + theme.brand("›") + " " + (s.field.pristine ? theme.dim(shown) : theme.fg(shown)));
  }
  lines.push("  " + theme.faint(hint));
  return lines.map((l) => fit(l, width));
}


export function completePath(
  text: string,
  fs: { readdir(dir: string): string[]; isDir(p: string): boolean },
  home: string,
): string[] {
  const tilde = text === "~" || text.startsWith("~/");
  const expanded = tilde ? home.replace(/\/$/, "") + text.slice(1) : text;
  const slash = expanded.lastIndexOf("/");
  const dir = slash >= 0 ? expanded.slice(0, slash + 1) : "./";
  const prefix = slash >= 0 ? expanded.slice(slash + 1) : expanded;
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    if (fs.isDir(dir + n)) dirs.push(dir + n + "/");
    else if (AUDIO_FILE.test(n)) files.push(dir + n);
  }
  const back = (p: string) => (tilde ? "~" + p.slice(home.replace(/\/$/, "").length) : p);
  return [...dirs.sort(), ...files.sort()].map(back);
}
