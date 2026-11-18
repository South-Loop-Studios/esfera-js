import { describe, it, expect } from "vitest";
import { HttpClient } from "../src/http.js";
import { ConversionsResource } from "../src/resources/conversions.js";
import { ConversionFailedError, ConversionStalledError, UploadError, InvalidRequestError } from "../src/errors.js";
import type { Conversion } from "../src/types.js";

// ── a scripted fetch that distinguishes API calls from the presigned PUT ─────
type Step = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
function harness(apiSteps: Step[], putSteps: Step[] = [{ status: 200 }]) {
  const api: { url: string; init: RequestInit }[] = [];
  const puts: { url: string; init: RequestInit; bytes: number }[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    if (u.startsWith("https://r2/")) {
      let bytes = 0;
      const b = init.body as ReadableStream<Uint8Array> | Blob | Uint8Array | undefined;
      if (b instanceof ReadableStream) { const r = b.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; bytes += value.byteLength; } }
      else if (b instanceof Blob) bytes = b.size;
      else if (b) bytes = (b as Uint8Array).byteLength;
      puts.push({ url: u, init, bytes });
      const step = putSteps.shift() ?? { status: 200 };
      if (step instanceof Error) throw step;
      return new Response(null, { status: step.status });
    }
    api.push({ url: u, init });
    const step = apiSteps.shift();
    if (!step) throw new Error(`unexpected API call ${init.method ?? "GET"} ${u}`);
    if (step instanceof Error) throw step;
    const headers = new Headers({ "content-type": "application/json", ...(step.headers ?? {}) });
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), { status: step.status, headers });
  }) as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch, sleep });
  return { conversions: new ConversionsResource(http, { sleep }), api, puts, sleeps };
}

const conv = (over: Partial<Conversion> = {}): Conversion => ({
  id: "c1", name: "a.wav", status: "ready", stage: null, progress: 100, sourceDurationSec: 60, outputDurationSec: 60,
  outputChannels: 18, objectCount: 8, outputLoudnessLufs: -18, outputSizeBytes: 100, errorMessage: null,
  createdAt: "t", updatedAt: "t", programmeCount: 1, preset: "esfera", programme: null, expiresAt: null,
  profile: "auto", outputProfile: "advanced-1", source: { kind: "adm", order: null, normalization: null }, output: null, ...over,
});
const blob = (n: number) => new Blob([new Uint8Array(n)], { type: "audio/wav" });
const created = { status: 201, body: { id: "c1", uploadUrl: "https://r2/put", autoStart: true } };

