import { describe, it, expect } from "vitest";
import { HttpClient } from "../src/http.js";
import { ConversionsResource } from "../src/resources/conversions.js";
import { planMultipart, shouldUseMultipart, MULTIPART_THRESHOLD } from "../src/multipartPlan.js";
import { uploadMultipart, resolveSource } from "../src/upload.js";
import { UploadError } from "../src/errors.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("planMultipart", () => {
  it("threshold is 16 MiB, exclusive", () => {
    expect(shouldUseMultipart(MULTIPART_THRESHOLD)).toBe(false);
    expect(shouldUseMultipart(MULTIPART_THRESHOLD + 1)).toBe(true);
  });
  it("100 MiB is 13 parts of 8 MiB, concurrency 4", () => {
    expect(planMultipart(100 * MIB)).toEqual({ partSize: 8 * MIB, partCount: 13, concurrency: 4 });
  });
  it("2 GiB runs 8 wide", () => {
    expect(planMultipart(2 * GIB).concurrency).toBe(8);
  });
  it("100 GiB grows the part to stay within 10 000 parts", () => {
    const p = planMultipart(100 * GIB);
    expect(p.partSize).toBe(11 * MIB);
    expect(p.partCount).toBeLessThanOrEqual(10_000);
    expect(p.partSize % MIB).toBe(0);
  });
});

type PutStep = { status: number; etag?: string | null } | Error;
function harness(putSteps: (i: number) => PutStep[] = () => [], opts: { signSteps?: (number | Error)[]; now?: () => number } = {}) {
  const signSteps = [...(opts.signSteps ?? [])];
  /** When each URL was signed, on the test clock. */
  const signedAt = new Map<string, number>();
  const putAt: { url: string; at: number }[] = [];
  const api: { url: string; body: unknown }[] = [];
  const puts: { url: string; length: number; header: string | null }[] = [];
  const attempts = new Map<number, number>();
  /** URLs storage now refuses with 403 (expired signatures). */
  const stale = new Set<string>();
  let signs = 0;
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    if (u.startsWith("https://r2/")) {
      const n = Number(u.split("?")[0].split("/").pop());
      let bytes = 0;
      const r = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) { const { done, value } = await r.read(); if (done) break; bytes += value.byteLength; }
      puts.push({ url: u, length: bytes, header: new Headers(init.headers).get("content-length") });
      putAt.push({ url: u, at: opts.now?.() ?? 0 });
      const a = attempts.get(n) ?? 0;
      attempts.set(n, a + 1);
      const step = (stale.has(u) ? { status: 403 } : putSteps(n)[a]) ?? { status: 200, etag: `"e${n}"` };
      if (step instanceof Error) throw step;
      return new Response(null, { status: step.status, headers: step.etag === null ? {} : { etag: step.etag ?? `"e${n}"` } });
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    api.push({ url: u.replace("https://api.test", ""), body });
    if (u.endsWith("/multipart/sign")) {
      const step = signSteps.shift();
      if (step instanceof Error) throw step;
      if (typeof step === "number") return Response.json({ type: "https://esfera.audio/errors/internal", title: "x", status: step, detail: "d" }, { status: step });
      signs++;
      const partUrls = body.partNumbers.map((n: number) => ({ partNumber: n, url: `https://r2/part/${n}?v=${signs}` }));
      for (const p of partUrls) signedAt.set(p.url, opts.now?.() ?? 0);
      return Response.json({ uploadId: body.uploadId, partUrls });
    }
    if (u.endsWith("/multipart/init")) {
      const partUrls = Array.from({ length: body.parts }, (_, i) => ({ partNumber: i + 1, url: `https://r2/part/${i + 1}` }));
      for (const p of partUrls) signedAt.set(p.url, opts.now?.() ?? 0);
      return Response.json({ uploadId: "U", partUrls });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch, sleep });
  return { http, api, puts, sleeps, sleep, stale, signedAt, putAt };
}

/** A random-access source of `parts` 8 MiB parts whose reads return one byte: the plan is real, the memory is not. */
function sparse(parts: number) {
  return { name: "big.wav", size: parts * 8 * MIB, rereadable: true, open: async () => new ReadableStream<Uint8Array>(), read: async () => new Uint8Array(1) };
}

// 20 MiB: 3 parts (8, 8, 4 MiB).
const blob = () => new Blob([new Uint8Array(20 * MIB)]);

