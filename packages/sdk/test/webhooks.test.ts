import { describe, it, expect } from "vitest";
import { HttpClient } from "../src/http.js";
import { WebhooksResource } from "../src/resources/webhooks.js";
import { EventsResource } from "../src/resources/events.js";
import { NotFoundError } from "../src/errors.js";

function harness(script: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const s = script.shift()!;
    return new Response(JSON.stringify(s.body), { status: s.status, headers: { "content-type": "application/json", ...(s.headers ?? {}) } });
  }) as unknown as typeof globalThis.fetch;
  const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch });
  return { webhooks: new WebhooksResource(http), events: new EventsResource(http), http, calls };
}

const hook = { id: "w1", object: "webhook_endpoint", mode: "sandbox", url: "https://x/hook", events: ["conversion.completed"], description: null, createdAt: "t", revokedAt: null };

describe("webhooks", () => {
  it("create POSTs the url and returns the one-time secret", async () => {
    const h = harness([{ status: 201, body: { id: "w1", url: "https://x/hook", secret: "whsec_esf_abc" } }]);
    const w = await h.webhooks.create({ url: "https://x/hook" });
    expect(w.secret).toBe("whsec_esf_abc");
    expect(h.calls[0].init.method).toBe("POST");
    expect(JSON.parse(h.calls[0].init.body as string)).toEqual({ url: "https://x/hook" });
  });
  it("create sends events only when given", async () => {
    const h = harness([{ status: 201, body: { id: "w1", url: "https://x/hook", events: ["conversion.completed"], secret: "s" } }]);
    await h.webhooks.create({ url: "https://x/hook", events: ["conversion.completed"] });
    expect(JSON.parse(h.calls[0].init.body as string)).toEqual({ url: "https://x/hook", events: ["conversion.completed"] });
  });
  it("create sends description only when given", async () => {
    const h = harness([{ status: 201, body: { id: "w1", url: "https://x/hook", events: [], secret: "s" } }, { status: 201, body: { id: "w2", url: "https://x/hook", events: [], secret: "s" } }]);
    await h.webhooks.create({ url: "https://x/hook", description: "production" });
    expect(JSON.parse(h.calls[0].init.body as string)).toEqual({ url: "https://x/hook", description: "production" });
    await h.webhooks.create({ url: "https://x/hook" });
    expect(JSON.parse(h.calls[1].init.body as string)).not.toHaveProperty("description");
  });
  it("list returns the list envelope with cursor params; revoke DELETEs", async () => {
    const h = harness([{ status: 200, body: { object: "list", data: [hook], has_more: false, next_cursor: null, webhooks: [hook] } }, { status: 200, body: { ok: true } }]);
    const list = await h.webhooks.list({ limit: 10, startingAfter: "w0" });
    expect(h.calls[0].url).toBe("https://api.test/v1/webhooks?starting_after=w0&limit=10");
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe("w1");
    expect(list.has_more).toBe(false);
    await h.webhooks.revoke("w1");
    expect(h.calls[1].init.method).toBe("DELETE");
    expect(h.calls[1].url).toMatch(/\/v1\/webhooks\/w1$/);
  });
  it("deliveries.list is paginated under the webhook; replay POSTs to the delivery", async () => {
    const h = harness([
      { status: 200, body: { deliveries: [], total: 0, page: 2, pageSize: 10 } },
      { status: 202, body: { ok: true } },
    ]);
    const page = await h.webhooks.deliveries.list("w1", { page: 2, pageSize: 10 });
    expect(page.total).toBe(0);
    expect(h.calls[0].url).toBe("https://api.test/v1/webhooks/w1/deliveries?page=2&pageSize=10");
    await h.webhooks.deliveries.replay("w1", "d9");
    expect(h.calls[1].url).toMatch(/\/v1\/webhooks\/w1\/deliveries\/d9\/replay$/);
    expect(h.calls[1].init.method).toBe("POST");
  });
  it("update PATCHes only the fields given and returns the endpoint", async () => {
    const h = harness([{ status: 200, body: { ...hook, description: "production" } }]);
    const w = await h.webhooks.update("w1", { events: ["conversion.completed"], description: "production" });
    expect(h.calls[0].init.method).toBe("PATCH");
    expect(h.calls[0].url).toBe("https://api.test/v1/webhooks/w1");
    expect(JSON.parse(h.calls[0].init.body as string)).toEqual({ events: ["conversion.completed"], description: "production" });
    expect(w.description).toBe("production");
  });
  it("rotateSecret sends no body by default and { expireOldNow } when asked; never retried", async () => {
    const h = harness([
      { status: 200, body: { ...hook, secret: "whsec_esf_new" } },
      { status: 200, body: { ...hook, secret: "whsec_esf_newer" } },
    ]);
    const r = await h.webhooks.rotateSecret("w1");
    expect(r.secret).toBe("whsec_esf_new");
    expect(h.calls[0].init.method).toBe("POST");
    expect(h.calls[0].url).toBe("https://api.test/v1/webhooks/w1/rotate-secret");
    expect(h.calls[0].init.body).toBeUndefined();
    expect(new Headers(h.calls[0].init.headers).get("idempotency-key")).toBeNull();
    await h.webhooks.rotateSecret("w1", { expireOldNow: true });
    expect(JSON.parse(h.calls[1].init.body as string)).toEqual({ expireOldNow: true });
  });
});

describe("events", () => {
  it("list maps the options onto the query; get reads one event", async () => {
    const ev = { id: "evt_1", object: "event", type: "conversion.completed" };
    const h = harness([
      { status: 200, body: { object: "list", data: [ev], has_more: false, next_cursor: null } },
      { status: 200, body: ev },
      { status: 200, body: ev },
    ]);
    const page = await h.events.list({ type: "conversion.completed", createdGte: 100, createdLt: 200, limit: 5, startingAfter: "evt_0" });
    expect(h.calls[0].url).toBe("https://api.test/v1/events?type=conversion.completed&created_gte=100&created_lt=200&starting_after=evt_0&limit=5");
    expect(page.data[0].id).toBe("evt_1");
    expect((await h.events.get("evt_1")).id).toBe("evt_1");
    expect(h.calls[1].url).toBe("https://api.test/v1/events/evt_1");
    expect((await h.events.retrieve("evt_1")).id).toBe("evt_1");
  });
  it("an expired or foreign event is a NotFoundError carrying the Request-Id", async () => {
    const h = harness([{ status: 404, body: { type: "https://esfera.audio/errors/not-found", title: "Not found", status: 404, detail: "No such event" }, headers: { "Request-Id": "req_abc" } }]);
    const err = await h.events.get("evt_gone").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.requestId).toBe("req_abc");
  });
});
