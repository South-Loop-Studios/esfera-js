import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConvert, type ConvertDeps } from "../src/commands/convert.js";
import { saveCredentials } from "../src/credentials.js";
import { EXIT, currentJob } from "../src/exit.js";
import { InvalidRequestError, ConversionStalledError, type Conversion, type BwfInfo, type Usage } from "@esfera/sdk";

const KEY = "esf_sk_live_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";
const usage: Usage = { plan: "pro", period: { resetsMonthly: true, resetsAt: null }, minutes: { used: 0, included: 1200, remaining: 1200, planRemaining: 1200, credit: 0 }, limits: { perFileMinutes: 90, perFileBytes: 16 * 1024 ** 3, concurrent: 2, inFlight: 0, rateLimitPerMinute: 120, retentionHours: 72 } };
const adm: BwfInfo = { sampleRate: 48000, channels: 28, bitsPerSample: 24, durationSec: 402, isAdm: true, programmeCount: 1, objectCount: 8, ambisonicOrder: null };
const ambi = (order: 1 | 2 | 3): BwfInfo => ({ ...adm, channels: [4, 9, 16][order - 1]!, isAdm: false, programmeCount: 0, objectCount: 0, ambisonicOrder: order });
const ready = (o: Partial<Conversion> = {}): Conversion => ({
  id: "conv_8f3a2c91", name: "master.wav", status: "ready", stage: null, progress: 100, sourceDurationSec: 402, outputDurationSec: 402, outputChannels: 18,
  objectCount: 8, outputLoudnessLufs: -18, outputSizeBytes: 15_800_000, errorMessage: null, createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:02:00Z",
  programmeCount: 1, preset: "youtube", programme: null, expiresAt: "2026-11-11T10:02:00Z", profile: "base", outputProfile: "base", source: { kind: "adm", order: null, normalization: null }, output: null, ...o,
});