describe("conversions.create", () => {
  it("POSTs with an Idempotency-Key, then PUTs the bytes with Content-Length and duplex half; never calls start", async () => {
    const h = harness([created, { status: 202, body: { id: "c1", status: "analyzing" } }]);
    const job = await h.conversions.create({ file: blob(1234), preset: "esfera", profile: "advanced-2", durationSec: 60, filename: "a.wav" });
    expect(job.id).toBe("c1");
    expect(job.uploaded).toBe(true);
    const post = h.api[0];
    expect(post.init.method).toBe("POST");
    expect(new Headers(post.init.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(post.init.body as string)).toEqual({ filename: "a.wav", durationSec: 60, sizeBytes: 1234, preset: "esfera", profile: "advanced-2" });
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].bytes).toBe(1234);
    const ph = new Headers(h.puts[0].init.headers);
    expect(ph.get("content-length")).toBe("1234");
    expect(ph.get("content-type")).toBe("audio/wav");
    expect((h.puts[0].init as { duplex?: string }).duplex).toBe("half");
    expect(h.api.filter((c) => c.url.endsWith("/start"))).toHaveLength(0);
  });

  it("uses the caller's idempotency key and resolves a duplicate reply without uploading", async () => {
    const h = harness([{ status: 200, body: { id: "c1", duplicate: true } }, { status: 200, body: conv() }]);
    const job = await h.conversions.create({ file: blob(10), durationSec: 5, filename: "a.wav", idempotencyKey: "my-key" });
    expect(new Headers(h.api[0].init.headers).get("idempotency-key")).toBe("my-key");
    expect(job.uploaded).toBe(false);
    expect(h.puts).toHaveLength(0);
    await job.refresh();
    expect(job.conversion.status).toBe("ready");
  });

  it("reports upload progress from the byte stream", async () => {
    const h = harness([created, { status: 202, body: {} }]);
    const seen: number[] = [];
    await h.conversions.create({ file: blob(2000), durationSec: 5, filename: "a.wav", onUploadProgress: (p) => seen.push(p.sent) });
    expect(seen.at(-1)).toBe(2000);
  });

  it("a PUT network error on a stream source is NOT retried (Review Focus 1)", async () => {
    const h = harness([created], [new TypeError("fetch failed")]);
    const stream = new Blob([new Uint8Array(50)]).stream();
    await expect(h.conversions.create({ file: { stream, size: 50, name: "a.wav" }, durationSec: 5 })).rejects.toBeInstanceOf(UploadError);
    expect(h.puts).toHaveLength(1);
  });

  it("a PUT network error on a Blob source is retried once", async () => {
    const h = harness([created, { status: 202, body: {} }], [new TypeError("fetch failed"), { status: 200 }]);
    const job = await h.conversions.create({ file: blob(50), durationSec: 5, filename: "a.wav" });
    expect(job.uploaded).toBe(true);
    expect(h.puts).toHaveLength(2);
  });

  it("a non-2xx PUT is an UploadError", async () => {
    const h = harness([created], [{ status: 403 }]);
    const err = await h.conversions.create({ file: blob(50), durationSec: 5, filename: "a.wav" }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.status).toBe(403);
  });

  it("a stream source without durationSec is refused client-side", async () => {
    const h = harness([]);
    const stream = new Blob([new Uint8Array(5)]).stream();
    await expect(h.conversions.create({ file: { stream, size: 5, name: "a.wav" } })).rejects.toBeInstanceOf(InvalidRequestError);
    expect(h.api).toHaveLength(0);
  });
});

