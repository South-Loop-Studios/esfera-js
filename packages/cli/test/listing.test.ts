import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPresets } from "../src/commands/presets.js";
import { runConversions } from "../src/commands/conversions.js";
import { saveCredentials } from "../src/credentials.js";
import { EXIT } from "../src/exit.js";
import type { Conversion, PresetsResponse } from "@esfera/sdk";
import { NotFoundError } from "@esfera/sdk";

const KEY = "esf_sk_live_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";
const presets: PresetsResponse = {
  engine: { orbitcore: "2.2.0" },
  profiles: [
    { id: "simple", code: 0, family: "eclipsa", label: "Simple", maxElements: 1, maxChannels: 16, objects: false, writable: true },
    { id: "base-advanced", code: 3, family: "iamf-2", label: "Base-Advanced", maxElements: 18, maxChannels: 18, objects: true, writable: false },
  ],
  presets: [{ id: "esfera", label: "Esfera", declares: ["base-enhanced", "advanced-1", "advanced-2"], objects: "keep", inputs: ["adm"], description: "" }],
};
const conv = (o: Partial<Conversion> = {}): Conversion => ({
  id: "conv_8f3a2c91", name: "Moment 2 (Atmos).wav", status: "ready", stage: null, progress: 100, sourceDurationSec: 402, outputDurationSec: 402, outputChannels: 28,
  objectCount: 16, outputLoudnessLufs: -18, outputSizeBytes: 15_800_000, errorMessage: null, createdAt: "2026-11-08T09:58:00Z", updatedAt: "2026-11-08T10:00:00Z",
  programmeCount: 1, preset: "esfera", programme: null, expiresAt: "2026-11-11T10:00:00Z", profile: "auto", outputProfile: "advanced-2", source: { kind: "adm", order: null, normalization: null }, output: null, ...o,
});

function deps(listArgs: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "esfera-list-"));
  saveCredentials(dir, { apiKey: KEY, apiUrl: "https://staging-api.esfera.audio" });
  const out: string[] = [], err: string[] = [];
  const d = {
    env: {}, configDir: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s),
    terminal: { colour: "none" as const, width: 108, interactive: false }, now: () => new Date("2026-11-08T10:02:00Z"),
    sdk: () => ({
      presets: { get: async () => presets },
      conversions: {
        list: async (o: unknown) => { listArgs.push(o); return { items: [conv(), conv({ id: "conv_1b77e0d4", status: "running", stage: "encoding", progress: 34 })], total: 42, page: 2, pageSize: 2 }; },
        get: async (id: string) => { if (id === "nope") throw new NotFoundError({ status: 404, type: "https://esfera.audio/errors/not-found", title: "Not found", detail: "No such conversion" }); if (id === "conv_with_output") return conv({ output: { profile: "advanced-2", channels: 26, elementCount: 15, foldedObjects: 0, elements: [{ kind: "bed", label: "7.1.4", layout: "7.1.4", channels: 12 }, ...Array.from({ length: 14 }, (_, i) => ({ kind: "object" as const, label: `O${i}`, layout: null, channels: 1 }))], mixPresentations: [{ label: "Default Mix", language: null, elements: 15 }] } }); return conv(); },
      },
    }) as never,
  };
  return { d, out, err, text: () => out.join("") + err.join(""), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("esfera presets", () => {
  let f: ReturnType<typeof deps>;
  afterEach(() => f?.cleanup());
  it("renders the profiles and presets tables with the engine version and the TEST environment", async () => {
    f = deps();
    expect(await runPresets([], f.d)).toBe(EXIT.ok);
    const t = f.text();
    expect(t).toContain("OrbitCore 2.2.0");
    expect(t).toContain("eclipsa");
    expect(t).toContain("read-only");
    expect(t).toContain("base-enhanced / advanced-1 / advanced-2");
  });
  it("--json prints the raw response", async () => {
    f = deps();
    expect(await runPresets(["--json"], f.d)).toBe(EXIT.ok);
    expect(JSON.parse(f.out.join(""))).toEqual(presets);
  });
});

describe("esfera conversions", () => {
  let f: ReturnType<typeof deps>;
  afterEach(() => f?.cleanup());
  it("list passes status/page/page-size through and renders rows + footer", async () => {
    const calls: unknown[] = [];
    f = deps(calls);
    expect(await runConversions(["list", "--status", "ready", "--page", "2", "--page-size", "2"], f.d)).toBe(EXIT.ok);
    expect(calls[0]).toEqual({ status: "ready", page: 2, pageSize: 2 });
    const t = f.text();
    expect(t).toContain("conv_8f3a2c91");
    expect(t).toContain("encoding");
    expect(t).toContain("3–4 of 42");
  });
  it("list --json prints the items array only", async () => {
    f = deps();
    expect(await runConversions(["list", "--json"], f.d)).toBe(EXIT.ok);
    const arr = JSON.parse(f.out.join(""));
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[0].id).toBe("conv_8f3a2c91");
  });
  it("get shows what the file holds when the conversion has an output", async () => {
    f = deps();
    expect(await runConversions(["get", "conv_with_output"], f.d)).toBe(EXIT.ok);
    expect(f.text()).toMatch(/holds\s+7\.1\.4 bed \+ 14 objects · 26 ch · 15 elements · 1 mix \(Default Mix\)/);
    f = deps();
    await runConversions(["get", "conv_8f3a2c91"], f.d);
    expect(f.text()).not.toContain("holds");
  });
  it("get renders one conversion as a ledger; a missing id is exit 3", async () => {
    f = deps();
    expect(await runConversions(["get", "conv_8f3a2c91"], f.d)).toBe(EXIT.ok);
    expect(f.text()).toContain("Advanced-2");
    expect(f.text()).toContain("-18.0 LUFS");
    expect(await runConversions(["get", "nope"], f.d)).toBe(EXIT.refused);
    expect(f.text()).toContain("No such conversion");
  });
  it("bad arguments are usage errors", async () => {
    f = deps();
    expect(await runConversions(["list", "--page"], f.d)).toBe(EXIT.usage);
    expect(await runConversions(["get"], f.d)).toBe(EXIT.usage);
    expect(await runConversions(["frobnicate"], f.d)).toBe(EXIT.usage);
  });
});