type Calls = { create: unknown[]; download: string[]; wait: number };
function fakeDeps(over: { inspect?: BwfInfo | null; inspectBy?: (path: string) => BwfInfo | null; createError?: Error; waitError?: Error; out?: Partial<ConvertDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "esfera-convert-"));
  saveCredentials(dir, { apiKey: KEY, apiUrl: "https://api.esfera.audio" });
  const stdout: string[] = [], stderr: string[] = [];
  const calls: Calls = { create: [], download: [], wait: 0 };
  const job = {
    id: "conv_8f3a2c91", uploaded: true, conversion: null as Conversion | null,
    wait: async (opts: { until?: string; onProgress?: (c: Conversion) => void }) => {
      calls.wait++;
      if (over.waitError) throw over.waitError;
      const c = ready(opts.until === "analyzed" ? { status: "analyzed", progress: 0 } : {});
      opts.onProgress?.(c); job.conversion = c; return c;
    },
    download: async (path: string) => { calls.download.push(path); writeFileSync(path, new Uint8Array(10)); return { path, bytes: 10 }; },
  };
  const deps: ConvertDeps = {
    env: {}, configDir: dir,
    stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s),
    terminal: { colour: "none", width: 100, interactive: false },
    now: () => new Date("2026-11-08T10:03:00Z"),
    sdk: () => ({
      files: { inspect: async (path: string) => {
        const r = over.inspectBy ? over.inspectBy(path) : over.inspect;
        if (r === null) throw new InvalidRequestError({ status: 400, type: "https://esfera.audio/errors/invalid-request", title: "Invalid request", detail: "not a WAV/RF64/BW64 file" });
        return r ?? adm;
      } },
      usage: { get: async () => usage },
      conversions: { create: async (o: unknown) => { calls.create.push(o); if (over.createError) throw over.createError; return job; }, job: () => job, get: async () => ready() },
    }) as never,
    ...over.out,
  };
  return { deps, stdout, stderr, calls, dir, text: () => stdout.join("") + stderr.join(""), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("esfera convert", () => {
  let f: ReturnType<typeof fakeDeps>;
  afterEach(() => f?.cleanup());

  it("happy path: pre-flight, create with preset + profile, wait, download, ready ledger", async () => {
    f = fakeDeps();
    const src = join(f.dir, "master.wav"); writeFileSync(src, "x");
    const code = await runConvert([src, "--preset", "youtube", "--profile", "base", "-o", join(f.dir, "out.iamf")], f.deps);
    expect(code).toBe(EXIT.ok);
    expect(f.calls.create[0]).toMatchObject({ file: src, preset: "youtube", profile: "base" });
    expect(existsSync(join(f.dir, "out.iamf"))).toBe(true);
    expect(f.text()).toContain("ready");
    expect(f.text()).toContain("Base");
    expect(f.text()).toContain("conv_8f3a2c91");
  });
  it("defaults the preset to esfera so the server auto-starts, and derives the output name", async () => {
    f = fakeDeps();
    const src = join(f.dir, "Moment 2.wav"); writeFileSync(src, "x");
    expect(await runConvert([src], f.deps)).toBe(EXIT.ok);
    expect(f.calls.create[0]).toMatchObject({ preset: "esfera" });
    expect(f.calls.download[0]).toBe(join(f.dir, "Moment 2.iamf"));
  });
  it("--profile base-advanced: the server refuses at create → exit 3, the writable list is shown, nothing was uploaded (Review Focus 5)", async () => {
    f = fakeDeps({ createError: new InvalidRequestError({ status: 422, type: "https://esfera.audio/errors/profile-not-writable", title: "Profile not writable", detail: 'Profile "base-advanced" is read-only in this encoder. Writable: simple, base, base-enhanced, advanced-1, advanced-2.' }) });
    const src = join(f.dir, "m.wav"); writeFileSync(src, "x");
    expect(await runConvert([src, "--profile", "base-advanced"], f.deps)).toBe(EXIT.refused);
    expect(f.text()).toMatch(/writable/i);
    expect(f.text()).toContain("advanced-2");
    expect(f.calls.download).toHaveLength(0);
    expect(f.calls.wait).toBe(0);
  });
  it("a non-ADM WAV is refused by pre-flight (exit 2) before any API call", async () => {
    f = fakeDeps({ inspect: { ...adm, isAdm: false } });
    const src = join(f.dir, "stereo.wav"); writeFileSync(src, "x");
    expect(await runConvert([src], f.deps)).toBe(EXIT.preflight);
    expect(f.calls.create).toHaveLength(0);
    expect(f.text()).toMatch(/no ADM/);
  });
  it("an ambisonic file passes pre-flight, notes the SN3D assumption, and sends source.normalization sn3d", async () => {
    f = fakeDeps({ inspect: ambi(2) });
    const src = join(f.dir, "a.wav"); writeFileSync(src, "x");
    expect(await runConvert([src], f.deps)).toBe(EXIT.ok);
    expect(f.stderr.join("")).toContain("note: a.wav is ambisonic (2OA, 9 ch) — AmbiX (SN3D) assumed; --normalization n3d|fuma to change");
    expect(f.calls.create[0]).toMatchObject({ source: { normalization: "sn3d" } });
  });
  it("--normalization n3d is sent as given, with no assumption note", async () => {
    f = fakeDeps({ inspect: ambi(1) });
    const src = join(f.dir, "a.wav"); writeFileSync(src, "x");
    expect(await runConvert([src, "--normalization", "fuma"], f.deps)).toBe(EXIT.ok);
    expect(f.calls.create[0]).toMatchObject({ source: { normalization: "fuma" } });
    expect(f.stderr.join("")).not.toContain("assumed");
  });
  it("--normalization fuma above first order is a usage error (exit 2)", async () => {
    f = fakeDeps({ inspect: ambi(2) });
    const src = join(f.dir, "a.wav"); writeFileSync(src, "x");
    expect(await runConvert([src, "--normalization", "fuma"], f.deps)).toBe(EXIT.usage);
    expect(f.text()).toContain("fuma is first order only");
    expect(f.calls.create).toHaveLength(0);
  });
  it("--normalization on an ADM file is a usage error (exit 2)", async () => {
    f = fakeDeps();
    const src = join(f.dir, "a.wav"); writeFileSync(src, "x");
    expect(await runConvert([src, "--normalization", "n3d"], f.deps)).toBe(EXIT.usage);
    expect(f.calls.create).toHaveLength(0);
  });
  it("a 3OA scene preset on a 1OA file is refused in pre-flight, before any upload", async () => {
    f = fakeDeps({ inspect: ambi(1) });
    const src = join(f.dir, "a.wav"); writeFileSync(src, "x");
    expect(await runConvert([src, "--preset", "oa3"], f.deps)).toBe(EXIT.usage);
    expect(f.calls.create).toHaveLength(0);
    expect(f.text()).toContain("oa3 needs a 3OA source");
  });
  it("the same preset on a 3OA file, and on ADM, goes through", async () => {
    f = fakeDeps({ inspect: ambi(3) });
    const src = join(f.dir, "a.wav"); writeFileSync(src, "x");
    await runConvert([src, "--preset", "bed714_3oa"], f.deps);
    expect(f.calls.create).toHaveLength(1);
  });
  it("a master over the per-file cap from /v1/usage is refused by pre-flight", async () => {
    f = fakeDeps({ inspect: { ...adm, durationSec: 91 * 60 } });
    const src = join(f.dir, "long.wav"); writeFileSync(src, "x");
    expect(await runConvert([src], f.deps)).toBe(EXIT.preflight);
    expect(f.text()).toMatch(/90-minute/);
  });
  it("a stalled job is exit 4", async () => {
    f = fakeDeps({ waitError: new ConversionStalledError(ready({ status: "running", progress: 52 }), 300_000) });
    const src = join(f.dir, "m.wav"); writeFileSync(src, "x");
    expect(await runConvert([src], f.deps)).toBe(EXIT.failed);
    expect(f.text()).toMatch(/no progress/);
  });
  it("programme rules: several declared → default 0 with a note, or a validated --programme", async () => {
    f = fakeDeps({ inspect: { ...adm, programmeCount: 3 } });
    const src = join(f.dir, "m.wav"); writeFileSync(src, "x");
    expect(await runConvert([src], f.deps)).toBe(EXIT.ok);
    expect(f.calls.create[0]).toMatchObject({ programme: 0 });
    expect(f.stderr.join("")).toMatch(/declares 3 programmes/);
    expect(await runConvert([src, "--programme", "7"], f.deps)).toBe(EXIT.usage);
  });
  it("--json prints the result object only, identically in plain and truecolor", async () => {
    f = fakeDeps();
    const src = join(f.dir, "m.wav"); writeFileSync(src, "x");
    expect(await runConvert([src, "--json", "-o", join(f.dir, "a.iamf")], f.deps)).toBe(EXIT.ok);
    const plain = f.stdout.join("");
    expect(JSON.parse(plain)).toEqual({ id: "conv_8f3a2c91", output: join(f.dir, "a.iamf"), bytes: 10, outputProfile: "base", durationSec: 402 });
    f.stdout.length = 0;
    f.deps.terminal = { colour: "truecolor", width: 108, interactive: true };
    await runConvert([src, "--json", "-o", join(f.dir, "a.iamf")], f.deps);
    expect(f.stdout.join("")).toBe(plain);
  });
  it("in an interactive terminal an API refusal leaves no live timer behind — the process can exit with its code", async () => {
    vi.useFakeTimers();
    try {
      f = fakeDeps({ createError: new InvalidRequestError({ status: 422, type: "https://esfera.audio/errors/profile-not-writable", title: "Profile not writable", detail: "d" }) });
      f.deps.terminal = { colour: "none", width: 100, interactive: true };
      const src = join(f.dir, "m.wav"); writeFileSync(src, "x");
      const p = runConvert([src, "--profile", "base-advanced"], f.deps);
      await vi.runAllTimersAsync();
      expect(await p).toBe(EXIT.refused);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("records the job id as soon as create resolves, and shows it, so ^C can point at it", async () => {
    f = fakeDeps();
    const src = join(f.dir, "m.wav"); writeFileSync(src, "x");
    expect(await runConvert([src], f.deps)).toBe(EXIT.ok);
    expect(currentJob()).toBe("conv_8f3a2c91");
    expect(f.text()).toMatch(/conv_8f3a2c91[^\n]*keeps running/);
  });
  it("unknown preset or missing file are usage / pre-flight errors", async () => {
    f = fakeDeps();
    expect(await runConvert(["nope.wav"], f.deps)).toBe(EXIT.preflight);
    const src = join(f.dir, "m.wav"); writeFileSync(src, "x");
    expect(await runConvert([src, "--preset", "spotify"], f.deps)).toBe(EXIT.usage);
    expect(await runConvert([], f.deps)).toBe(EXIT.usage);
  });

  it("a folder: every ADM master inside, skips named, outputs beside them, a summary, exit 0", async () => {
    f = fakeDeps({ inspectBy: (p) => p.endsWith("plain.wav") ? { ...adm, isAdm: false } : p.endsWith("broken.wav") ? null : adm });
    const album = join(f.dir, "album"); mkdirSync(album);
    for (const n of ["02 second.wav", "01 first.wav", "plain.wav", "broken.wav", "notes.txt"]) writeFileSync(join(album, n), new Uint8Array(4));
    const code = await runConvert([album, "--preset", "youtube"], f.deps);
    expect(code).toBe(EXIT.ok);
    expect(f.calls.create.map((c) => (c as { file: string }).file)).toEqual([join(album, "01 first.wav"), join(album, "02 second.wav")]);
    expect(f.calls.download.sort()).toEqual([join(album, "01 first.iamf"), join(album, "02 second.iamf")]);
    const err = f.stderr.join("");
    expect(err).toContain("skip: plain.wav — no ADM metadata and not ambisonic (4, 9 or 16 channels)");
    expect(err).toContain("skip: broken.wav is not a WAV/RF64/BW64 file");
    const out = f.stdout.join("");
    expect(out).toContain("album  →  2 masters · 2 at a time");
    expect(out).toContain("✓ 2 of 2 ready");
  });
  it("a folder picks up .bw64 masters and leaves out .w64 (Sony Wave64, which the converter cannot read)", async () => {
    f = fakeDeps();
    const album = join(f.dir, "album"); mkdirSync(album);
    for (const n of ["a.bw64", "b.RF64", "c.w64"]) writeFileSync(join(album, n), new Uint8Array(4));
    expect(await runConvert([album], f.deps)).toBe(EXIT.ok);
    expect(f.calls.create.map((c) => (c as { file: string }).file)).toEqual([join(album, "a.bw64"), join(album, "b.RF64")]);
    expect(f.calls.download.sort()).toEqual([join(album, "a.iamf"), join(album, "b.iamf")]);
  });
  it("a folder with --json prints one line per master; -o must be a folder; nothing to convert is a pre-flight failure", async () => {
    f = fakeDeps();
    const album = join(f.dir, "album"); mkdirSync(album);
    writeFileSync(join(album, "a.wav"), new Uint8Array(4));
    expect(await runConvert([album, "--json"], f.deps)).toBe(EXIT.ok);
    const line = JSON.parse(f.stdout.join("").trim().split("\n").pop()!);
    expect(line).toMatchObject({ file: join(album, "a.wav"), ok: true, id: "conv_8f3a2c91", output: join(album, "a.iamf") });
    f.stdout.length = 0;
    expect(await runConvert([album, "-o", join(album, "a.iamf")], f.deps)).toBe(EXIT.usage);
    const empty = join(f.dir, "empty"); mkdirSync(empty);
    expect(await runConvert([empty], f.deps)).toBe(EXIT.preflight);
    expect(f.stderr.join("")).toContain("has no WAV/RF64/BW64 files");
  });

  it("a master over the per-file byte cap is refused before anything is uploaded; a folder skips it", async () => {
    f = fakeDeps({ out: { sdk: () => ({
      files: { inspect: async () => adm },
      usage: { get: async () => ({ ...usage, limits: { ...usage.limits, perFileBytes: 8 } }) },
      conversions: { create: async () => { throw new Error("must not upload"); } },
    }) as never } });
    const big = join(f.dir, "big.wav"); writeFileSync(big, new Uint8Array(10));
    expect(await runConvert([big], f.deps)).toBe(EXIT.preflight);
    expect(f.stderr.join("")).toContain("big.wav is 10 B — over the 8 B limit for one file");
    const album = join(f.dir, "album"); mkdirSync(album);
    writeFileSync(join(album, "huge.wav"), new Uint8Array(10));
    expect(await runConvert([album], f.deps)).toBe(EXIT.preflight);
    expect(f.stderr.join("")).toContain("skip: huge.wav is 10 B — over the 8 B limit for one file");
  });
});

