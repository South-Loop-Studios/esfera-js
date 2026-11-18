import { describe, it, expect } from "vitest";
import { autoPage } from "../src/pagination.js";
import { HttpClient } from "../src/http.js";
import { EventsResource } from "../src/resources/events.js";
import { WebhooksResource } from "../src/resources/webhooks.js";
import { ConversionsResource } from "../src/resources/conversions.js";
import type { List } from "../src/types.js";

const list = <T extends { id: string }>(data: T[], has_more: boolean): List<T> => ({
  object: "list", data, has_more, next_cursor: has_more ? data[data.length - 1].id : null,
});

function harness(pages: unknown[]) {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const body = pages.shift();
    if (body === undefined) throw new Error("fetched past the last page");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "Request-Id": `req_${urls.length}` } });
  }) as unknown as typeof globalThis.fetch;
  const http = new HttpClient({ apiKey: "k", baseUrl: "https://api.test", maxRetries: 0, timeoutMs: 0, fetch });
  return { http, urls };
}

describe("autoPage", () => {
  it("follows next_cursor and stops when has_more is false", async () => {
    const seen: (string | undefined)[] = [];
    const pages = [list([{ id: "a" }, { id: "b" }], true), list([{ id: "c" }], false)];
    const out: string[] = [];
    for await (const x of autoPage(async (after) => { seen.push(after); return pages.shift()!; })) out.push(x.id);
    expect(out).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([undefined, "b"]);
  });
  it("makes one request when the first page has has_more false", async () => {
    let calls = 0;
    const out: string[] = [];
    for await (const x of autoPage(async () => { calls++; return list([{ id: "a" }], false); })) out.push(x.id);
    expect(calls).toBe(1);
    expect(out).toEqual(["a"]);
  });
  it("stops on an empty page even if has_more says otherwise", async () => {
    let calls = 0;
    for await (const _ of autoPage(async () => { calls++; return { object: "list", data: [], has_more: true, next_cursor: null } as List<{ id: string }>; })) void _;
    expect(calls).toBe(1);
  });
  it("stops when a cursor repeats, even one from two pages back", async () => {
    const cursors = ["b", "d", "b"];
    let calls = 0;
    const out: string[] = [];
    for await (const x of autoPage(async () => {
      const c = cursors[calls++];
      return { object: "list", data: [{ id: `${c}-item` }], has_more: true, next_cursor: c } as List<{ id: string }>;
    })) out.push(x.id);
    expect(calls).toBe(3);
    expect(out).toEqual(["b-item", "d-item", "b-item"]);
  });
  it("treats the starting cursor as used", async () => {
    let calls = 0;
    for await (const _ of autoPage(async () => { calls++; return { object: "list", data: [{ id: "x" }], has_more: true, next_cursor: "start" } as List<{ id: string }>; }, "start")) void _;
    expect(calls).toBe(1);
  });
  it("can be abandoned early without fetching further pages", async () => {
    let calls = 0;
    for await (const x of autoPage(async () => { calls++; return list([{ id: "a" }, { id: "b" }], true); })) { if (x.id === "a") break; }
    expect(calls).toBe(1);
  });
});

describe("listAll on every list", () => {
  it("events.listAll passes filters on every page and starting_after from the second", async () => {
    const h = harness([list([{ id: "evt_1" }, { id: "evt_2" }], true), list([{ id: "evt_3" }], false)]);
    const ids: string[] = [];
    for await (const e of new EventsResource(h.http).listAll({ type: "conversion.completed", createdGte: new Date(1756200000_000), limit: 2 })) ids.push(e.id);
    expect(ids).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(h.urls[0]).toBe("https://api.test/v1/events?type=conversion.completed&created_gte=1756200000&limit=2");
    expect(h.urls[1]).toBe("https://api.test/v1/events?type=conversion.completed&created_gte=1756200000&starting_after=evt_2&limit=2");
  });
  it("webhooks.listAll, deliveries.listAll and conversions.listAll walk with starting_after", async () => {
    const h = harness([
      list([{ id: "w1" }], true), list([{ id: "w2" }], false),
      list([{ id: "d1" }], true), list([{ id: "d2" }], false),
      list([{ id: "c1" }], true), list([{ id: "c2" }], false),
    ]);
    const w = new WebhooksResource(h.http);
    const got: string[] = [];
    for await (const x of w.listAll()) got.push(x.id);
    for await (const x of w.deliveries.listAll("w1")) got.push(x.id);
    for await (const x of new ConversionsResource(h.http).listAll({ status: "ready" })) got.push(x.id);
    expect(got).toEqual(["w1", "w2", "d1", "d2", "c1", "c2"]);
    // listAll asks for the API's maximum page on every request.
    expect(h.urls[0]).toBe("https://api.test/v1/webhooks?limit=100");
    expect(h.urls[1]).toBe("https://api.test/v1/webhooks?starting_after=w1&limit=100");
    expect(h.urls[2]).toBe("https://api.test/v1/webhooks/w1/deliveries?limit=100");
    expect(h.urls[3]).toBe("https://api.test/v1/webhooks/w1/deliveries?starting_after=d1&limit=100");
    expect(h.urls[4]).toBe("https://api.test/v1/conversions?status=ready&limit=100");
    expect(h.urls[5]).toBe("https://api.test/v1/conversions?status=ready&starting_after=c1&limit=100");
  });
});
