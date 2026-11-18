import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BwfInfo, Conversion, PresetsResponse, Usage } from "@esfera/sdk";
import { runSession, type SessionDeps } from "../../src/session/session.js";
import { saveCredentials } from "../../src/credentials.js";
import type { KeyEvent } from "../../src/session/keys.js";
import { EXIT } from "../../src/exit.js";
import { makeTheme, stripAnsi } from "../../src/ui/index.js";

const KEY = "esf_sk_test_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";
const MASTER = "/masters/Moment 2.wav";
const prof = (id: string, code: number, family: string, label: string, maxElements: number, maxChannels: number, objects: boolean, writable = true) =>
  ({ id, code, family, label, maxElements, maxChannels, objects, writable });
const presets = {
  engine: { orbitcore: "2.2.0" },
  profiles: [prof("simple", 0, "eclipsa", "Simple", 2, 16, false), prof("base-enhanced", 2, "eclipsa", "Base-Enhanced", 28, 28, true), prof("advanced-1", 4, "iamf-2", "Advanced 1", 28, 28, true)],
  presets: [{ id: "esfera", label: "Esfera", declares: ["base-enhanced", "advanced-1"], objects: "keep", inputs: ["adm"], description: "full fidelity" }],
} as unknown as PresetsResponse;
const usage = { plan: "pro", limits: { perFileMinutes: 90, perFileBytes: 16 * 1024 ** 3, concurrent: 2, inFlight: 0, rateLimitPerMinute: 60, retentionHours: 72 } } as unknown as Usage;
const adm: BwfInfo = { sampleRate: 48000, channels: 28, bitsPerSample: 24, durationSec: 402, isAdm: true, programmeCount: 1, objectCount: 8 };
const conv = (o: Partial<Conversion> = {}): Conversion => ({
  id: "conv_8f3a2c91", name: "Moment 2.wav", status: "ready", stage: null, progress: 100, sourceDurationSec: 402, outputDurationSec: 402, outputChannels: 18,
  objectCount: 8, outputLoudnessLufs: -18, outputSizeBytes: 15_800_000, errorMessage: null, createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:02:00Z",
  programmeCount: 1, preset: "esfera", programme: null, expiresAt: "2026-11-11T10:02:00Z", profile: "auto", outputProfile: "advanced-1", source: { kind: "adm", order: null, normalization: null }, output: null, ...o,
});

const tick = () => new Promise<void>((r) => setImmediate(r));
type Step = KeyEvent | (() => void);
const type = (s: string): KeyEvent[] => [...s].map((ch) => ({ kind: "char", ch }));
const enter: KeyEvent = { kind: "enter" };
const cmd = (s: string): KeyEvent[] => [...type(s), enter];
const ctrlC: KeyEvent = { kind: "ctrl", ch: "c" };

