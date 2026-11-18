import { describe, it, expect } from "vitest";
import { HttpClient } from "../src/http.js";
import { NotFoundError, ApiError, RateLimitError, SandboxLimitError } from "../src/errors.js";
import { SDK_VERSION } from "../src/version.js";

type Step = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that plays a script of responses and records every call. */
function scripted(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const step = steps.shift();
    if (!step) throw new Error("script exhausted");
    if (step instanceof Error) throw step;
    const headers = new Headers({ "content-type": "application/json", ...(step.headers ?? {}) });
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), { status: step.status, headers });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function client(steps: Step[], opts: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const sleeps: number[] = [];
  const s = scripted(steps);
  const http = new HttpClient({
    apiKey: "esf_sk_test_v1_k_s", baseUrl: "https://api.test", maxRetries: 3, timeoutMs: 30_000,
    fetch: s.fetch, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, ...opts,
  });
  return { http, calls: s.calls, sleeps };
}
const problem = (slug: string, status: number) => ({ type: `https://esfera.audio/errors/${slug}`, title: slug, status, detail: "d" });

describe("HttpClient request ids", () => {
  it("puts the Request-Id on a successful JSON object without making it enumerable", async () => {
    const { http } = client([{ status: 200, body: { plan: "sandbox" }, headers: { "Request-Id": "req_5U4Psco0sEHr2sJaa7bGhia0" } }]);
    const body = await http.request<{ plan: string; requestId?: string }>("GET", "/v1/usage");
    expect(body.requestId).toBe("req_5U4Psco0sEHr2sJaa7bGhia0");
    expect(Object.keys(body)).toEqual(["plan"]);
    expect(JSON.stringify(body)).toBe('{"plan":"sandbox"}');
    expect(http.lastRequestId).toBe("req_5U4Psco0sEHr2sJaa7bGhia0");
  });
  it("lastRequestId follows every response, errors included", async () => {
    const { http } = client([
      { status: 200, body: { ok: 1 }, headers: { "Request-Id": "req_one" } },
      { status: 404, body: problem("not-found", 404), headers: { "Request-Id": "req_two" } },
    ]);
    await http.request("GET", "/v1/usage");
    await expect(http.request("GET", "/v1/conversions/x")).rejects.toBeInstanceOf(NotFoundError);
    expect(http.lastRequestId).toBe("req_two");
  });
  it("PATCH is retried on 5xx like GET", async () => {
    const { http, calls } = client([{ status: 503, body: problem("internal", 503) }, { status: 200, body: { id: "w1" } }]);
    await http.request("PATCH", "/v1/webhooks/w1", { body: { description: "x" } });
    expect(calls).toHaveLength(2);
  });
});

