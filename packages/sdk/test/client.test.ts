import { describe, it, expect } from "vitest";
import { Esfera } from "../src/index.js";
import { InvalidRequestError, ApiError, ConversionJob, CONVERSION_FIELDS } from "../src/index.js";

function fetchRecorder(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "7", "X-RateLimit-Reset": "1762600000" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Esfera client", () => {
  it("refuses an empty key", () => {
    expect(() => new Esfera({ apiKey: "" })).toThrow(InvalidRequestError);
  });
  it("defaults to production and exposes every resource", () => {
    const { fetch } = fetchRecorder({});
    const e = new Esfera({ apiKey: "esf_sk_live_v1_k_s", fetch });
    expect(e.baseUrl).toBe("https://api.esfera.audio");
    for (const r of ["conversions", "webhooks", "events", "usage", "presets", "files"] as const) expect(e[r]).toBeDefined();
    expect(e.rateLimit).toBeNull();
    expect(e.conversions.job("c1")).toBeInstanceOf(ConversionJob);
  });
  it("usage.get hits GET /v1/usage with the bearer header and updates rateLimit", async () => {
    const usage = { plan: "pro", period: { resetsMonthly: true, resetsAt: "2026-12-01T00:00:00.000Z" }, minutes: { used: 1, included: 2, remaining: 3, planRemaining: 1, credit: 2 }, limits: { perFileMinutes: 90, perFileBytes: 16 * 1024 ** 3, concurrent: 2, inFlight: 0, rateLimitPerMinute: 120, retentionHours: 72 } };
    const { fetch, calls } = fetchRecorder(usage);
    const e = new Esfera({ apiKey: "esf_sk_test_v1_k_s", baseUrl: "https://staging-api.esfera.audio/", fetch });
    expect(await e.usage.get()).toEqual(usage);
    expect(calls[0].url).toBe("https://staging-api.esfera.audio/v1/usage");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer esf_sk_test_v1_k_s");
    expect(e.rateLimit?.remaining).toBe(7);
  });
  it("presets.get hits GET /v1/presets", async () => {
    const presets = { engine: { orbitcore: "2.2.0" }, profiles: [], presets: [] };
    const { fetch, calls } = fetchRecorder(presets);
    const e = new Esfera({ apiKey: "k", fetch });
    expect(await e.presets.get()).toEqual(presets);
    expect(calls[0].url).toBe("https://api.esfera.audio/v1/presets");
  });
  it("static webhook helpers are on the class", () => {
    expect(typeof Esfera.webhooks.verify).toBe("function");
    expect(typeof Esfera.webhooks.constructEvent).toBe("function");
  });
  it("re-exports the errors and the field lists", async () => {
    const { fetch } = fetchRecorder({ type: "https://esfera.audio/errors/not-found", title: "Not found", status: 404, detail: "x" }, 404);
    const e = new Esfera({ apiKey: "k", fetch, maxRetries: 0 });
    await expect(e.conversions.get("nope")).rejects.toBeInstanceOf(ApiError);
    expect(CONVERSION_FIELDS).toContain("outputProfile");
  });
});
