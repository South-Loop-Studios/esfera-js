/**
 * Typed errors built from the API's RFC 9457 problem documents.
 *
 * Mapping is by HTTP status first, then by the `type` URL's last path segment
 * (the slug the API documents under `x-esfera-problems`). An unknown slug from
 * a newer server still produces an `ApiError` with every field intact — never
 * a parse failure — so an SDK a version behind keeps working.
 */
import type { Conversion } from "./types.js";

export class EsferaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ProblemFields {
  status: number;
  type: string;
  title: string;
  detail: string;
  retryAfter?: number;
  requestId?: string;
}

/** Any non-2xx response. `type` is stable; match on it, not on `title`. */
export class ApiError extends EsferaError {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  /** Seconds the server asked us to wait (429 with Retry-After). */
  readonly retryAfter?: number;
  /** The API's `Request-Id` (`req_…`), the id to quote to support. `cf-ray` only when a response carried no `Request-Id`. */
  readonly requestId?: string;

  constructor(fields: ProblemFields) {
    super(`${fields.title}: ${fields.detail} (HTTP ${fields.status})`);
    this.status = fields.status;
    this.type = fields.type;
    this.title = fields.title;
    this.detail = fields.detail;
    this.retryAfter = fields.retryAfter;
    this.requestId = fields.requestId;
  }

  /** The slug after `https://esfera.audio/errors/`, or null for non-Esfera types. */
  get slug(): string | null {
    const i = this.type.lastIndexOf("/");
    return this.type.startsWith("https://esfera.audio/errors/") && i >= 0 ? this.type.slice(i + 1) : null;
  }
}

/** 401 `invalid-api-key`. */
export class AuthenticationError extends ApiError {}
/** 429 `rate-limited` (or any 429 that is not `sandbox-limit`). Honour `retryAfter`. */
export class RateLimitError extends ApiError {}

/** Which Sandbox limit refused the call. */
export type SandboxLimitName = "source_length" | "daily_conversions";

/**
 * 429 `sandbox-limit`: the team's Sandbox allowance refused the call. Never
 * retried. `source_length` never resets (the master is over 10 minutes);
 * `daily_conversions` resets at `resetsAt`, the next UTC midnight.
 */
export class SandboxLimitError extends ApiError {
  readonly limit: SandboxLimitName | string | null;
  readonly resetsAt: Date | null;

  constructor(fields: ProblemFields, limit: string | null, resetsAt: Date | null) {
    super(fields);
    this.limit = limit;
    this.resetsAt = resetsAt;
  }
}
/** 403 `quota-exhausted`. */
export class QuotaExceededError extends ApiError {}
/** 409 `concurrency-limit`. Kept for older servers: /v1 does not return it today (creates queue instead). */
export class ConcurrencyLimitError extends ApiError {}
/** 404. */
export class NotFoundError extends ApiError {}
/** 400 / 422, and client-side validation. */
export class InvalidRequestError extends ApiError {}
/** Other 409s: `already-started`, `programme-required`, `source-removed`, `webhook-limit`, `replay-in-flight`. */
export class ConflictError extends ApiError {}

/** The presigned PUT to storage answered non-2xx. */
export class UploadError extends EsferaError {
  constructor(readonly status: number, detail = `upload failed: HTTP ${status}`) {
    super(detail);
  }
}

/** The job ended in `error`; `conversion.errorMessage` says why. */
export class ConversionFailedError extends EsferaError {
  constructor(readonly conversion: Conversion) {
    super(conversion.errorMessage ?? "conversion failed");
  }
}

/** The job's (status, progress) did not change for `stalledMs` outside `queued`. */
export class ConversionStalledError extends EsferaError {
  constructor(readonly conversion: Conversion, readonly stalledMs: number) {
    super(`conversion appears stuck at '${conversion.status}' — no progress for ${Math.round(stalledMs / 1000)}s`);
  }
}

/** `Esfera.webhooks.constructEvent` refused the signature. */
export class SignatureVerificationError extends EsferaError {}

const PROBLEM_BASE = "https://esfera.audio/errors/";

const BY_SLUG: Record<string, new (f: ProblemFields) => ApiError> = {
  "quota-exhausted": QuotaExceededError,
  "concurrency-limit": ConcurrencyLimitError,
  "unknown-preset": InvalidRequestError,
  "invalid-programme": InvalidRequestError,
  "invalid-profile": InvalidRequestError,
  "profile-not-writable": InvalidRequestError,
  "invalid-source-normalization": InvalidRequestError,
  "preset-not-for-source": InvalidRequestError,
  "file-too-long": InvalidRequestError,
  "invalid-webhook-url": InvalidRequestError,
  "invalid-request": InvalidRequestError,
  "already-started": ConflictError,
  "programme-required": ConflictError,
  "source-removed": ConflictError,
  "webhook-limit": ConflictError,
  "replay-in-flight": ConflictError,
};

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function isProblem(body: unknown): body is { type?: string; title?: string; status?: number; detail?: string; limit?: unknown; resets_at?: unknown } {
  return typeof body === "object" && body !== null && ("detail" in body || "type" in body || "title" in body);
}

/** Build the right error for a non-2xx response. `body` is the parsed JSON, or anything else. */
export function errorFromResponse(status: number, body: unknown, headers: Headers): ApiError {
  const p = isProblem(body) ? body : {};
  const fields: ProblemFields = {
    status,
    type: typeof p.type === "string" ? p.type : "about:blank",
    title: typeof p.title === "string" ? p.title : `HTTP ${status}`,
    detail: typeof p.detail === "string" ? p.detail : `HTTP ${status}`,
    retryAfter: parseRetryAfter(headers),
    requestId: headers.get("Request-Id") ?? headers.get("cf-ray") ?? undefined,
  };
  const slug = fields.type.startsWith(PROBLEM_BASE) ? fields.type.slice(PROBLEM_BASE.length) : "";
  if (status === 401) return new AuthenticationError(fields);
  if (status === 429 && slug === "sandbox-limit") {
    const at = typeof p.resets_at === "string" ? new Date(p.resets_at) : null;
    return new SandboxLimitError(fields, typeof p.limit === "string" ? p.limit : null, at && !Number.isNaN(at.getTime()) ? at : null);
  }
  if (status === 429) return new RateLimitError(fields);
  if (status === 404) return new NotFoundError(fields);
  if (status === 400 || status === 422) return new InvalidRequestError(fields);
  const Cls = BY_SLUG[slug];
  return Cls ? new Cls(fields) : new ApiError(fields);
}
