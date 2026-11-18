import { describe, it, expect } from "vitest";
import { detectTerminal, makeTheme, visibleLength, stripAnsi } from "../src/ui/index.js";
import { sessionBanner } from "../src/ui/index.js";
import { renderLogin, renderConvertLive, renderConvertReady, renderPresets, renderConversions, renderError, renderDeviceCode, renderJobLine, describeOutput } from "../src/ui/index.js";
import type { Conversion, PresetsResponse } from "@esfera/sdk";

// Sample data = the Figma direction-D frames (file seriDPLQ6YGOjh78XVNU3G, row at y≈68570).
const plain = makeTheme({ colour: "none", width: 108, interactive: false });
const conv = (o: Partial<Conversion>): Conversion => ({
  id: "conv_8f3a2c91", name: "Moment 2 (Atmos).wav", status: "ready", stage: null, progress: 100, sourceDurationSec: 402, outputDurationSec: 402,
  outputChannels: 28, objectCount: 16, outputLoudnessLufs: -18, outputSizeBytes: 15_800_000, errorMessage: null,
  createdAt: "2026-11-07T22:00:00Z", updatedAt: "2026-11-07T22:02:00Z", programmeCount: 1, preset: "esfera", programme: null,
  expiresAt: "2026-11-10T22:02:00Z", profile: "advanced-2", outputProfile: "advanced-2", source: { kind: "adm", order: null, normalization: null }, output: null, ...o,
});
const presets: PresetsResponse = {
  engine: { orbitcore: "2.2.0" },
  profiles: [
    { id: "simple", code: 0, family: "eclipsa", label: "Simple", maxElements: 1, maxChannels: 16, objects: false, writable: true },
    { id: "base", code: 1, family: "eclipsa", label: "Base", maxElements: 2, maxChannels: 18, objects: false, writable: true },
    { id: "base-enhanced", code: 2, family: "eclipsa", label: "Base-Enhanced", maxElements: 28, maxChannels: 28, objects: false, writable: true },
    { id: "base-advanced", code: 3, family: "iamf-2", label: "Base-Advanced", maxElements: 18, maxChannels: 18, objects: true, writable: false },
    { id: "advanced-1", code: 4, family: "iamf-2", label: "Advanced-1", maxElements: 18, maxChannels: 18, objects: true, writable: true },
    { id: "advanced-2", code: 5, family: "iamf-2", label: "Advanced-2", maxElements: 28, maxChannels: 28, objects: true, writable: true },
  ],
  presets: [
    { id: "esfera", label: "Esfera", declares: ["base-enhanced", "advanced-1", "advanced-2"], objects: "keep", inputs: ["adm"], description: "" },
    { id: "youtube", label: "YouTube", declares: ["base"], objects: "fold", inputs: ["adm"], description: "" },
    { id: "bed714_3oa", label: "7.1.4 + 3OA", declares: ["base-enhanced"], objects: "scene", inputs: ["adm"], description: "" },
    { id: "oa3", label: "3OA only", declares: ["base"], objects: "scene", inputs: ["adm"], description: "" },
  ],
};
const list: Conversion[] = [
  conv({}),
  conv({ id: "conv_1b77e0d4", name: "PERLAS_final_v3.wav", status: "running", stage: "encoding", progress: 34, preset: "youtube", profile: "base", outputProfile: null }),
  conv({ id: "conv_c0ffee12", name: "Obsidian (stems).wav", status: "queued", progress: 0, profile: "auto", outputProfile: null }),
  conv({ id: "conv_77aa0b3e", name: "Horizon_ADM.wav", preset: "oa3", profile: "base", outputProfile: "base", createdAt: "2026-11-06T09:00:00Z" }),
  conv({ id: "conv_42d1f9ab", name: "demo_bed_only.wav", status: "error", errorMessage: "IAMF profile mismatch", profile: "advanced-1", outputProfile: null, createdAt: "2026-11-05T09:00:00Z" }),
  conv({ id: "conv_9e8d7c6b", name: "Sunrise_7.1.4.wav", preset: "bed714_3oa", profile: "base-enhanced", outputProfile: "base-enhanced", createdAt: "2026-11-04T09:00:00Z" }),
];
const env = { label: "LIVE", host: "api.esfera.audio", user: "ben" };
const NOW = new Date("2026-11-07T22:04:00Z");

const widest = (s: string) => Math.max(...s.split("\n").map((l) => l.length));

