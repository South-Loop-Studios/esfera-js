import { describe, expect, it } from "vitest";
import type { BwfInfo, PresetsResponse, Usage } from "@esfera/sdk";
import { flowInit, flowInspected, flowScanned, flowReduce, renderFlow, type FlowDeps, type FlowEffect, type FlowState } from "../../src/session/convertFlow.js";
import type { KeyEvent } from "../../src/session/keys.js";
import { makeTheme, stripAnsi, stripAnsi } from "../../src/ui/index.js";

const plain = makeTheme({ colour: "none", width: 108, interactive: false });
const prof = (id: string, code: number, family: string, label: string, maxElements: number, maxChannels: number, objects: boolean, writable = true) =>
  ({ id, code, family, label, maxElements, maxChannels, objects, writable });
const presets = {
  engine: { orbitcore: "1.10.6" },
  profiles: [
    prof("simple", 0, "eclipsa", "Simple", 2, 16, false),
    prof("base", 1, "eclipsa", "Base", 2, 16, false),
    prof("base-enhanced", 2, "eclipsa", "Base-Enhanced", 28, 28, true),
    prof("base-advanced", 3, "eclipsa", "Base-Advanced", 28, 28, true, false),
    prof("advanced-1", 4, "iamf-2", "Advanced 1", 28, 28, true),
    prof("advanced-2", 5, "iamf-2", "Advanced 2", 28, 28, true),
  ],
  presets: [
    { id: "youtube", label: "YouTube", declares: ["simple"], objects: "fold", inputs: ["adm"], description: "stereo-safe" },
    { id: "esfera", label: "Esfera", declares: ["base-enhanced", "advanced-1"], objects: "keep", inputs: ["adm"], description: "full fidelity" },
    { id: "oa3", label: "3OA only", declares: ["simple"], objects: "fold", inputs: ["adm", "ambisonic"], description: "one 3OA scene" },
  ],
} as unknown as PresetsResponse;
const usage = { limits: { perFileMinutes: 60, perFileBytes: 16 * 1024 ** 3, concurrent: 2, inFlight: 0, rateLimitPerMinute: 60, retentionHours: 24 } } as unknown as Usage;
const deps = (o: Partial<FlowDeps> = {}): FlowDeps => ({ presets, recent: [], usage, running: 0, home: "/Users/ben", ...o });
const info = (o: Partial<BwfInfo> = {}): BwfInfo => ({ sampleRate: 48000, channels: 28, bitsPerSample: 24, durationSec: 600, isAdm: true, programmeCount: 1, objectCount: 16, ambisonicOrder: null, ...o });
const ambi = (order: 1 | 2 | 3): BwfInfo => info({ channels: [4, 9, 16][order - 1]!, isAdm: false, programmeCount: 0, objectCount: 0, ambisonicOrder: order });

const enter: KeyEvent = { kind: "enter" };
const down: KeyEvent = { kind: "down" };
const esc: KeyEvent = { kind: "escape" };
function press(s: FlowState, d: FlowDeps, ...keys: KeyEvent[]): [FlowState, FlowEffect] {
  let eff: FlowEffect = null;
  for (const k of keys) [s, eff] = flowReduce(s, k, d);
  return [s, eff];
}
const paste = (text: string): KeyEvent => ({ kind: "paste", text });
function toPreset(d: FlowDeps, i: BwfInfo = info()): FlowState {
  let [s] = press(flowInit(d), d, paste("/m/master.wav"));
  s = flowInspected(s, { ok: true, info: i, sizeBytes: 1000 }, d);
  return s;
}