describe("conversions.create — analysis is the client's call", () => {
  // The server has no "upload landed" trigger: nothing moves a row off `uploading`
  // until POST /:id/analyze. create() must call it after the PUT (and still never start()).
  it("POSTs /analyze after a successful PUT, before resolving", async () => {
    const h = harness([created, { status: 202, body: { id: "c1", status: "analyzing" } }]);
    const job = await h.conversions.create({ file: blob(10), durationSec: 5, filename: "a.wav", preset: "esfera" });
    expect(job.uploaded).toBe(true);
    expect(h.api.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual(["POST /v1/conversions", "POST /v1/conversions/c1/analyze"]);
    expect(h.api.filter((c) => c.url.endsWith("/start"))).toHaveLength(0);
  });
  it("treats 409 already-started from /analyze as success (the server got there first)", async () => {
    const h = harness([created, { status: 409, body: { type: "https://esfera.audio/errors/already-started", title: "Already started", status: 409, detail: "analyzing" } }]);
    const job = await h.conversions.create({ file: blob(10), durationSec: 5, filename: "a.wav" });
    expect(job.uploaded).toBe(true);
  });
  it("does not analyze an idempotent duplicate (its first create already did)", async () => {
    const h = harness([{ status: 200, body: { id: "c1", duplicate: true } }]);
    await h.conversions.create({ file: blob(10), durationSec: 5, filename: "a.wav" });
    expect(h.api).toHaveLength(1);
  });
  it("a 422 at create means nothing was uploaded (Review Focus 5, at the SDK)", async () => {
    const h = harness([{ status: 422, body: { type: "https://esfera.audio/errors/profile-not-writable", title: "Profile not writable", status: 422, detail: "d" } }]);
    await expect(h.conversions.create({ file: blob(10), durationSec: 5, filename: "a.wav", profile: "base-advanced" as never })).rejects.toBeInstanceOf(InvalidRequestError);
    expect(h.puts).toHaveLength(0);
  });
});

describe("conversions.wait", () => {
  it("polls until ready and reports progress", async () => {
    const h = harness([
      { status: 200, body: conv({ status: "running", progress: 10 }) },
      { status: 200, body: conv({ status: "running", progress: 60 }) },
      { status: 200, body: conv({ status: "ready", progress: 100 }) },
    ]);
    const seen: number[] = [];
    const done = await h.conversions.wait("c1", { pollIntervalMs: 3000, onProgress: (c) => seen.push(c.progress) });
    expect(done.status).toBe("ready");
    expect(seen).toEqual([10, 60, 100]);
    expect(h.sleeps).toEqual([3000, 3000]);
  });

  it("stops at analyzed for the two-step flow", async () => {
    const h = harness([{ status: 200, body: conv({ status: "analyzing", progress: 0 }) }, { status: 200, body: conv({ status: "analyzed", progress: 0 }) }]);
    const c = await h.conversions.wait("c1", { until: "analyzed", pollIntervalMs: 1 });
    expect(c.status).toBe("analyzed");
  });

  it("throws ConversionStalledError when (status, progress) is unchanged at running for stallMs", async () => {
    const steps: Step[] = Array.from({ length: 6 }, () => ({ status: 200, body: conv({ status: "running", progress: 52 }) }));
    const h = harness(steps);
    let t = 0; // sleeps are faked, so the clock must tick by hand
    await expect(h.conversions.wait("c1", { pollIntervalMs: 1000, stallMs: 4000, now: () => (t += 1000) })).rejects.toBeInstanceOf(ConversionStalledError);
  });

  it("a moving updatedAt (the converter's heartbeat) is life: no stall at progress 0", async () => {
    // The encode's loudness and pre-render passes write no progress for minutes; the container
    // touches updated_at every 60 s instead. Ten polls at progress 0, each with a fresh updatedAt.
    const steps: Step[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ status: 200, body: conv({ status: "running", progress: 0, updatedAt: `t${i}` }) })),
      { status: 200, body: conv({ status: "ready", progress: 100 }) },
    ];
    const h = harness(steps);
    let t = 0;
    const c = await h.conversions.wait("c1", { pollIntervalMs: 1000, stallMs: 4000, now: () => (t += 1000) });
    expect(c.status).toBe("ready");
  });

  it("a frozen updatedAt at progress 0 still stalls", async () => {
    const steps: Step[] = Array.from({ length: 6 }, () => ({ status: 200, body: conv({ status: "running", progress: 0, updatedAt: "t" }) }));
    const h = harness(steps);
    let t = 0;
    await expect(h.conversions.wait("c1", { pollIntervalMs: 1000, stallMs: 4000, now: () => (t += 1000) })).rejects.toBeInstanceOf(ConversionStalledError);
  });

  it("queued is exempt from the stall guard (Review Focus 2)", async () => {
    const steps: Step[] = [
      ...Array.from({ length: 10 }, () => ({ status: 200, body: conv({ status: "queued", progress: 0 }) })),
      { status: 200, body: conv({ status: "running", progress: 5 }) },
      { status: 200, body: conv({ status: "ready", progress: 100 }) },
    ];
    const h = harness(steps);
    let t = 0;
    const c = await h.conversions.wait("c1", { pollIntervalMs: 1000, stallMs: 4000, now: () => (t += 1000) });
    expect(c.status).toBe("ready");
  });

  it("waiting (the owner's own queue) is exempt from the stall guard too", async () => {
    const steps: Step[] = [
      ...Array.from({ length: 10 }, () => ({ status: 200, body: conv({ status: "waiting", progress: 0 }) })),
      { status: 200, body: conv({ status: "ready", progress: 100 }) },
    ];
    const h = harness(steps);
    let t = 0;
    const c = await h.conversions.wait("c1", { pollIntervalMs: 1000, stallMs: 4000, now: () => (t += 1000) });
    expect(c.status).toBe("ready");
  });

  it("a terminal error throws ConversionFailedError carrying the conversion", async () => {
    const h = harness([{ status: 200, body: conv({ status: "error", errorMessage: "IAMF profile mismatch" }) }]);
    const err = await h.conversions.wait("c1", { pollIntervalMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionFailedError);
    expect(err.conversion.errorMessage).toBe("IAMF profile mismatch");
  });

  it("honours timeoutMs", async () => {
    const steps: Step[] = Array.from({ length: 50 }, () => ({ status: 200, body: conv({ status: "running", progress: 1 }) }));
    const h = harness(steps);
    let now = 0;
    await expect(h.conversions.wait("c1", { pollIntervalMs: 1000, stallMs: 60_000, timeoutMs: 2500, now: () => (now += 1000) })).rejects.toThrow(/timed out/);
  });
});

