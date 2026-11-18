/**
 * `esfera.webhooks` — register, list, change and revoke endpoints, rotate a
 * signing secret, read and replay the delivery log. A secret is returned only
 * by `create()` and `rotateSecret()`. Verification helpers are static on the
 * `Esfera` class (`Esfera.webhooks.constructEvent`).
 */
import type { HttpClient } from "../http.js";
import { autoPage, LIST_ALL_LIMIT, type CursorOptions } from "../pagination.js";
import type {
  EventType, Webhook, WebhookCreate, WebhookCreated, WebhookDelivery, WebhookDeliveryPage, WebhookList, WebhookRotated, WebhookUpdate, WithRequestId,
} from "../types.js";

export interface DeliveryListOptions extends CursorOptions {
  /** Deprecated: use `startingAfter`. Cannot be combined with the cursor options. */
  page?: number;
  /** Deprecated: use `limit`. */
  pageSize?: number;
}

export class WebhookDeliveriesResource {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  list(webhookId: string, opts: DeliveryListOptions = {}): Promise<WithRequestId<WebhookDeliveryPage>> {
    return this.#http.request<WebhookDeliveryPage>("GET", `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`, {
      query: { starting_after: opts.startingAfter, limit: opts.limit, page: opts.page, pageSize: opts.pageSize },
    });
  }

  /** Every delivery for the endpoint, newest first, page after page. */
  listAll(webhookId: string, opts: CursorOptions = {}): AsyncGenerator<WebhookDelivery, void, undefined> {
    return autoPage((after) => this.list(webhookId, { limit: opts.limit ?? LIST_ALL_LIMIT, startingAfter: after }), opts.startingAfter);
  }

  /** Re-send one delivery. Allowed on delivered rows too (your handler can lose an event after a 2xx). */
  replay(webhookId: string, deliveryId: string): Promise<void> {
    return this.#http.request<void>("POST", `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`);
  }
}

export interface RotateSecretOptions {
  /**
   * Stop the old secret signing now instead of after 24 hours. For a leaked
   * secret. Deliveries are then signed only with the new one, so your receiver
   * must switch at once.
   */
  expireOldNow?: boolean;
}

export class WebhooksResource {
  readonly #http: HttpClient;
  readonly deliveries: WebhookDeliveriesResource;

  constructor(http: HttpClient) {
    this.#http = http;
    this.deliveries = new WebhookDeliveriesResource(http);
  }

  /**
   * https only, no private hosts. `events` defaults to all seven types. Store
   * `secret` now: it is never shown again. `description` is optional free text,
   * at most 200 characters.
   */
  create(input: WebhookCreate): Promise<WithRequestId<WebhookCreated>> {
    const body: WebhookCreate = { url: input.url };
    if (input.events !== undefined) body.events = input.events;
    if (input.description !== undefined) body.description = input.description;
    return this.#http.request<WebhookCreated>("POST", "/v1/webhooks", { body, idempotencyKey: crypto.randomUUID() });
  }

  /** One page of endpoints, revoked ones included, never a secret. */
  list(opts: CursorOptions = {}): Promise<WithRequestId<WebhookList>> {
    return this.#http.request<WebhookList>("GET", "/v1/webhooks", { query: { starting_after: opts.startingAfter, limit: opts.limit } });
  }

  /** Every endpoint, page after page. */
  listAll(opts: CursorOptions = {}): AsyncGenerator<Webhook, void, undefined> {
    return autoPage((after) => this.list({ limit: opts.limit ?? LIST_ALL_LIMIT, startingAfter: after }), opts.startingAfter);
  }

  /** Change `url`, `events` or `description` on an active endpoint. What you leave out is unchanged. */
  update(id: string, patch: WebhookUpdate): Promise<WithRequestId<Webhook>> {
    return this.#http.request<Webhook>("PATCH", `/v1/webhooks/${encodeURIComponent(id)}`, { body: patch });
  }

  /**
   * Mint a new signing secret, returned once. For 24 hours deliveries carry two
   * `v1=` signatures, new and old, unless `expireOldNow` is set. Make sure your
   * receiver accepts more than one `v1=` part before you call this. Never
   * retried: a repeat would rotate twice.
   */
  rotateSecret(id: string, opts: RotateSecretOptions = {}): Promise<WithRequestId<WebhookRotated>> {
    return this.#http.request<WebhookRotated>("POST", `/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`, {
      body: opts.expireOldNow === undefined ? undefined : { expireOldNow: opts.expireOldNow },
    });
  }

  /** Revoked, never deleted: its delivery log stays readable. */
  revoke(id: string): Promise<void> {
    return this.#http.request<void>("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
  }
}