function setup(opts: { signedIn?: boolean; login?: SessionDeps["login"]; hangWait?: boolean; hangList?: boolean; hangUpload?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "esfera-session-"));
  const out: string[] = [];
  const failWrites = { on: false };
  const calls = { tty: [] as string[], create: [] as unknown[], reveal: [] as string[], close: 0, bells: 0, login: 0, downloads: [] as string[], get: [] as string[], list: [] as unknown[] };
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const makeJob = () => {
    const id = n++ === 0 ? "conv_8f3a2c91" : "conv_2b77e0d4";
    return {
      id,
      wait: async (o: { onProgress?: (c: Conversion) => void }) => {
        o.onProgress?.(conv({ id, status: "running", stage: "encoding", progress: 37 }));
        if (opts.hangWait) await new Promise(() => {}); else await gate;
        return conv({ id });
      },
      download: async (p: string) => { calls.downloads.push(p); return { path: p, bytes: 7_000_000 }; },
    };
  };
  let clock = 1_000;
  const steps: Step[] = [];
  const deps: SessionDeps = {
    terminal: { colour: "none", width: 108, interactive: true },
    theme: makeTheme({ colour: "none", width: 108, interactive: true }),
    tty: {
      write: (s) => { if (failWrites.on) throw new Error("write EPIPE"); out.push(s); }, columns: 108, close: () => { calls.close++; },
      suspend: () => { calls.tty.push("suspend"); }, resume: () => { calls.tty.push("resume"); },
      keys: { async *[Symbol.asyncIterator]() { for (const s of steps) { if (typeof s === "function") s(); else yield s; await tick(); } } },
    },
    env: opts.signedIn === false ? {} : { ESFERA_API_KEY: KEY, ESFERA_API_URL: "https://staging-api.esfera.audio", HOME: "/home/ben" },
    configDir: dir, argv: [],
    sdk: () => ({
      presets: { get: async () => presets },
      usage: { get: async () => usage },
      files: { inspect: async () => adm },
      conversions: {
        create: async (o: { onUploadProgress?: (p: { sent: number; total: number }) => void; signal?: AbortSignal }) => {
          calls.create.push(o); o.onUploadProgress?.({ sent: 5, total: 10 });
          if (opts.hangUpload) {
            await new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
          }
          return makeJob();
        },
        list: async (o: unknown) => { calls.list.push(o); if (opts.hangList) await new Promise(() => {}); return { items: [conv()], total: 1, page: 1, pageSize: 10 }; },
        get: async (id: string) => { calls.get.push(id); return conv({ id }); },
      },
    }) as never,
    fs: { readdir: () => [], isDir: () => false, stat: () => ({ size: 1000 }) },
    open: async () => true, reveal: async (p) => { calls.reveal.push(p); return true; },
    login: opts.login ?? (async () => { calls.login++; calls.tty.push("login"); return EXIT.ok; }),
    logout: async () => { calls.tty.push("logout"); return EXIT.ok; },
    bell: () => { calls.bells++; }, sleep: async () => {}, now: () => (clock += 100), hostname: () => "mac",
  };
  const text = () => stripAnsi(out.join(""));
  return { deps, steps, out, calls, dir, release, text, failWrites, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const convertSteps = (): Step[] => [...cmd("convert"), { kind: "down" }, { kind: "paste", text: MASTER }, enter, enter, enter];

describe("runSession", () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => s?.cleanup());

  it("an output path that is a directory gets the default file name inside it", async () => {
    s = setup();
    s.deps.fs.isDir = (p: string) => p === "/out";
    // file → preset → profile → output: replace the pre-filled path with a folder.
    s.steps.push(...cmd("convert"), { kind: "down" }, { kind: "paste", text: MASTER }, enter, enter,
      { kind: "ctrl", ch: "u" }, ...[..."/out"].map((ch) => ({ kind: "char", ch }) as const), enter,
      () => s.release(), ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    expect(s.calls.downloads[0]).toBe("/out/Moment 2.iamf");
  });
  it("signed in: convert end-to-end creates the job, prints the ✓ line before quit, rings once", async () => {
    s = setup();
    s.steps.push(...convertSteps(), () => s.release(), ...cmd("quit"));
    const code = await runSession(s.deps);
    expect(code).toBe(EXIT.ok);
    expect(s.calls.create[0]).toMatchObject({ file: MASTER, preset: "esfera", profile: "auto" });
    const t = s.text();
    expect(t).toContain("E S F E R A");
    expect(t).toContain("convert · presets · usage · list · get <id> · help · quit");
    expect(t).toContain("1 job running");
    const line = t.indexOf("✓ 8f3a2c91");
    expect(line).toBeGreaterThan(-1);
    expect(t).toContain("/masters/Moment 2.iamf");
    expect(s.calls.bells).toBe(1);
    expect(s.calls.close).toBe(1);
    expect(t).not.toContain("jobs keep running");
  });

  it("a job finishing while the picker is open prints above it and the picker stays", async () => {
    s = setup();
    const mark = { at: 0 };
    s.steps.push(...convertSteps(), ...cmd("convert"), { kind: "down" }, { kind: "paste", text: MASTER },
      () => { mark.at = s.out.length; s.release(); }, { kind: "escape" }, { kind: "escape" }, { kind: "escape" }, ...cmd("quit"));
    await runSession(s.deps);
    const after = stripAnsi(s.out.slice(mark.at).join(""));
    const done = after.indexOf("✓ 8f3a2c91");
    const picker = after.indexOf("P R E S E T", done);
    expect(done).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(done);
  });

  it("^C twice quits, restores the terminal and names the running job", async () => {
    s = setup({ hangWait: true });
    s.steps.push(...convertSteps(), ctrlC, ctrlC);
    expect(await runSession(s.deps)).toBe(EXIT.interrupted);
    expect(s.calls.close).toBe(1);
    expect(s.text()).toContain("jobs keep running · esfera conversions get conv_8f3a2c91");
  });

  it("^C once clears the prompt and hints; another key resets the window", async () => {
    s = setup();
    s.steps.push(...type("abc"), ctrlC, ...type("x"), ctrlC, ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    expect(s.text()).toContain("^C again to quit");
  });

  it("not signed in: login runs first; a refusal returns its code without drawing the home screen", async () => {
    s = setup({ signedIn: false, login: async () => { s.calls.login++; return EXIT.refused; } });
    expect(await runSession(s.deps)).toBe(EXIT.refused);
    expect(s.calls.login).toBe(1);
    expect(s.text()).not.toContain("E S F E R A");
    expect(s.calls.close).toBe(1);
  });

  it("presets, list, get, help and unknown commands print their headings", async () => {
    s = setup();
    s.steps.push(...cmd("presets"), ...cmd("list ready"), ...cmd("get conv_8f3a2c91"), ...cmd("help"), ...cmd("frobnicate"), ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    const t = s.text();
    expect(t).toContain("P R E S E T S");
    expect(t).toContain("simple");
    expect(t).toContain("C O N V E R S I O N S");
    expect(s.calls.list[0]).toEqual({ status: "ready", page: 1, pageSize: 10 });
    expect(s.calls.get).toEqual(["conv_8f3a2c91"]);
    expect(t).toContain("C O M M A N D S");
    expect(t).toContain("unknown command 'frobnicate'");
  });

  it("open reveals the last finished output", async () => {
    s = setup();
    s.steps.push(...cmd("open"), ...convertSteps(), () => s.release(), { kind: "ctrl", ch: "l" }, ...cmd("open"), ...cmd("quit"));
    await runSession(s.deps);
    expect(s.text()).toContain("no output to reveal yet");
    expect(s.calls.reveal).toEqual(["/masters/Moment 2.iamf"]);
  });

  it("quit with a job running: returns, then nothing more is written, downloaded or rung when the job ends", async () => {
    s = setup();
    s.steps.push(...convertSteps(), ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    expect(s.text()).toContain("jobs keep running · esfera conversions get conv_8f3a2c91");
    const written = s.out.length;
    s.release();
    for (let i = 0; i < 5; i++) await tick();
    expect(s.out.length).toBe(written);
    expect(s.calls.downloads).toEqual([]);
    expect(s.calls.bells).toBe(0);
    expect(s.calls.close).toBe(1);
  });

  it("^C cancels a slow command at once; keys typed meanwhile are dropped and nothing replays after", async () => {
    s = setup({ hangList: true });
    s.steps.push(...cmd("list"), ...type("xyz"), enter, ctrlC, ...type("x"), { kind: "backspace" }, ...cmd("help"), ctrlC, ...type("a"), ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    const t = s.text();
    expect(t).toContain("working… ^C cancels");
    expect(t).toContain("list cancelled");
    expect(t).not.toContain("unknown command 'xyz'");
    expect(t).toContain("C O M M A N D S");
  });

  it("^C ^C during a slow command quits", async () => {
    s = setup({ hangList: true });
    s.steps.push(...cmd("list"), ctrlC, ctrlC);
    expect(await runSession(s.deps)).toBe(EXIT.interrupted);
    expect(s.calls.close).toBe(1);
  });

  it("the upload runs in the background as a rail row with its percentage; ^C twice quits and the signal cancels it", async () => {
    s = setup({ hangUpload: true });
    s.steps.push(...convertSteps(), ctrlC, ctrlC);
    expect(await runSession(s.deps)).toBe(EXIT.interrupted);
    const t = s.text();
    expect(t).toMatch(/◆ uploading\s+█+░+\s+50%/);
    expect((s.calls.create[0] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect((s.calls.create[0] as { signal?: AbortSignal }).signal!.aborted).toBe(true);
    expect(t).not.toContain("jobs keep running");   // nothing exists on the server yet
  });

  it("login and logout inside the session run with raw mode suspended, then resume", async () => {
    s = setup();
    s.steps.push(...cmd("login"), ...cmd("logout"), ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    expect(s.calls.tty).toEqual(["suspend", "login", "resume", "suspend", "logout", "resume"]);
  });

  it("login inside a session signs in to the session's own environment unless ESFERA_API_URL says otherwise", async () => {
    let seen: string | undefined;
    s = setup({ login: async (d) => { seen = d.env.ESFERA_API_URL; return EXIT.ok; } });
    s.steps.push(...cmd("login"), ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    expect(seen).toBe("https://staging-api.esfera.audio");
  });

  it("not signed in: sign-in gets the real masked prompt (the 404 paste fallback), then the session opens", async () => {
    let prompt: unknown;
    s = setup({ signedIn: false, login: async (d) => {
      prompt = d.prompt;
      saveCredentials(s.dir, { apiKey: KEY, apiUrl: "https://staging-api.esfera.audio", via: "paste" });
      return EXIT.ok;
    } });
    s.steps.push(...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.ok);
    expect((prompt as { name: string }).name).toBe("maskedPrompt");
    expect(s.text()).toContain("E S F E R A");
    expect(s.calls.tty).toEqual([]);
  });

  it("an unexpected throw restores the terminal once and resolves with failed", async () => {
    s = setup();
    s.steps.push(() => { s.failWrites.on = true; }, ...cmd("help"), ...cmd("quit"));
    expect(await runSession(s.deps)).toBe(EXIT.failed);
    expect(s.calls.close).toBe(1);
  });
});
