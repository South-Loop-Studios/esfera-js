/**
 * `new Esfera({ apiKey })` — the entry point.
 *
 * Server-side only: it carries your API key. Zero runtime dependencies; global
 * `fetch` and `crypto.subtle`. Pass `fetch` to test against a fake.
 */
import { HttpClient, type RateLimitState } from "./http.js";
import { InvalidRequestError } from "./errors.js";
import { ConversionsResource } from "./resources/conversions.js";
import { WebhooksResource } from "./resources/webhooks.js";
import { EventsResource } from "./resources/events.js";
import { UsageResource } from "./resources/usage.js";
import { PresetsResource } from "./resources/presets.js";
import { FilesResource } from "./resources/files.js";
import { verifyWebhookSignature, constructWebhookEvent } from "./signature.js";

export interface EsferaOptions {
  /** A Sandbox key, `esf_sk_test_v1_…`, from the Esfera Console. Live keys (`esf_sk_live_v1_…`) are coming soon. */
  apiKey: string;
  /** Default `https://api.esfera.audio`, for Sandbox and Live keys alike. Set it only to reach another deployment, such as staging. */
  baseUrl?: string;
  /** Extra attempts on 429 / 5xx / network errors for retryable requests. Default 3. */
  maxRetries?: number;
  /** Per control-plane request. Uploads are not timed. Default 30 000. */
  timeoutMs?: number;
  /** Injectable, for tests. */
  fetch?: typeof globalThis.fetch;
  /** Sent as `X-Esfera-Client` so request logs show what called. Default `esfera-sdk/<version>`. */
  clientName?: string;
}

export const DEFAULT_BASE_URL = "https://api.esfera.audio";

export class Esfera {
  readonly baseUrl: string;
  readonly conversions: ConversionsResource;
  readonly webhooks: WebhooksResource;
  readonly events: EventsResource;
  readonly usage: UsageResource;
  readonly presets: PresetsResource;
  readonly files: FilesResource;
  readonly #http: HttpClient;

  /** Signature helpers for your webhook receiver — static, no key needed. */
  static readonly webhooks = { verify: verifyWebhookSignature, constructEvent: constructWebhookEvent };

  constructor(opts: EsferaOptions) {
    if (!opts || typeof opts.apiKey !== "string" || opts.apiKey.trim() === "") {
      throw new InvalidRequestError({
        status: 400, type: "https://esfera.audio/errors/invalid-request", title: "Invalid request",
        detail: "apiKey is required — the esf_sk_… secret from the Esfera Console (console.esfera.audio) or ESFERA_API_KEY",
      });
    }
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#http = new HttpClient({
      apiKey: opts.apiKey.trim(),
      baseUrl: this.baseUrl,
      maxRetries: opts.maxRetries ?? 3,
      timeoutMs: opts.timeoutMs ?? 30_000,
      fetch: opts.fetch,
      clientName: opts.clientName,
    });
    this.conversions = new ConversionsResource(this.#http);
    this.webhooks = new WebhooksResource(this.#http);
    this.events = new EventsResource(this.#http);
    this.usage = new UsageResource(this.#http);
    this.presets = new PresetsResource(this.#http);
    this.files = new FilesResource();
  }

  /** The `Request-Id` of the last response this client received, success or error; null before any call. */
  get lastRequestId(): string | null {
    return this.#http.lastRequestId;
  }

  /** The last `X-RateLimit-*` headers seen, or null before any call. */
  get rateLimit(): RateLimitState | null {
    return this.#http.rateLimit;
  }
}
