import { describe, it, expect } from "vitest";
import { makeTheme, stripAnsi, visibleLength } from "../../src/ui/index.js";
import { Screen } from "../../src/session/screen.js";

const plain = makeTheme({ colour: "none", width: 108, interactive: false });
const STATUS = "esf_k_test_3qrMTinZjc · TEST · staging-api.esfera.audio · no jobs running · help ^C quit";

function rig(width = 108) {
  const out: string[] = [];
  const screen = new Screen((s) => out.push(s), plain, width);
  return { out, screen, text: () => stripAnsi(out.join("")) };
}
const state = (o: Partial<{ live: string[]; prompt: string; promptHint: string; status: string }> = {}) => ({
  live: [], prompt: "convert", promptHint: "", status: STATUS, ...o,
});

describe("Screen", () => {
  it("print erases the block and redraws it exactly once below the printed line", () => {
    const { out, screen, text } = rig();
    screen.banner("session");
    screen.live(state());
    screen.print("done line");
    const lines = text().replace(/\x1b\[\d+A\x1b\[J/g, "").split("\n").filter((l) => l !== "");
    expect(lines.slice(-5)).toEqual(["done line", "╭" + "─".repeat(106) + "╮", "│ › convert" + " ".repeat(106 - 11) + " │", "╰" + "─".repeat(106) + "╯", "  " + STATUS]);
    expect(lines.filter((l) => l.startsWith("│ › convert"))).toHaveLength(2); // once before the erase, once after
    expect(out.join("")).toContain("\x1b[4A\x1b[J");
  });

  it("resize fits every line to the new width", () => {
    const { out, screen } = rig();
    screen.resize(72);
    out.length = 0;
    screen.live(state({ live: ["x".repeat(100)] }));
    for (const l of stripAnsi(out.join("")).split("\n")) expect(visibleLength(l)).toBeLessThanOrEqual(72);
  });

  it("erase after a resize narrower moves up the re-wrapped row count, not the logical line count", () => {
    const { out, screen } = rig(100);
    screen.live(state());           // box top/middle/bottom (100 each) · status (90)
    screen.resize(60, 40);          // layout stays clamped at 60; the terminal is 40 wide
    out.length = 0;
    screen.live(state());
    // 3 × ceil(100/40) + ceil(90/40) = 9 + 3
    expect(out.join("").startsWith("\x1b[12A\x1b[J")).toBe(true);
  });

  it("in a pane narrower than the layout width the box shrinks to the pane, so nothing wraps", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 60, 30);
    screen.live(state());
    for (const l of stripAnsi(out.join("")).split("\n")) expect(visibleLength(l)).toBeLessThanOrEqual(30);
    out.length = 0;
    screen.live(state());
    expect(out.join("").startsWith("\x1b[4A\x1b[J")).toBe(true);
  });

  it("a terminal that reports 0 columns erases by the layout width, not one row per character", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 60, 0);
    screen.live(state());
    out.length = 0;
    screen.live(state());
    expect(out.join("").startsWith("\x1b[4A\x1b[J")).toBe(true);
  });

  it("clear leaves no live lines and never emits a zero-line move", () => {
    const { out, screen } = rig();
    screen.clear();
    expect(out.join("")).toBe("");
    screen.live(state());
    out.length = 0;
    screen.clear();
    expect(out.join("")).toBe("\x1b[4A\x1b[J");
    out.length = 0;
    screen.clear();
    expect(out.join("")).toBe("");
  });

  // ── a known height: full screen — sticky banner, a scrolling viewport, sticky block ──
  const sync = (s: string) => s.replace(/\x1b\[\?2026[hl]/g, "");
  /** The text drawn on a given row, from the last absolute write to it. */
  const rowText = (raw: string, row: number) => {
    const m = [...raw.matchAll(new RegExp(`\\x1b\\[${row};1H([^\\x1b]*)`, "g"))];
    return m.length ? stripAnsi(m[m.length - 1]![1]!) : null;
  };

  it("the first frame enters the alternate screen with the banner on rows 1–2 and the block on the bottom rows", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 40, 40, 12);
    screen.banner("session");
    const first = sync(out.join(""));
    expect(first.startsWith("\x1b[?1049h")).toBe(true);
    expect(rowText(first, 1)!.startsWith("● E S F E R A")).toBe(true);
    expect(rowText(first, 2)).toBe("─".repeat(40));
    screen.print("  home");
    out.length = 0;
    screen.live(state());                     // block = 4 rows → viewport rows 3..8, block rows 9..12
    const raw = sync(out.join(""));
    expect(raw).not.toContain("\x1b[?1049h"); // already there
    expect(raw).not.toMatch(/\x1b\[\d+A/);
    expect(rowText(raw, 3)).toBe("  home");
    expect(rowText(raw, 9)!.startsWith("╭")).toBe(true);
    expect(rowText(raw, 12)!.startsWith("  esf_k_test")).toBe(true);
  });

  it("new output appends below the transcript, then scrolls the viewport, never the banner or the block", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 40, 40, 12);
    screen.banner("session");
    screen.live(state());
    out.length = 0;
    screen.print("one");
    let raw = sync(out.join(""));
    expect(rowText(raw, 1)!.startsWith("● E S F E R A")).toBe(true);
    expect(rowText(raw, 3)).toBe("one");
    expect(rowText(raw, 9)!.startsWith("╭")).toBe(true);
    for (let i = 2; i <= 10; i++) screen.print(`line ${i}`);   // 10 lines into a 6-row viewport
    out.length = 0;
    screen.live(state({ prompt: "x" }));
    raw = sync(out.join(""));
    expect(raw).not.toMatch(/\x1b\[3;1H/);  // same geometry, nothing scrolled: only the block was drawn
    expect(rowText(raw, 10)).toContain("│ › x");
    out.length = 0;
    screen.print("line 11");
    raw = sync(out.join(""));
    expect([3, 4, 5, 6, 7, 8].map((r) => rowText(raw, r))).toEqual(["line 6", "line 7", "line 8", "line 9", "line 10", "line 11"]);
    expect(rowText(raw, 1)!.startsWith("● E S F E R A")).toBe(true);
    expect(rowText(raw, 9)!.startsWith("╭")).toBe(true);
  });

  it("the wheel and page keys move the view over the transcript, clamped, and the status says so", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 60, 60, 12);
    screen.banner("session");
    screen.live(state());
    for (let i = 1; i <= 11; i++) screen.print(`line ${i}`);   // viewport rows 3..8 show 6..11
    out.length = 0;
    screen.scrollBy(2);
    let raw = sync(out.join(""));
    expect([3, 4, 5, 6, 7, 8].map((r) => rowText(raw, r))).toEqual(["line 4", "line 5", "line 6", "line 7", "line 8", "line 9"]);
    expect(rowText(raw, 12)!.startsWith("  ↑ 2 above · PgDn · ")).toBe(true);
    out.length = 0;
    screen.scrollBy(100);                     // clamps at the top: 11 − 6 = 5
    raw = sync(out.join(""));
    expect(rowText(raw, 3)).toBe("line 1");
    expect(rowText(raw, 12)!.startsWith("  ↑ 5 above")).toBe(true);
    out.length = 0;
    screen.scrollBy(1);                       // already at the top: no frame at all
    expect(out.join("")).toBe("");
    screen.scrollPage(-1);                    // a page = 5 rows down → offset 0
    out.length = 0;
    screen.live(state());
    expect(rowText(sync(out.join("")), 12)!.startsWith("  esf_k_test")).toBe(true);
    screen.scrollBy(3);
    out.length = 0;
    screen.print("line 12");                  // new output snaps the view back to the end
    raw = sync(out.join(""));
    expect(rowText(raw, 8)).toBe("line 12");
    expect(rowText(raw, 12)!.startsWith("  esf_k_test")).toBe(true);
  });

  it("a block that changes height moves the viewport's bottom edge and redraws it", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 40, 40, 12);
    screen.banner("session");
    screen.print("one");
    screen.live(state());
    out.length = 0;
    screen.live(state({ live: ["step 1", "step 2"] }));   // 6 rows → viewport rows 3..6, block from row 7
    const raw = sync(out.join(""));
    expect(rowText(raw, 3)).toBe("one");
    expect(rowText(raw, 7)).toBe("step 1");
    expect(rowText(raw, 12)!.startsWith("  esf_k_test")).toBe(true);
  });

  it("resize repaints every row on the next draw at the new size, with the banner regenerated", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 100, 100, 30);
    screen.banner("session");
    screen.live(state());
    for (let i = 1; i <= 40; i++) screen.print(`line ${i}`);
    out.length = 0;
    screen.resize(60, 60, 10);                // narrower AND shorter
    expect(out.join("")).toBe("");            // nothing until the session redraws
    screen.live(state());
    const raw = sync(out.join(""));
    expect(raw).not.toMatch(/\x1b\[\d+A/);
    expect(rowText(raw, 1)).toBe("● E S F E R A" + " ".repeat(60 - 13 - 7) + "session");
    expect(rowText(raw, 2)).toBe("─".repeat(60));
    // 10 rows − 2 (banner) − 4 (block) = 4 viewport rows: the newest four.
    expect([3, 4, 5, 6].map((r) => rowText(raw, r))).toEqual(["line 37", "line 38", "line 39", "line 40"]);
    expect(rowText(raw, 7)).toBe("╭" + "─".repeat(58) + "╮");
    expect(rowText(raw, 10)).toBe("  " + STATUS.slice(0, 58 - 1) + "…");
  });

  it("clear leaves the alternate screen for a cooked-mode command; the next draw returns and repaints", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 40, 40, 12);
    screen.banner("session");
    screen.live(state());
    out.length = 0;
    screen.clear();
    expect(out.join("")).toBe("\x1b[?1049l");
    out.length = 0;
    screen.print("signed in");                // goes into the model; back on the alt screen for the frame
    screen.live(state());
    const raw = sync(out.join(""));
    expect(raw.startsWith("\x1b[?1049h")).toBe(true);
    expect(rowText(raw, 3)).toBe("signed in");
  });

  it("a transcript line wider than the window wraps into rows instead of being cut, and re-wraps on resize", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 40, 40, 12);
    screen.banner("session");
    screen.live(state());
    out.length = 0;
    screen.print("✗ 7eba0f21 · Here.iamf · download failed · ENOENT: no such file or directory, open '/Volumes/x/Here.iamf'");
    let raw = sync(out.join(""));
    const rows = [3, 4, 5].map((r) => rowText(raw, r));
    expect(rows[0]).toBe("✗ 7eba0f21 · Here.iamf · download failed");
    expect(rows[1]!.startsWith("  · ENOENT")).toBe(true);
    expect(rows.join("")).not.toContain("…");
    expect(rows.join("")).toContain("Here.iamf'");
    screen.resize(100, 100, 12);
    out.length = 0;
    screen.live(state());
    raw = sync(out.join(""));
    // 108 columns of text in a 100-column window: two rows now, the break at the last space that fits.
    expect(rowText(raw, 3)).toBe("✗ 7eba0f21 · Here.iamf · download failed · ENOENT: no such file or directory, open");
    expect(rowText(raw, 4)).toBe("  '/Volumes/x/Here.iamf'");
    expect(rowText(raw, 5)).toBe("");
  });

  it("exit restores the main screen and replays the transcript there; later prints are plain lines", () => {
    const out: string[] = [];
    const screen = new Screen((s) => out.push(s), plain, 40, 40, 12);
    screen.banner("session");
    screen.print("one\ntwo");
    screen.live(state());
    out.length = 0;
    screen.exit();
    expect(out.join("")).toBe("\x1b[?1049lone\ntwo\n");
    out.length = 0;
    screen.print("jobs keep running · x");
    expect(out.join("")).toBe("jobs keep running · x\n");
  });

  it("snapshot: Figma 1 home screen at 108", () => {
    const { screen, text } = rig(108);
    screen.banner("session");
    screen.print("  convert · presets · list · get <id> · help · quit\n");
    screen.live({ live: [], prompt: "", promptHint: "convert · presets · list · help", status: STATUS });
    expect(text()).toMatchSnapshot();
  });
});
