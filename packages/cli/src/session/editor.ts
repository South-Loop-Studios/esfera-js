/** Pure single-line editor reducer for the session prompt. */
import type { KeyEvent } from "./keys.js";

export interface EditorState {
  text: string;
  cursor: number;
  history: string[];
  historyIndex: number | null;
  draft: string;
}
export type EditorEffect = { kind: "submit"; text: string } | { kind: "complete" } | { kind: "escape" } | null;

export function editorInit(history: string[]): EditorState {
  return { text: "", cursor: 0, history: [...history], historyIndex: null, draft: "" };
}

function setText(s: EditorState, text: string, cursor: number): EditorState {
  return { ...s, text, cursor, historyIndex: null };
}

function insert(s: EditorState, t: string): EditorState {
  return setText(s, s.text.slice(0, s.cursor) + t + s.text.slice(s.cursor), s.cursor + t.length);
}

export function editorReduce(s: EditorState, e: KeyEvent): [EditorState, EditorEffect] {
  switch (e.kind) {
    case "char":
      return [insert(s, e.ch), null];
    case "paste":
      return [insert(s, e.text.replace(/[\r\n]+/g, " ")), null];
    case "left":
      return [{ ...s, cursor: Math.max(0, s.cursor - 1) }, null];
    case "right":
      return [{ ...s, cursor: Math.min(s.text.length, s.cursor + 1) }, null];
    case "home":
      return [{ ...s, cursor: 0 }, null];
    case "end":
      return [{ ...s, cursor: s.text.length }, null];
    case "ctrl":
      if (e.ch === "a") return [{ ...s, cursor: 0 }, null];
      if (e.ch === "e") return [{ ...s, cursor: s.text.length }, null];
      if (e.ch === "u") return [setText(s, s.text.slice(s.cursor), 0), null];
      if (e.ch === "k") return [setText(s, s.text.slice(0, s.cursor), s.cursor), null];
      if (e.ch === "w") {
        let i = s.cursor;
        while (i > 0 && s.text[i - 1] === " ") i--;
        while (i > 0 && s.text[i - 1] !== " ") i--;
        return [setText(s, s.text.slice(0, i) + s.text.slice(s.cursor), i), null];
      }
      return [s, null];
    case "backspace":
      if (s.cursor === 0) return [s, null];
      return [setText(s, s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), s.cursor - 1), null];
    case "delete":
      if (s.cursor >= s.text.length) return [s, null];
      return [setText(s, s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), s.cursor), null];
    case "up": {
      if (s.history.length === 0) return [s, null];
      const idx = s.historyIndex === null ? s.history.length - 1 : Math.max(0, s.historyIndex - 1);
      const text = s.history[idx]!;
      return [{ ...s, text, cursor: text.length, historyIndex: idx, draft: s.historyIndex === null ? s.text : s.draft }, null];
    }
    case "down": {
      if (s.historyIndex === null) return [s, null];
      if (s.historyIndex >= s.history.length - 1) {
        return [{ ...s, text: s.draft, cursor: s.draft.length, historyIndex: null }, null];
      }
      const idx = s.historyIndex + 1;
      const text = s.history[idx]!;
      return [{ ...s, text, cursor: text.length, historyIndex: idx }, null];
    }
    case "enter": {
      const text = s.text.trim();
      const history = text && s.history[s.history.length - 1] !== text ? [...s.history, text] : s.history;
      return [{ text: "", cursor: 0, history, historyIndex: null, draft: "" }, { kind: "submit", text }];
    }
    case "tab":
      return [s, { kind: "complete" }];
    case "escape":
      if (s.text === "") return [s, { kind: "escape" }];
      return [setText(s, "", 0), null];
    default:
      return [s, null];
  }
}
