import { describe, it, expect } from "vitest";
import { ConversionFailedError } from "@esfera/sdk";
import { JobTracker, meterUpload } from "../../src/session/jobs.js";
import { makeTheme, stripAnsi } from "../../src/ui/index.js";

const theme = makeTheme({ colour: "none", width: 108, interactive: false });
const c = (o: object): any => ({ id: "conv_5e424800aa", status: "ready", stage: null, progress: 100, outputProfile: "advanced-1", profile: "advanced-1", outputSizeBytes: 7_000_000, errorMessage: null, ...o });

function setup(bellOn = true) {
  const lines: string[] = []; let bells = 0; let downloads = 0;
  const t = new JobTracker({ sdk: {} as any, sleep: async () => {}, now: () => 0, bell: () => { bells++; }, bellOn, onLine: (l) => lines.push(stripAnsi(l)), onChange: () => {}, theme, width: 108 });
  return { t, lines, bells: () => bells, downloads: () => downloads, bump: () => { downloads++; } };
}
const okJob = (bump: () => void, seen?: string[], t?: JobTracker): any => ({
  id: "conv_5e424800aa",
  wait: async (o: any) => { o.onProgress?.(c({ status: "running", stage: "encoding", progress: 37 })); seen?.push(t!.statusText()); o.onProgress?.(c({})); return c({}); },
  download: async (p: string) => { bump(); return { path: p, bytes: 7_000_000 }; },
});