describe("HttpClient", () => {
  it("sends the bearer key, Accept, User-Agent, and JSON content type only with a body", async () => {
    const { http, calls } = client([{ status: 200, body: { ok: 1 } }, { status: 200, body: { ok: 2 } }]);
    await http.request("GET", "/v1/usage");
    await http.request("POST", "/v1/webhooks", { body: { url: "https://x" }, idempotencyKey: "k" });
    const h0 = new Headers(calls[0].init.headers);
    expect(h0.get("authorization")).toBe("Bearer esf_sk_test_v1_k_s");
    expect(h0.get("accept")).toBe("application/json");
    expect(h0.get("user-agent")).toMatch(/^esfera-sdk\/\d+\.\d+\.\d+ node\//);
    expect(h0.get("content-type")).toBeNull();
    const h1 = new Headers(calls[1].init.headers);
    expect(h1.get("content-type")).toBe("application/json");
    expect(h1.get("idempotency-key")).toBe("k");
    expect(calls[1].init.body).toBe(JSON.stringify({ url: "https://x" }));
  });

  it("names itself in X-Esfera-Client", async () => {
    const { http, calls } = client([{ status: 200, body: {} }]);
    await http.request("GET", "/v1/usage");
    expect(new Headers(calls[0].init.headers).get("x-esfera-client")).toBe(`esfera-sdk/${SDK_VERSION}`);
  });

  it("lets a caller replace X-Esfera-Client (the CLI names itself)", async () => {
    const { http, calls } = client([{ status: 200, body: {} }], { clientName: "esfera-cli/9.9.9" });
    await http.request("GET", "/v1/usage");
    expect(new Headers(calls[0].init.headers).get("x-esfera-client")).toBe("esfera-cli/9.9.9");
  });

  it("never retries a 429 sandbox-limit: it throws SandboxLimitError at once", async () => {
    const body = { ...problem("sandbox-limit", 429), limit: "daily_conversions", resets_at: "2026-11-18T00:00:00.000Z" };
    const { http, calls, sleeps } = client([{ status: 429, body, headers: { "Retry-After": "40000" } }, { status: 200, body: {} }]);
    const err = await http.request("POST", "/v1/conversions", { body: {}, idempotencyKey: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxLimitError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("caps a Retry-After sleep at 60 s", async () => {
    const { http, calls, sleeps } = client([{ status: 429, body: problem("rate-limited", 429), headers: { "Retry-After": "86400" } }, { status: 200, body: {} }]);
    await http.request("GET", "/v1/usage");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([60_000]);
  });

  it("serialises query params and drops undefined ones", async () => {
    const { http, calls } = client([{ status: 200, body: {} }]);
    await http.request("GET", "/v1/conversions", { query: { page: 2, status: undefined, pageSize: 25 } });
    expect(calls[0].url).toBe("https://api.test/v1/conversions?page=2&pageSize=25");
  });

  it("retries a 429 after Retry-After seconds", async () => {
    const { http, calls, sleeps } = client([{ status: 429, body: problem("rate-limited", 429), headers: { "Retry-After": "2" } }, { status: 200, body: { ok: true } }]);
    expect(await http.request("GET", "/v1/usage")).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("retries 5xx with exponential backoff (500 ms base, jitter)", async () => {
    const { http, calls, sleeps } = client([{ status: 503, body: problem("internal", 503) }, { status: 502, body: {} }, { status: 200, body: { ok: 1 } }]);
    await http.request("GET", "/v1/usage");
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(375); expect(sleeps[0]).toBeLessThanOrEqual(625);
    expect(sleeps[1]).toBeGreaterThanOrEqual(750); expect(sleeps[1]).toBeLessThanOrEqual(1250);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { http, calls } = client([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }]);
    await expect(http.request("GET", "/v1/usage")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(4); // 1 + 3 retries
  });

  it("never retries a POST without an idempotency key", async () => {
    const { http, calls } = client([{ status: 503, body: {} }, { status: 201, body: {} }]);
    await expect(http.request("POST", "/v1/conversions/x/analyze")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it("retries a POST that carries an idempotency key", async () => {
    const { http, calls } = client([{ status: 503, body: {} }, { status: 201, body: { id: "c1" } }]);
    expect(await http.request("POST", "/v1/conversions", { body: {}, idempotencyKey: "abc" })).toEqual({ id: "c1" });
    expect(calls).toHaveLength(2);
  });

  it("never retries a 4xx other than 429", async () => {
    const { http, calls } = client([{ status: 404, body: problem("not-found", 404) }, { status: 200, body: {} }]);
    await expect(http.request("GET", "/v1/conversions/nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toHaveLength(1);
  });

  it("retries a network error", async () => {
    const { http, calls } = client([new TypeError("fetch failed"), { status: 200, body: { ok: 1 } }]);
    expect(await http.request("GET", "/v1/usage")).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it("parses the rate-limit headers on every response, including degraded", async () => {
    const { http } = client([
      { status: 200, body: {}, headers: { "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "119", "X-RateLimit-Reset": "1762600000" } },
      { status: 200, body: {}, headers: { "X-RateLimit-Limit": "120", "X-RateLimit-Degraded": "true" } },
    ]);
    expect(http.rateLimit).toBeNull();
    await http.request("GET", "/v1/usage");
    expect(http.rateLimit).toEqual({ limit: 120, remaining: 119, resetAt: new Date(1762600000 * 1000), degraded: false });
    await http.request("GET", "/v1/usage");
    expect(http.rateLimit?.degraded).toBe(true);
    expect(http.rateLimit?.remaining).toBeNull();
  });

  it("a 429 that exhausts retries surfaces as RateLimitError with retryAfter", async () => {
    const { http } = client([{ status: 429, body: problem("rate-limited", 429), headers: { "Retry-After": "1" } }], { maxRetries: 0 });
    const err = await http.request("GET", "/v1/usage").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(1);
  });

  it("a request can opt out of the timeout so a long download body is never aborted", async () => {
    const { http, calls } = client([{ status: 200, body: {} }, { status: 200, body: {} }], { timeoutMs: 30_000 });
    await http.requestRaw("GET", "/v1/conversions/c1/output", { noTimeout: true });
    expect(calls[0].init.signal).toBeUndefined();
    await http.requestRaw("GET", "/v1/usage");
    expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("requestRaw returns the Response for non-JSON bodies", async () => {
    const { http } = client([{ status: 200, body: { any: "thing" }, headers: { "content-type": "audio/iamf" } }]);
    const res = await http.requestRaw("GET", "/v1/conversions/c1/output");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/iamf");
  });
});