describe("convert flow", () => {
  it("walks the happy path to a start effect", () => {
    const d = deps();
    let s = toPreset(d);
    expect(s.step).toBe("preset");
    expect(s.picker!.items[s.picker!.index]!.value).toBe("esfera");
    [s] = press(s, d, enter);
    expect(s.step).toBe("profile");
    let eff: FlowEffect;
    [s] = press(s, d, enter);
    expect(s.step).toBe("output");
    expect(s.picker!.field.text).toBe("/m/master.iamf");
    [s, eff] = press(s, d, enter);
    expect(eff).toEqual({ kind: "start", choices: expect.objectContaining({ file: "/m/master.wav", preset: "esfera", profile: "auto", out: "/m/master.iamf" }) });
    expect(s.step).toBe("done");
  });

  it("expands ~ before inspecting", () => {
    const d = deps();
    const [, eff] = press(flowInit(d), d, paste("~/a.wav"));
    expect(eff).toEqual({ kind: "inspect", path: "/Users/ben/a.wav" });
  });

  it("greys base and base-advanced for an object master; enter does nothing", () => {
    const d = deps();
    let [s] = press(toPreset(d), d, enter);
    const items = s.picker!.items;
    expect(items[0]!.value).toBe("auto");
    expect(items.find((i) => i.value === "base")!.disabled).toBe("this master has 16 objects");
    expect(items.find((i) => i.value === "base-advanced")!.disabled).toBe("read-only");
    let eff: FlowEffect;
    [s, eff] = press(s, d, down, down, enter); // base
    expect(eff).toBeNull();
    expect(s.step).toBe("profile");
  });

  it("greys advanced-1 for a bed-only master", () => {
    const d = deps();
    const [s] = press(toPreset(d, info({ objectCount: 0 })), d, enter);
    expect(s.picker!.items.find((i) => i.value === "advanced-1")!.disabled).toBe("no objects in this master");
  });

  it("escape walks back and ticked lines shrink", () => {
    const d = deps();
    let [s] = press(toPreset(d), d, enter, enter);
    expect(s.step).toBe("output");
    const ticks = (x: FlowState) => renderFlow(plain, 108, x, d).filter((l) => l.includes("✓")).length;
    expect(ticks(s)).toBe(3);
    [s] = press(s, d, esc);
    expect(s.step).toBe("profile");
    expect(ticks(s)).toBe(2);
    [s] = press(s, d, esc);
    expect(s.step).toBe("preset");
    expect(ticks(s)).toBe(1);
    [s] = press(s, d, esc);
    expect(s.step).toBe("file");
    expect(ticks(s)).toBe(0);
    expect(press(s, d, esc)[1]).toEqual({ kind: "cancel" });
  });

  it("past the account's concurrency the flow still starts — the session queues the rest", () => {
    const d = deps({ running: 2 });
    let [s] = press(toPreset(d), d, enter, enter);
    let eff: FlowEffect;
    [s, eff] = press(s, d, enter);
    expect(eff?.kind).toBe("start");
    expect(s.step).toBe("done");
  });

  it("a scanned folder becomes a batch: one preset and profile for all, outputs into the folder", () => {
    const d = deps();
    const [s0] = press(flowInit(d), d, paste("/m/album"));
    const files = [
      { path: "/m/album/01.wav", info: info({ objectCount: 16, channels: 28 }), sizeBytes: 10 },
      { path: "/m/album/02.wav", info: info({ objectCount: 0, channels: 12, durationSec: 300 }), sizeBytes: 20 },
    ];
    let s = flowScanned(s0, { ok: true, dir: "/m/album", files, skipped: 1 }, d);
    expect(s.step).toBe("preset");
    expect(s.choices.batch).toEqual({ dir: "/m/album", files, skipped: 1 });
    const ticks = renderFlow(plain, 108, s, d).map(stripAnsi);
    expect(ticks[0]).toContain("folder   album · 2 masters · 15:00 · 1 skipped");
    [s] = press(s, d, enter);
    expect(s.step).toBe("profile");
    // base is fine for the bed-only master but not the object one: offered greyed, with the reason.
    const base = s.picker!.items.find((i) => i.value === "base")!;
    expect(base.disabled).toBeTruthy();
    expect(s.picker!.items[0]!.detail).toContain("varies by master");
    [s] = press(s, d, enter);
    expect(s.step).toBe("output");
    expect(s.picker!.field.text).toBe("/m/album");
    let eff: FlowEffect;
    [s, eff] = press(s, d, enter);
    expect(eff).toEqual({ kind: "start", choices: expect.objectContaining({ batch: expect.objectContaining({ dir: "/m/album" }), preset: "esfera", profile: "auto", out: "/m/album" }) });
  });

  it("a folder with no ADM masters, or a master over the limit, stays at the file step with the reason", () => {
    const d = deps();
    const [s0] = press(flowInit(d), d, paste("/m/album"));
    expect(flowScanned(s0, { ok: true, dir: "/m/album", files: [], skipped: 3 }, d).error).toBe("no ADM or ambisonic masters in album (3 files skipped)");
    expect(flowScanned(s0, { ok: false, reason: "/m/album could not be read" }, d).error).toBe("/m/album could not be read");
    const long = flowScanned(s0, { ok: true, dir: "/m/album", files: [{ path: "/m/album/x.wav", info: info({ durationSec: 61 * 60 }), sizeBytes: 1 }], skipped: 0 }, d);
    expect(long.step).toBe("file");
    expect(long.error).toBe("x.wav is over the 60-minute limit");
  });

  it("keeps the file step with the reason on refusals", () => {
    const d = deps();
    const [s0] = press(flowInit(d), d, paste("/m/x.wav"));
    const bad = flowInspected(s0, { ok: true, info: info({ isAdm: false }), sizeBytes: 1 }, d);
    expect(bad.step).toBe("file");
    expect(bad.error).toContain("carries no ADM metadata and is not ambisonic (4, 9 or 16 channels)");
    expect(flowInspected(s0, { ok: false, reason: "not a WAV/RF64/BW64 file" }, d).error).toBe("not a WAV/RF64/BW64 file");
    const long = flowInspected(s0, { ok: true, info: info({ durationSec: 61 * 60 }), sizeBytes: 1 }, d);
    expect(long.step).toBe("file");
    expect(long.error).toContain("over the 60-minute limit");
  });

  it("lists recent masters", () => {
    const d = deps({ recent: [{ path: "/m/a.wav", sizeBytes: 5e8, channels: 28, durationSec: 125, isAdm: true, objectCount: 16, lastUsed: "" }] });
    const s = flowInit(d);
    expect(s.picker!.items[0]!.label).toBe("a.wav");
    expect(press(s, d, enter)[1]).toEqual({ kind: "inspect", path: "/m/a.wav" });
  });

  it("renders the profile step", () => {
    const d = deps();
    const [s] = press(toPreset(d), d, enter);
    expect(stripAnsi(renderFlow(plain, 108, s, d).join("\n"))).toMatchSnapshot();
  });

  describe("ambisonic sources", () => {
    it("the 3OA scene presets are disabled for a 1OA/2OA file and open for 3OA and ADM", () => {
      const d = deps();
      // An ambisonic file stops at the normalization step first; Enter takes the default and reaches the preset.
      const atPreset = (i: BwfInfo = info()) => { let s = toPreset(d, i); if (s.step === "normalization") [s] = press(s, d, enter); expect(s.step).toBe("preset"); return s; };
      const oa3 = (s: FlowState) => s.picker!.items.find((i) => i.value === "oa3")!;
      expect(oa3(atPreset(ambi(1))).disabled).toBe("needs a 3OA source — this file is 1OA");
      expect(oa3(atPreset(ambi(2))).disabled).toBe("needs a 3OA source — this file is 2OA");
      expect(oa3(atPreset(ambi(3))).disabled).toBeFalsy();
      expect(oa3(atPreset()).disabled).toBeFalsy();
      expect(atPreset(ambi(1)).picker!.items.find((i) => i.value === "esfera")!.disabled).toBeFalsy();
    });
    it("an ambisonic file gets a normalization step before the preset; ADM does not", () => {
      const d = deps();
      expect(toPreset(d).step).toBe("preset");
      const s = toPreset(d, ambi(2));
      expect(s.step).toBe("normalization");
      expect(s.picker!.items.map((i) => [i.label, i.value])).toEqual([["AmbiX (SN3D)", "sn3d"], ["N3D", "n3d"], ["FuMa", "fuma"]]);
      expect(s.picker!.items[0]!.detail).toBe("the usual convention");
      expect(s.picker!.items[2]!.detail).toBe("first order only");
    });
    it("fuma is disabled above first order and open at first", () => {
      const d = deps();
      expect(toPreset(d, ambi(2)).picker!.items[2]!.disabled).toBeTruthy();
      expect(toPreset(d, ambi(1)).picker!.items[2]!.disabled).toBeFalsy();
    });
    it("the choice rides to the start effect; Esc from the preset returns to normalization", () => {
      const d = deps();
      let [s] = press(toPreset(d, ambi(1)), d, down, enter); // n3d
      expect(s.step).toBe("preset");
      expect(s.choices.normalization).toBe("n3d");
      [s] = press(s, d, esc);
      expect(s.step).toBe("normalization");
      let eff: FlowEffect;
      [s] = press(s, d, down, enter, enter, enter);
      [s, eff] = press(s, d, enter);
      expect(eff).toEqual({ kind: "start", choices: expect.objectContaining({ normalization: "n3d" }) });
    });
    it("a folder with any ambisonic file asks once; fuma is disabled when one is above first order", () => {
      const d = deps();
      const [s0] = press(flowInit(d), d, paste("/m/album"));
      const files = [{ path: "/m/album/a.wav", info: info(), sizeBytes: 1 }, { path: "/m/album/b.wav", info: ambi(3), sizeBytes: 1 }];
      const s = flowScanned(s0, { ok: true, dir: "/m/album", files, skipped: 0 }, d);
      expect(s.step).toBe("normalization");
      expect(s.picker!.items[2]!.disabled).toBeTruthy();
      const adm = flowScanned(s0, { ok: true, dir: "/m/album", files: [files[0]!], skipped: 0 }, d);
      expect(adm.step).toBe("preset");
    });
  });
});