describe("JobTracker", () => {
  it("follows to ready, prints the line, rings once", async () => {
    const s = setup(); const seen: string[] = [];
    s.t.follow(okJob(s.bump, seen, s.t), "x.wav", "/o/Illuma - Demo Track - Orbit.iamf", "advanced-1");
    await s.t.idle();
    expect(seen).toEqual(["1 job running"]);
    expect(s.t.statusText()).toBe("no jobs running");
    expect(s.lines).toEqual(["✓ 5e424800 · Illuma - Demo Track - Orbit.iamf · ready · advanced-1 · 7.0 MB"]);
    expect(s.bells()).toBe(1); expect(s.downloads()).toBe(1);
  });
  it("a ready job with an output summary prints it on a second line", async () => {
    const s = setup();
    const output = { profile: "advanced-1", channels: 16, elementCount: 1, foldedObjects: 0, elements: [{ kind: "scene", label: "3OA", layout: "3OA", channels: 16 }], mixPresentations: [{ label: "Default Mix", language: null, elements: 1 }] };
    const job = { id: "conv_5e424800aa", wait: async () => c({ output }), download: async (p: string) => ({ path: p, bytes: 7_000_000 }) };
    s.t.follow(job as any, "x.wav", "/o/A.iamf", "advanced-1"); await s.t.idle();
    expect(s.lines).toEqual(["✓ 5e424800 · A.iamf · ready · advanced-1 · 7.0 MB\n  3OA scene · 16 ch · 1 mix (Default Mix)"]);
  });
  it("no bell when bellOn is false", async () => {
    const s = setup(false); s.t.follow(okJob(s.bump), "x", "/o/a.iamf", "p"); await s.t.idle(); expect(s.bells()).toBe(0);
  });
  it("failed job prints the reason and does not download", async () => {
    const s = setup();
    const job: any = { id: "conv_5e424800aa", wait: async () => { throw new ConversionFailedError(c({ status: "error", errorMessage: "bad input" })); }, download: async () => { s.bump(); return { path: "", bytes: 0 }; } };
    s.t.follow(job, "x", "/o/a.iamf", "p"); await s.t.idle();
    expect(s.lines).toEqual(["✗ 5e424800 · a.iamf · error · bad input"]);
    expect(s.downloads()).toBe(0); expect(s.bells()).toBe(1); expect(s.t.running()).toEqual([]);
  });
  it("a failed download says so and points at the id — the job itself is ready on the server", async () => {
    const s = setup();
    const job: any = { id: "conv_5e424800aa", wait: async () => c({}), download: async () => { throw new Error("EISDIR: illegal operation on a directory, open '/o/Here'"); } };
    s.t.follow(job, "x", "/o/Here", "p"); await s.t.idle();
    expect(s.lines).toEqual(["✗ 5e424800 · Here · download failed · EISDIR: illegal operation on a directory, open '/o/Here'", "  ready on the server · get conv_5e424800aa"]);
    expect(s.bells()).toBe(1); expect(s.t.running()).toEqual([]);
  });
  it("once the signal aborts: wait gets the signal, nothing prints, rings or downloads, and idle(bound) returns", async () => {
    const ac = new AbortController();
    const lines: string[] = []; let changes = 0; let bells = 0; let downloads = 0; let seen: AbortSignal | undefined;
    let finish: () => void = () => {};
    const t = new JobTracker({ sdk: {} as any, sleep: async () => {}, now: () => 0, bell: () => { bells++; }, bellOn: true,
      onLine: (l) => lines.push(l), onChange: () => { changes++; }, theme, width: 108, signal: ac.signal });
    const job: any = {
      id: "conv_5e424800aa",
      wait: (o: any) => { seen = o.signal; return new Promise((r) => { finish = () => r(c({})); }); },
      download: async () => { downloads++; return { path: "", bytes: 0 }; },
    };
    t.follow(job, "x", "/o/a.iamf", "p");
    expect(seen).toBe(ac.signal);
    const before = changes;
    ac.abort();
    await t.idle(10);          // the wait ignores the signal here: the bound still returns
    finish();
    await t.idle();
    expect(lines).toEqual([]); expect(bells).toBe(0); expect(downloads).toBe(0); expect(changes).toBe(before);
  });

  it("enqueue keeps at most `limit` in flight, uploads in the background, and sums up a batch", async () => {
    const lines: string[] = []; const created: string[] = []; let inFlight = 0, peak = 0;
    let release: (() => void)[] = [];
    const t = new JobTracker({
      sdk: { conversions: { create: async (o: any) => {
        inFlight++; peak = Math.max(peak, inFlight); o.onUploadProgress?.({ sent: 1, total: 2 });
        await new Promise<void>((r) => release.push(r));
        inFlight--; created.push(o.file);
        return { id: "conv_" + o.file.replace(/\W/g, "").slice(-8).padStart(8, "0"), wait: async () => c({}), download: async (p: string) => ({ path: p, bytes: 1 }) };
      } } } as any,
      sleep: async () => {}, now: () => 0, bell: () => {}, bellOn: false, onLine: (l) => lines.push(stripAnsi(l)), onChange: () => {}, theme, width: 108,
      limit: () => 2, onCreated: (j, item) => lines.push(`created ${j.id} for ${item.file}`),
    });
    const item = (n: string) => ({ file: `/m/${n}.wav`, out: `/o/${n}.iamf`, preset: "esfera" as const, profile: "auto" as const, info: {} as any, sizeBytes: 1 });
    t.enqueue([item("a"), item("b"), item("c")]);
    expect(t.running().map((j) => [j.status, Math.round(j.progress)])).toEqual([["uploading", 50], ["uploading", 50]]);
    expect(t.running().map((j) => j.upload)).toEqual([{ sent: 1, total: 2, rate: null }, { sent: 1, total: 2, rate: null }]);
    expect(t.queued()).toBe(1);
    expect(t.statusText()).toBe("2 jobs running · 1 queued");
    expect(t.ids()).toEqual([]);                      // nothing on the server yet
    release.shift()!(); await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBe(2);
    release.forEach((r) => r()); release = [];
    await new Promise((r) => setTimeout(r, 0)); release.forEach((r) => r());
    await t.idle();
    expect(created.sort()).toEqual(["/m/a.wav", "/m/b.wav", "/m/c.wav"]);
    expect(lines.filter((l) => l.startsWith("created"))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith("✓ ") && l.includes("ready") && !l.includes(" of "))).toHaveLength(3);
    expect(lines[lines.length - 1]).toBe("✓ 3 of 3 ready");
    expect(t.statusText()).toBe("no jobs running");
  });
  it("an upload that fails is one line and frees its slot", async () => {
    const lines: string[] = [];
    const t = new JobTracker({
      sdk: { conversions: { create: async () => { throw new Error("ECONNRESET"); } } } as any,
      sleep: async () => {}, now: () => 0, bell: () => {}, bellOn: false, onLine: (l) => lines.push(stripAnsi(l)), onChange: () => {}, theme, width: 108, limit: () => 1,
    });
    t.enqueue([{ file: "/m/a.wav", out: "/o/a.iamf", preset: "esfera", profile: "auto", info: {} as any, sizeBytes: 1 }]);
    await t.idle();
    expect(lines).toEqual(["✗ a.wav · upload failed · ECONNRESET"]);
    expect(t.running()).toEqual([]);
  });
  it("the upload meter: no rate until half a second is in, then bytes per second over a 3 s window, and the meter is dropped once the job is on the server", async () => {
    const samples: { t: number; sent: number }[] = [];
    expect(meterUpload(samples, 0, 0, 1000)).toEqual({ sent: 0, total: 1000, rate: null });
    expect(meterUpload(samples, 400, 40, 1000).rate).toBeNull();
    expect(meterUpload(samples, 1000, 100, 1000).rate).toBe(100);         // 100 B over 1 s since t=0
    expect(meterUpload(samples, 4000, 700, 1000).rate).toBe(200);         // window from t=1000: 600 B over 3 s
    expect(samples[0]!.t).toBe(1000);
    let clock = 0;
    const t = new JobTracker({
      sdk: { conversions: { create: async (o: any) => {
        clock = 1000; o.onUploadProgress?.({ sent: 500, total: 1000 });
        return { id: "conv_00000000", wait: async () => c({}), download: async (p: string) => ({ path: p, bytes: 1 }) };
      } } } as any,
      sleep: async () => {}, now: () => clock, bell: () => {}, bellOn: false, onLine: () => {}, onChange: () => {}, theme, width: 108,
    });
    t.enqueue([{ file: "/m/a.wav", out: "/o/a.iamf", preset: "esfera", profile: "auto", info: {} as any, sizeBytes: 1000 }]);
    expect(t.running()[0]!.upload).toEqual({ sent: 500, total: 1000, rate: 500 });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.running()[0]?.upload).toBeUndefined();
    await t.idle();
  });
});