describe("uploadMultipart", () => {
  it("inits, PUTs every part with Content-Length, completes with unquoted etags", async () => {
    const h = harness();
    const src = await resolveSource(blob());
    await uploadMultipart(h.http, "c1", src, { sleep: h.sleep });
    expect(h.api.map((a) => a.url)).toEqual(["/v1/conversions/c1/multipart/init", "/v1/conversions/c1/multipart/complete"]);
    expect(h.api[0].body).toEqual({ parts: 3 });
    expect(h.puts.map((p) => p.length).sort()).toEqual([4 * MIB, 8 * MIB, 8 * MIB]);
    expect(h.puts.every((p) => p.header === String(p.length))).toBe(true);
    expect(h.api[1].body).toEqual({ uploadId: "U", parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `e${n}` })) });
  });

  it("retries a part that fails twice, with 1 s then 2 s backoff", async () => {
    const h = harness((n) => (n === 2 ? [{ status: 503 }, new TypeError("reset")] : []));
    await uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep });
    expect(h.puts.filter((p) => p.url.endsWith("/2"))).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(h.api.at(-1)?.url).toMatch(/complete$/);
  });

  it("aborts and rethrows when a part fails three times past the first", async () => {
    const h = harness((n) => (n === 2 ? [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }] : []));
    await expect(uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep })).rejects.toBeInstanceOf(UploadError);
    expect(h.puts.filter((p) => p.url.endsWith("/2"))).toHaveLength(4);
    expect(h.api.map((a) => a.url.split("/").pop())).toEqual(["init", "abort"]);
    expect(h.api.at(-1)?.body).toEqual({ uploadId: "U" });
  });

  it("a missing ETag is an error and aborts", async () => {
    const h = harness((n) => (n === 1 ? [{ status: 200, etag: null }] : []));
    await expect(uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep })).rejects.toThrow("part upload returned no ETag");
    expect(h.api.at(-1)?.url).toMatch(/abort$/);
  });

  it("a part refused with 403 (expired URL) is re-signed and sent again, once", async () => {
    const h = harness();
    h.stale.add("https://r2/part/2");
    await uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep });
    const sign = h.api.filter((a) => a.url.endsWith("/multipart/sign"));
    expect(sign).toHaveLength(1);
    expect(sign[0].body).toEqual({ uploadId: "U", partNumbers: [2] });
    expect(h.puts.map((p) => p.url)).toContain("https://r2/part/2?v=1");
    expect(h.api.at(-1)?.url).toMatch(/complete$/);
    expect(h.api.at(-1)?.body).toEqual({ uploadId: "U", parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `e${n}` })) });
  });

  it("a part still refused after its re-sign aborts the upload", async () => {
    const h = harness((n) => (n === 2 ? [{ status: 403 }, { status: 403 }] : []));
    await expect(uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep })).rejects.toBeInstanceOf(UploadError);
    expect(h.api.filter((a) => a.url.endsWith("/multipart/sign"))).toHaveLength(1);
    expect(h.api.at(-1)?.url).toMatch(/abort$/);
  });

  it("re-signs the unsent parts before a part starts on a URL near the end of its hour", async () => {
    const h = harness();
    let t = 0;
    // Each part PUT takes 25 minutes on this clock; one at a time.
    const slow = (async (u: string | URL | Request, init?: RequestInit) => {
      if (String(u).startsWith("https://r2/")) t += 25 * 60_000;
      return h.http.rawFetch(u as string, init);
    }) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch: slow, sleep: h.sleep });
    await uploadMultipart(http, "c1", await resolveSource(blob()), { sleep: h.sleep, now: () => t, concurrency: 1 });
    const sign = h.api.filter((a) => a.url.endsWith("/multipart/sign"));
    // Part 3 would start 50 min after init: re-signed (with every other unsent part) first.
    expect(sign).toHaveLength(1);
    expect(sign[0].body).toEqual({ uploadId: "U", partNumbers: [3] });
    expect(h.puts.map((p) => p.url)).toEqual(["https://r2/part/1", "https://r2/part/2", "https://r2/part/3?v=1"]);
    expect(h.api.at(-1)?.url).toMatch(/complete$/);
  });

  it("a re-sign that fails with 500 is retried, and the upload completes", async () => {
    const h = harness(() => [], { signSteps: [500] });
    h.stale.add("https://r2/part/2");
    await uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep });
    expect(h.api.filter((a) => a.url.endsWith("/multipart/sign"))).toHaveLength(2);
    expect(h.puts.map((p) => p.url)).toContain("https://r2/part/2?v=1");
    expect(h.api.at(-1)?.url).toMatch(/complete$/);
  });

  it("a re-sign that keeps failing aborts the upload with an error naming the re-sign", async () => {
    const h = harness(() => [], { signSteps: [500, new TypeError("reset"), 503, 502] });
    h.stale.add("https://r2/part/2");
    const err = await uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(String(err.message)).toMatch(/re-sign/);
    expect(h.api.filter((a) => a.url.endsWith("/multipart/sign"))).toHaveLength(4);
    expect(h.api.at(-1)?.url).toMatch(/abort$/);
  });

  it("with more than 100 parts left, each re-sign asks for at most 100 and every part starts on a fresh URL", async () => {
    let t = 0;
    const h = harness(() => [], { now: () => t });
    const timed = (async (u: string | URL | Request, init?: RequestInit) => {
      const res = await h.http.rawFetch(u as string, init);
      if (String(u).startsWith("https://r2/")) t += 60_000; // a minute per part
      return res;
    }) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch: timed, sleep: h.sleep });
    await uploadMultipart(http, "c1", sparse(160), { sleep: h.sleep, now: () => t, concurrency: 1 });
    const signs = h.api.filter((a) => a.url.endsWith("/multipart/sign")).map((a) => (a.body as { partNumbers: number[] }).partNumbers);
    expect(signs.length).toBeGreaterThan(1);
    expect(signs[0]).toHaveLength(100);
    for (const s of signs) expect(s.length).toBeLessThanOrEqual(100);
    expect(h.putAt).toHaveLength(160);
    for (const p of h.putAt) expect(p.at - h.signedAt.get(p.url)!).toBeLessThan(45 * 60_000);
    expect(h.api.at(-1)?.url).toMatch(/complete$/);
  });

  it("two workers due at once share one re-sign", async () => {
    let t = 0;
    const h = harness(() => [], { now: () => t });
    const timed = (async (u: string | URL | Request, init?: RequestInit) => {
      const res = await h.http.rawFetch(u as string, init);
      if (String(u).startsWith("https://r2/")) t = 50 * 60_000; // the first round of parts takes 50 minutes
      return res;
    }) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch: timed, sleep: h.sleep });
    await uploadMultipart(http, "c1", sparse(4), { sleep: h.sleep, now: () => t, concurrency: 2 });
    const signs = h.api.filter((a) => a.url.endsWith("/multipart/sign")).map((a) => (a.body as { partNumbers: number[] }).partNumbers);
    expect(signs).toEqual([[3, 4]]);
    expect(h.puts.map((p) => p.url).sort()).toEqual(["https://r2/part/1", "https://r2/part/2", "https://r2/part/3?v=1", "https://r2/part/4?v=1"]);
  });

  it("progress is monotonic and ends at the size", async () => {
    const h = harness((n) => (n === 1 ? [{ status: 503 }] : []));
    const seen: number[] = [];
    await uploadMultipart(h.http, "c1", await resolveSource(blob()), { sleep: h.sleep, onProgress: (p) => { expect(p.total).toBe(20 * MIB); seen.push(p.sent); } });
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.at(-1)).toBe(20 * MIB);
  });
});