describe("conversions list / iterate / actions / download", () => {
  it("iterate walks every page with starting_after (pageSize becomes limit)", async () => {
    const h = harness([
      { status: 200, body: { object: "list", data: [conv({ id: "a" }), conv({ id: "b" })], has_more: true, next_cursor: "b", items: [] } },
      { status: 200, body: { object: "list", data: [conv({ id: "c" })], has_more: false, next_cursor: null, items: [] } },
    ]);
    const ids: string[] = [];
    for await (const c of h.conversions.iterate({ status: "ready", pageSize: 2 })) ids.push(c.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(h.api[0].url).toContain("status=ready");
    expect(h.api[0].url).toContain("limit=2");
    expect(h.api[1].url).toContain("starting_after=b");
  });

  it("start sends preset, programme and profile; analyze and delete hit their routes", async () => {
    const h = harness([{ status: 202, body: { id: "c1", status: "queued" } }, { status: 202, body: { id: "c1", status: "analyzing" } }, { status: 200, body: { ok: true } }]);
    await h.conversions.start("c1", { preset: "youtube", programme: 0, profile: "base" });
    expect(JSON.parse(h.api[0].init.body as string)).toEqual({ preset: "youtube", programme: 0, profile: "base" });
    await h.conversions.analyze("c1");
    expect(h.api[1].url).toMatch(/\/v1\/conversions\/c1\/analyze$/);
    await h.conversions.delete("c1");
    expect(h.api[2].init.method).toBe("DELETE");
  });

  it("source rides verbatim on create and on start; absent when not given", async () => {
    const h = harness([created, { status: 202, body: {} }, { status: 202, body: { id: "c1", status: "queued" } }]);
    await h.conversions.create({ file: blob(10), preset: "esfera", durationSec: 5, filename: "a.wav", source: { normalization: "n3d" } });
    expect(JSON.parse(h.api[0].init.body as string)).toMatchObject({ source: { normalization: "n3d" } });
    await h.conversions.start("c1", { preset: "esfera", source: { normalization: "fuma" } });
    expect(JSON.parse(h.api[2].init.body as string)).toEqual({ preset: "esfera", source: { normalization: "fuma" } });
  });

  it("the two ambisonic refusals surface as InvalidRequestError with their slug", async () => {
    for (const slug of ["invalid-source-normalization", "preset-not-for-source"]) {
      const h = harness([{ status: 422, body: { type: `https://esfera.audio/errors/${slug}`, title: "No", status: 422, detail: "d" } }]);
      const err = await h.conversions.start("c1", { source: { normalization: "fuma" } }).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidRequestError);
      expect(err.slug).toBe(slug);
    }
  });

  it("download streams the output and downloadToBuffer collects it", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetch = (async () => new Response(bytes, { status: 200, headers: { "content-type": "audio/iamf" } })) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch });
    const r = new ConversionsResource(http);
    const stream = await r.download("c1");
    expect(stream).toBeInstanceOf(ReadableStream);
    const buf = await r.job("c1").downloadToBuffer();
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });

  it("download(path) writes the file in Node and returns the byte count", async () => {
    const bytes = new Uint8Array(10);
    const fetch = (async () => new Response(bytes, { status: 200 })) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch });
    const { mkdtempSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dest = join(mkdtempSync(join(tmpdir(), "sdk-")), "out.iamf");
    const r = await new ConversionsResource(http).job("c1").download(dest);
    expect(r).toEqual({ path: dest, bytes: 10 });
    expect(statSync(dest).size).toBe(10);
  });
});
