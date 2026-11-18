import { describe, it, expect } from "vitest";
import {
  EsferaError, ApiError, AuthenticationError, RateLimitError, QuotaExceededError, ConcurrencyLimitError,
  NotFoundError, InvalidRequestError, ConflictError, UploadError, ConversionFailedError, ConversionStalledError,
  SignatureVerificationError, SandboxLimitError, errorFromResponse,
} from "../src/errors.js";

const problem = (slug: string, status: number, detail = "d") => ({
  type: `https://esfera.audio/errors/${slug}`, title: slug, status, detail,
});
const H = (init: Record<string, string> = {}) => new Headers(init);

describe("errorFromResponse", () => {
  it.each([
    ["invalid-api-key", 401, AuthenticationError],
    ["rate-limited", 429, RateLimitError],
    ["not-found", 404, NotFoundError],
    ["invalid-request", 400, InvalidRequestError],
    ["unknown-preset", 422, InvalidRequestError],
    ["invalid-programme", 422, InvalidRequestError],
    ["invalid-profile", 422, InvalidRequestError],
    ["profile-not-writable", 422, InvalidRequestError],
    ["file-too-long", 422, InvalidRequestError],
    ["invalid-webhook-url", 422, InvalidRequestError],
    ["quota-exhausted", 403, QuotaExceededError],
    ["concurrency-limit", 409, ConcurrencyLimitError],
    ["already-started", 409, ConflictError],
    ["programme-required", 409, ConflictError],
    ["source-removed", 409, ConflictError],
    ["webhook-limit", 409, ConflictError],
    ["replay-in-flight", 409, ConflictError],
    ["internal", 500, ApiError],
    ["queue-unavailable", 503, ApiError],
  ])("%s (%i) → %p", (slug, status, cls) => {
    const err = errorFromResponse(status, problem(slug, status), H());
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(EsferaError);
    expect(err.status).toBe(status);
    expect(err.type).toBe(`https://esfera.audio/errors/${slug}`);
    expect(err.detail).toBe("d");
  });

  it("keeps an unknown slug from a future server as a plain ApiError with every field intact", () => {
    const err = errorFromResponse(418, problem("something-new", 418, "teapot"), H());
    expect(err.constructor).toBe(ApiError);
    expect(err.type).toBe("https://esfera.audio/errors/something-new");
    expect(err.title).toBe("something-new");
    expect(err.detail).toBe("teapot");
    expect(err.message).toContain("teapot");
  });

  it("a non-problem body still yields an ApiError", () => {
    const err = errorFromResponse(502, "<html>bad gateway</html>", H());
    expect(err).toBeInstanceOf(ApiError);
    expect(err.type).toBe("about:blank");
    expect(err.detail).toBe("HTTP 502");
  });

  it("parses Retry-After seconds on 429 and exposes requestId when present", () => {
    const err = errorFromResponse(429, problem("rate-limited", 429), H({ "Retry-After": "7", "cf-ray": "abc123" }));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(7);
    expect(err.requestId).toBe("abc123");
  });

  it("requestId is the Request-Id header, the id support asks for", () => {
    const err = errorFromResponse(404, problem("not-found", 404), H({ "Request-Id": "req_0123456789abcdefghijABCD", "cf-ray": "abc123" }));
    expect(err.requestId).toBe("req_0123456789abcdefghijABCD");
  });

  it("requestId falls back to cf-ray only when Request-Id is absent", () => {
    expect(errorFromResponse(502, "bad gateway", H({ "cf-ray": "abc123" })).requestId).toBe("abc123");
    expect(errorFromResponse(502, "bad gateway", H()).requestId).toBeUndefined();
  });

  it("a 429 sandbox-limit is a SandboxLimitError with limit and resetsAt, not a RateLimitError", () => {
    const body = { ...problem("sandbox-limit", 429), limit: "daily_conversions", resets_at: "2026-11-18T00:00:00.000Z" };
    const err = errorFromResponse(429, body, H({ "Retry-After": "3600" }));
    expect(err).toBeInstanceOf(SandboxLimitError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    const s = err as SandboxLimitError;
    expect(s.limit).toBe("daily_conversions");
    expect(s.resetsAt).toEqual(new Date("2026-11-18T00:00:00.000Z"));
    expect(s.retryAfter).toBe(3600);
  });

  it("a source_length sandbox-limit has no reset", () => {
    const body = { ...problem("sandbox-limit", 429), limit: "source_length", resets_at: null };
    const err = errorFromResponse(429, body, H()) as SandboxLimitError;
    expect(err).toBeInstanceOf(SandboxLimitError);
    expect(err.limit).toBe("source_length");
    expect(err.resetsAt).toBeNull();
    expect(err.retryAfter).toBeUndefined();
  });

  it("the non-HTTP errors carry their payloads", () => {
    const conv = { id: "c1", status: "error", errorMessage: "boom" } as never;
    expect(new ConversionFailedError(conv).conversion).toBe(conv);
    expect(new ConversionStalledError(conv, 300_000).stalledMs).toBe(300_000);
    expect(new UploadError(403).status).toBe(403);
    expect(new SignatureVerificationError("stale")).toBeInstanceOf(EsferaError);
  });
});
