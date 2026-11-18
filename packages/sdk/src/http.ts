/**
 * The one place the SDK talks HTTP.
 *
 * Retry policy (spec §3.3): GET/PATCH/DELETE, and POSTs that carry an Idempotency-Key,
 * retry on a `rate-limited` 429 (honouring Retry-After, capped at 60 s), on 5xx
 * and on network errors —
 * exponential backoff, 500 ms base with ±25 % jitter, capped at 30 s, up to
 * `maxRetries` extra attempts. A POST without a key is never retried (it could
 * double-spend), and a 4xx other than a rate-limit 429 is never retried (it
 * won't change). A 429 `sandbox-limit` is never retried: its reset can be hours
 * away, so it is thrown as `SandboxLimitError` for the caller to decide.
 *
 * `fetch`, `sleep` and `random` are injectable so every branch is testable
 * without timers or a network.
 */
import { errorFromResponse, SandboxLimitError, type ApiError } from "./errors.js";
import { SDK_VERSION } from "./version.js";

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Sent as `X-Esfera-Client`. Default `esfera-sdk/<version>`. */
  clientName?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Skip the per-request timeout — for downloads, whose body can legitimately take minutes. */
  noTimeout?: boolean;
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
  /** The limiter was unavailable and the request was allowed through unmetered. */
  degraded: boolean;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** The longest a Retry-After is honoured for. The API's per-minute windows never ask for more. */
const MAX_RETRY_AFTER_MS = 60_000;

export class HttpClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #clientName: string;
  rateLimit: RateLimitState | null = null;
  /** The `Request-Id` of the last response, success or error. */
  lastRequestId: string | null = null;
  /** The fetch this client was constructed with — for the presigned PUT, which must not carry the API key. */
  readonly rawFetch: typeof globalThis.fetch;

  constructor(opts: HttpClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#maxRetries = Math.max(0, opts.maxRetries);
    this.#timeoutMs = opts.timeoutMs;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.rawFetch = this.#fetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = opts.random ?? Math.random;
    this.#clientName = opts.clientName ?? `esfera-sdk/${SDK_VERSION}`;
  }

  /**
   * JSON in, JSON out. Throws a typed `ApiError` subclass on any non-2xx. The
   * top-level JSON object of the response comes back with a non-enumerable
   * `requestId` (the response's `Request-Id`), so it is readable but stays out
   * of JSON.stringify and object spreads. Nested objects (list items) do not
   * get one.
   */
  async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.requestRaw(method, path, opts);
    if (res.status === 204) return undefined as T;
    const body = (await res.json()) as T;
    const id = res.headers.get("Request-Id");
    if (id && body !== null && typeof body === "object" && !Array.isArray(body)) {
      Object.defineProperty(body, "requestId", { value: id, enumerable: false, configurable: true });
    }
    return body;
  }

  /** The raw `Response` for a 2xx (downloads). Same retry policy and error mapping. */
  async requestRaw(method: Method, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.#url(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": `esfera-sdk/${SDK_VERSION} node/${typeof process !== "undefined" ? process.versions?.node ?? "?" : "?"}`,
      "X-Esfera-Client": this.#clientName,
      ...(opts.headers ?? {}),
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const retryable = method !== "POST" || Boolean(opts.idempotencyKey);

    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body, signal: this.#signal(opts.signal, opts.noTimeout) });
      } catch (err) {
        if (isAbort(err) || !retryable || attempt >= this.#maxRetries) throw err;
        await this.#sleep(this.#backoff(attempt++));
        continue;
      }
      this.#readRateLimit(res.headers);
      this.lastRequestId = res.headers.get("Request-Id");
      if (res.ok) return res;

      const error = await this.#errorFor(res);
      const rateLimited = res.status === 429 && !(error instanceof SandboxLimitError);
      const shouldRetry = retryable && attempt < this.#maxRetries && (rateLimited || res.status >= 500);
      if (!shouldRetry) throw error;
      const wait = rateLimited && error.retryAfter !== undefined
        ? Math.min(MAX_RETRY_AFTER_MS, error.retryAfter * 1000)
        : this.#backoff(attempt);
      attempt++;
      await this.#sleep(wait);
    }
  }

  #url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  #signal(caller?: AbortSignal, noTimeout = false): AbortSignal | undefined {
    if (noTimeout) return caller;
    const timeout = this.#timeoutMs > 0 && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(this.#timeoutMs) : undefined;
    if (caller && timeout) return typeof AbortSignal.any === "function" ? AbortSignal.any([caller, timeout]) : caller;
    return caller ?? timeout;
  }

  #backoff(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    const jitter = (this.#random() - 0.5) * 0.5; // ±25 %
    return Math.round(base * (1 + jitter));
  }

  async #errorFor(res: Response): Promise<ApiError> {
    let parsed: unknown = undefined;
    const text = await res.text().catch(() => "");
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return errorFromResponse(res.status, parsed, res.headers);
  }

  #readRateLimit(h: Headers): void {
    const limit = h.get("X-RateLimit-Limit");
    if (limit === null) return;
    const remaining = h.get("X-RateLimit-Remaining");
    const reset = h.get("X-RateLimit-Reset");
    this.rateLimit = {
      limit: toInt(limit),
      remaining: toInt(remaining),
      resetAt: reset !== null && toInt(reset) !== null ? new Date(Number(reset) * 1000) : null,
      degraded: h.get("X-RateLimit-Degraded") === "true",
    };
  }
}

function toInt(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}