describe("conversions.multipart (public)", () => {
  it("init, sign, complete and abort call their routes with the documented bodies", async () => {
    const h = harness();
    const c = new ConversionsResource(h.http);
    const init = await c.multipart.init("c1", { parts: 2 });
    expect(init.uploadId).toBe("U");
    expect(init.partUrls).toHaveLength(2);
    const signed = await c.multipart.sign("c1", { uploadId: "U", partNumbers: [2] });
    expect(signed.partUrls).toEqual([{ partNumber: 2, url: "https://r2/part/2?v=1" }]);
    await c.multipart.complete("c1", { uploadId: "U", parts: [{ partNumber: 1, etag: "e1" }, { partNumber: 2, etag: "e2" }] });
    await c.multipart.abort("c1", { uploadId: "U" });
    expect(h.api.map((a) => a.url)).toEqual(["init", "sign", "complete", "abort"].map((v) => `/v1/conversions/c1/multipart/${v}`));
    expect(h.api[1].body).toEqual({ uploadId: "U", partNumbers: [2] });
    expect(h.api[3].body).toEqual({ uploadId: "U" });
  });
});

describe("create() routes by size", () => {
  const make = (size: number) => {
    const h = harness();
    const base = h.http.rawFetch;
    const calls: string[] = [];
    const fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const s = String(u);
      calls.push(`${init?.method ?? "GET"} ${s.replace("https://api.test", "")}`);
      if (s === "https://api.test/v1/conversions") return Response.json({ id: "c1", uploadUrl: "https://r2/single", autoStart: false }, { status: 201 });
      if (s === "https://r2/single") { await new Response(init!.body as ReadableStream).arrayBuffer(); return new Response(null, { status: 200 }); }
      if (s.endsWith("/analyze")) return new Response(null, { status: 204 });
      return base(u as string, init);
    }) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch, sleep: h.sleep });
    const conversions = new ConversionsResource(http, { sleep: h.sleep, inspect: async () => ({ durationSec: 1, programmeCount: 0 }) });
    return { conversions, calls, file: new Blob([new Uint8Array(size)]) };
  };
  it("a small master uses the single PUT", async () => {
    const t = make(MIB);
    await t.conversions.create({ file: t.file });
    expect(t.calls).toContain("PUT https://r2/single");
    expect(t.calls.some((c) => c.includes("multipart"))).toBe(false);
  });
  it("a master over 16 MiB goes multipart", async () => {
    const t = make(17 * MIB);
    await t.conversions.create({ file: t.file });
    expect(t.calls.some((c) => c.endsWith("/multipart/init"))).toBe(true);
    expect(t.calls.some((c) => c.endsWith("/multipart/complete"))).toBe(true);
    expect(t.calls).not.toContain("PUT https://r2/single");
  });
});