describe("detectTerminal / makeTheme", () => {
  it("NO_COLOR, TERM=dumb and a non-TTY all disable colour; truecolor needs COLORTERM and a TTY", () => {
    expect(detectTerminal({ NO_COLOR: "" }, { isTTY: true, columns: 120 }).colour).toBe("none");
    expect(detectTerminal({ TERM: "dumb" }, { isTTY: true, columns: 120 }).colour).toBe("none");
    expect(detectTerminal({ COLORTERM: "truecolor" }, { isTTY: false, columns: 120 }).colour).toBe("none");
    expect(detectTerminal({ COLORTERM: "truecolor" }, { isTTY: true, columns: 120 }).colour).toBe("truecolor");
    expect(detectTerminal({ TERM: "xterm-256color" }, { isTTY: true, columns: 120 })).toEqual({ colour: "256", width: 120, interactive: true });
    expect(detectTerminal({}, { isTTY: true, columns: 20 }).width).toBe(60);
    expect(detectTerminal({}, { isTTY: false }).width).toBe(100);
  });
  it("the source badge names the ambisonic order, ADM, or a plain WAV", () => {
    const badge = (o: object) => renderConvertLive(plain, 108, { env, file: "a.wav", out: "a.iamf", source: { channels: 16, sampleRate: 48000, bitsPerSample: 24, durationSec: 10, programmeCount: 0, objectCount: 0, isAdm: false, ambisonicOrder: null, ...o }, stages: [] });
    expect(badge({ ambisonicOrder: 3 })).toContain("3OA  16 ch");
    expect(badge({ ambisonicOrder: 1 })).toContain("1OA  16 ch");
    expect(badge({ isAdm: true })).toContain("ADM  16 ch");
    expect(badge({})).toContain("WAV  16 ch");
  });
  it("the plain theme is the identity; the brand ramp colours each character in truecolor", () => {
    expect(plain.brand("ESFERA")).toBe("ESFERA");
    const tc = makeTheme({ colour: "truecolor", width: 108, interactive: true });
    expect(tc.brand("AB")).toMatch(/^\x1b\[38;2;249;115;22mA\x1b\[38;2;236;72;153mB\x1b\[0m$/);
    expect(tc.success("ok")).toContain("\x1b[38;2;34;197;94m");
  });
});

describe("direction D screens at 108 columns (the Figma frames)", () => {
  it("login", () => {
    expect(renderLogin(plain, 108, { env, keyId: "esf_k_live_7fQ2mR8xKp", plan: "pro", name: "Sam Rivera", path: "~/.config/esfera/credentials" })).toMatchSnapshot();
  });
  it("convert · live", () => {
    expect(renderConvertLive(plain, 108, {
      env, file: "Moment 2 (Atmos).wav", out: "moment-2.iamf",
      source: { channels: 28, sampleRate: 48000, bitsPerSample: 24, durationSec: 402, programmeCount: 1, isAdm: true, objectCount: 16 },
      stages: [
        { state: "done", label: "uploaded", detail: "1.9 GB in 0:46 · 42 MB/s" },
        { state: "done", label: "analysed", detail: "Esfera keeps the objects discrete" },
        { state: "active", label: "encoding", bar: { pct: 52 }, suffix: "advanced-2 · ~0:48 left" },
        { state: "pending", label: "ready" },
      ],
      id: "conv_8f3a2c91",
    })).toMatchSnapshot();
  });
  it("convert · ready", () => {
    expect(renderConvertReady(plain, 108, { env, file: "Moment 2 (Atmos).wav", out: "moment-2.iamf", conversion: conv({}), encodeSec: 111, uploadDetail: "1.9 GB in 0:46", now: NOW })).toMatchSnapshot();
  });
  it("presets", () => {
    expect(renderPresets(plain, 108, { env, presets })).toMatchSnapshot();
  });
  it("conversions list", () => {
    expect(renderConversions(plain, 108, { env, items: list, total: 42, page: 1, pageSize: 6, now: NOW })).toMatchSnapshot();
  });
  it("error", () => {
    expect(renderError(plain, 108, {
      env, command: "convert", file: "master.wav", title: "profile not writable", status: 422, slug: "profile-not-writable",
      detail: "base-advanced is defined by IAMF 2.0, but OrbitCore 2.2.0 reads it and will not declare it.",
      writable: ["simple", "base", "base-enhanced", "advanced-1", "advanced-2"], exitCode: 3,
    })).toMatchSnapshot();
  });
});

describe("narrow terminals (Review Focus 4)", () => {
  it("no screen emits a line wider than 72 columns at width 72", () => {
    const screens = [
      renderPresets(plain, 72, { env, presets }),
      renderConversions(plain, 72, { env, items: list, total: 42, page: 1, pageSize: 6, now: NOW }),
      renderConvertLive(plain, 72, { env, file: "Moment 2 (Atmos).wav", out: "moment-2.iamf", source: { channels: 28, sampleRate: 48000, bitsPerSample: 24, durationSec: 402, programmeCount: 1, isAdm: true, objectCount: 16 }, stages: [{ state: "active", label: "encoding", bar: { pct: 52 }, suffix: "advanced-2 · ~0:48 left" }], id: "conv_8f3a2c91" }),
      renderConvertReady(plain, 72, { env, file: "Moment 2 (Atmos).wav", out: "moment-2.iamf", conversion: conv({}), encodeSec: 111, uploadDetail: "1.9 GB in 0:46", now: NOW }),
    ];
    for (const s of screens) expect(widest(s)).toBeLessThanOrEqual(72);
    // Eyebrows are never cut mid-word: every letter-spaced header survives intact.
    const flat = screens[0].toLowerCase().replace(/ /g, "");
    for (const h of ["profiles", "presets"]) expect(flat).toContain(h);
  });

  it("in truecolor the table columns still align and fit — widths are measured on visible text", () => {
    const tc = makeTheme({ colour: "truecolor", width: 72, interactive: true });
    const out = renderConversions(tc, 72, { env, items: list, total: 42, page: 1, pageSize: 6, now: NOW });
    const rows = out.split("\n").filter((l) => l.includes("conv_"));
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(visibleLength(r)).toBeLessThanOrEqual(72);
    // the id column starts at the same visible offset on every row
    const starts = rows.map((r) => stripAnsi(r).indexOf("conv_"));
    expect(new Set(starts).size).toBe(1);
    // and the coloured layout is the plain layout: colour never moves a column
    const plainRows = renderConversions(plain, 72, { env, items: list, total: 42, page: 1, pageSize: 6, now: NOW }).split("\n").filter((l) => l.includes("conv_"));
    expect(rows.map(stripAnsi)).toEqual(plainRows);
  });
});

describe("sessionBanner (Figma 'banner · M PICKED')", () => {
  const tc = makeTheme({ colour: "truecolor", width: 100, interactive: true });
  const c256 = makeTheme({ colour: "256", width: 100, interactive: true });
  it("plain: ● + white wordmark, session right-aligned, a ─ rule the full width", () => {
    const [l1, l2] = sessionBanner(plain, 72, "session").split("\n");
    expect(l1).toBe("● E S F E R A" + " ".repeat(72 - "● E S F E R A".length - "session".length) + "session");
    expect(l2).toBe("─".repeat(72));
  });
  it("truecolor: one ▀ per column, orange at the left end, pink at the right, white wordmark", () => {
    const [l1, l2] = sessionBanner(tc, 80, "session").split("\n");
    expect(stripAnsi(l2)).toBe("▀".repeat(80));
    expect(l2.startsWith("\x1b[38;2;249;115;22m▀")).toBe(true);
    expect(l2).toContain("\x1b[38;2;236;72;153m▀\x1b[0m");
    expect(l1).toContain("\x1b[38;2;249;115;22m●");
    expect(l1).toContain("\x1b[38;2;235;235;235mE S F E R A");
  });
  it("256-colour: a ─ rule split orange | pink at the midpoint", () => {
    const l2 = sessionBanner(c256, 10, "x").split("\n")[1];
    expect(stripAnsi(l2)).toBe("─".repeat(10));
    expect(l2).toBe("\x1b[38;5;208m─────\x1b[38;5;205m─────\x1b[0m");
  });
  it("snapshots at 108 and 72", () => {
    expect(sessionBanner(plain, 108, "session")).toMatchSnapshot();
    expect(sessionBanner(plain, 72, "session")).toMatchSnapshot();
  });
});

describe("renderDeviceCode", () => {
  const d = { env: { label: "TEST", host: "staging-api.esfera.audio" }, userCode: "WXYZ-1234", url: "https://staging.esfera.audio/cli", opened: true };
  it("at 108", () => { expect(renderDeviceCode(plain, 108, d)).toMatchSnapshot(); });
  it("at 72", () => { expect(renderDeviceCode(makeTheme({ colour: "none", width: 72, interactive: false }), 72, d)).toMatchSnapshot(); });
});

describe("renderJobLine", () => {
  it("ok at 108", () => {
    expect(renderJobLine(plain, 108, { id: "conv_5e42480012", out: "/tmp/Illuma - Demo Track - Orbit.iamf", ok: true, profile: "advanced-1", bytes: 7_000_000 })).toMatchSnapshot();
  });
  it("error at 108", () => {
    expect(renderJobLine(plain, 108, { id: "conv_5e42480012", out: "/tmp/Illuma - Demo Track - Orbit.iamf", ok: false, reason: "encoder rejected the programme" })).toMatchSnapshot();
  });
});

describe("wrap / fitAround", async () => {
  const { wrap, fitAround, stripAnsi, visibleLength } = await import("../src/ui/tty.js");
  it("wrap breaks at a space in the second half, indents continuations, and keeps every row within width", () => {
    const rows = wrap("download failed · ENOENT: no such file or directory, open '/Volumes/Blueberry/Work/out.iamf'", 40);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(visibleLength(r)).toBeLessThanOrEqual(40);
    expect(rows[0]).toBe("download failed · ENOENT: no such file");
    expect(rows[1]!.startsWith("  or directory")).toBe(true);
    // Rows re-joined (continuation indents removed, a space restored at each soft break) give the original text.
    const text = rows.map((r, i) => (i ? r.slice(2) : r)).reduce((a, r) => (a.endsWith("/") || r.startsWith("/") || /^[^\s]/.test(r) && a.length && !/\s$/.test(a) && !/[ ,]$/.test(a) && false ? a + r : a + (a ? " " : "") + r), "");
    expect(text.replace(/ (?=\/)/g, "")).toBe("download failed · ENOENT: no such file or directory, open '/Volumes/Blueberry/Work/out.iamf'");
  });
  it("wrap closes an escape at a break and reopens it on the next row", () => {
    const rows = wrap("\x1b[31m" + "x".repeat(30) + " " + "y".repeat(30) + "\x1b[0m", 40);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.endsWith("\x1b[0m")).toBe(true);
    expect(rows[1]!.startsWith("  \x1b[31m")).toBe(true);
    expect(stripAnsi(rows[1]!)).toBe("  " + "y".repeat(30));
  });
  it("wrap leaves a short line alone and hard-breaks a word with no spaces", () => {
    expect(wrap("short", 40)).toEqual(["short"]);
    expect(wrap("a".repeat(50), 20, 0)).toEqual(["a".repeat(20), "a".repeat(20), "a".repeat(10)]);
    expect(wrap("ab cd", 2, 0)).toEqual(["ab", "cd"]);   // a space exactly at the edge is dropped
  });
  it("fitAround keeps the cursor visible wherever it is in a long path", () => {
    const path = "/Volumes/Blueberry/Work/Orbit Spatial/Test Media/Illuma - Demo Track - Orbit.iamf";
    for (const cur of [0, 5, 30, 60, path.length]) {
      const t = path.slice(0, cur) + "▏" + path.slice(cur);
      const shown = fitAround(t, cur, 40);
      expect(shown.length).toBeLessThanOrEqual(40);
      expect(shown).toContain("▏");
    }
    expect(fitAround(path + "▏", path.length, 40).endsWith("Orbit.iamf▏")).toBe(true);
    expect(fitAround("short▏", 5, 40)).toBe("short▏");
  });
  it("a failed job line keeps its head within width and puts a long reason on its own line", async () => {
    const { renderJobLine, makeTheme } = await import("../src/ui/index.js");
    const theme = makeTheme({ colour: "none", width: 60, interactive: false });
    const out = renderJobLine(theme, 60, { id: "conv_7eba0f212cc9", out: "/x/Here.iamf", ok: false, downloadFailed: true, reason: "ENOENT: no such file or directory, open '/Volumes/Blueberry/Work/Orbit Spatial/Here.iamf'" });
    const [head, reason] = out.split("\n");
    expect(head).toBe("✗ 7eba0f21 · Here.iamf · download failed");
    expect(reason).toBe("  ENOENT: no such file or directory, open '/Volumes/Blueberry/Work/Orbit Spatial/Here.iamf'");
    expect(renderJobLine(theme, 60, { id: "conv_7eba0f212cc9", out: "/x/Here.iamf", ok: false, reason: "short" })).toBe("✗ 7eba0f21 · Here.iamf · error · short");
  });
});

describe("usage screen", async () => {
  const { renderUsage, makeTheme, stripAnsi } = await import("../src/ui/index.js");
  const usage = {
    plan: "pro", period: { resetsMonthly: true, resetsAt: "2026-12-01T00:00:00Z" },
    minutes: { used: 42.4, included: 300, remaining: 267.6, planRemaining: 257.6, credit: 10 },
    limits: { perFileMinutes: 120, perFileBytes: 16 * 1024 ** 3, concurrent: 2, inFlight: 1, rateLimitPerMinute: 60, retentionHours: 72 },
  } as const;
  const env = { label: "TEST", host: "staging-api.esfera.audio" };
  it("snapshot: usage at 108 and 72", () => {
    const t = makeTheme({ colour: "none", width: 108, interactive: false });
    expect(stripAnsi(renderUsage(t, 108, { env, usage, now: new Date("2026-11-08T20:00:00Z") }))).toMatchSnapshot();
    expect(stripAnsi(renderUsage(t, 72, { env, usage, now: new Date("2026-11-08T20:00:00Z") }))).toMatchSnapshot();
  });
  it("says the plain things: used of included, the reset day, the credit", () => {
    const t = makeTheme({ colour: "none", width: 108, interactive: false });
    const out = stripAnsi(renderUsage(t, 108, { env, usage, now: new Date() }));
    expect(out).toContain("42 / 300 min");
    expect(out).toContain("resets 1 Dec");
    expect(out).toContain("includes 10 min credit");
    expect(out).toContain("1 running now");
    const lifetime = { ...usage, period: { resetsMonthly: false, resetsAt: null } };
    expect(stripAnsi(renderUsage(t, 108, { env, usage: lifetime, now: new Date() }))).toContain("lifetime allowance");
  });
});


const mix = (label = "Default Mix", language: string | null = null, elements = 1) => ({ label, language, elements });
const objs = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "object" as const, label: `Obj ${i + 1}`, layout: null, channels: 1 }));
describe("describeOutput", () => {
  it("a 3OA source through oa3: one scene, short", () => {
    expect(describeOutput({ profile: "base", channels: 16, elementCount: 1, foldedObjects: 0,
      elements: [{ kind: "scene", label: "3OA", layout: "3OA", channels: 16 }], mixPresentations: [mix()] })).toBe("3OA scene · 16 ch · 1 mix (Default Mix)");
  });
  it("an ADM through youtube: bed + folded scene, objects counted as folded", () => {
    expect(describeOutput({ profile: "base", channels: 16, elementCount: 2, foldedObjects: 14,
      elements: [{ kind: "bed", label: "7.1.4", layout: "7.1.4", channels: 12 }, { kind: "scene", label: "Objects (1OA)", layout: "1OA", channels: 4 }], mixPresentations: [mix()] }))
      .toBe("7.1.4 bed + 1OA scene · 16 ch · 14 objects folded · 1 mix (Default Mix)");
  });
  it("an ADM through esfera: the element count is said when it differs from the groups", () => {
    expect(describeOutput({ profile: "advanced-2", channels: 26, elementCount: 15, foldedObjects: 0,
      elements: [{ kind: "bed", label: "7.1.4", layout: "7.1.4", channels: 12 }, ...objs(14)], mixPresentations: [mix()] }))
      .toBe("7.1.4 bed + 14 objects · 26 ch · 15 elements · 1 mix (Default Mix)");
  });
  it("one object is singular; several mixes list their labels, with a language in brackets", () => {
    expect(describeOutput({ profile: "advanced-1", channels: 13, elementCount: 2, foldedObjects: 0,
      elements: [{ kind: "bed", label: "7.1.4", layout: "7.1.4", channels: 12 }, ...objs(1)],
      mixPresentations: [mix(), mix("Commentary", "en"), mix("Dialogue only")] }))
      .toBe("7.1.4 bed + 1 object · 13 ch · 3 mixes (Default Mix, Commentary [en], Dialogue only)");
  });
});
describe("output in the ready views", () => {
  const output = { profile: "base" as const, channels: 16, elementCount: 1, foldedObjects: 0, elements: [{ kind: "scene" as const, label: "3OA", layout: "3OA", channels: 16 }], mixPresentations: [mix()] };
  it("the job line gains a second, dim line", () => {
    const lines = renderJobLine(plain, 108, { id: "conv_5e42480012", out: "/tmp/A.iamf", ok: true, profile: "base", bytes: 7_000_000, output }).split("\n");
    expect(lines).toEqual(["✓ 5e424800 · A.iamf · ready · base · 7.0 MB", "  3OA scene · 16 ch · 1 mix (Default Mix)"]);
  });
  it("the one-shot result ledger has a holds row after profile", () => {
    const out = renderConvertReady(plain, 108, { env, file: "a.wav", out: "a.iamf", conversion: conv({ output }), now: NOW });
    expect(out).toMatch(/holds\s+3OA scene · 16 ch · 1 mix \(Default Mix\)/);
    expect(out.indexOf("profile")).toBeLessThan(out.indexOf("holds"));
    expect(renderConvertReady(plain, 108, { env, file: "a.wav", out: "a.iamf", conversion: conv({}), now: NOW })).not.toContain("holds");
  });
});
