import { describe, it, expect } from "vitest";
import { startDeviceFlow, pollDeviceToken, revokeSelf, type DeviceStart } from "../src/device.js";

const URL = "https://staging-api.esfera.audio";
const KEY = "esf_sk_test_abcdefghijklmnop";
const start: DeviceStart = { deviceCode: "dc", userCode: "WXYZ-1234", verificationUrl: "https://esfera.audio/cli", intervalSec: 3, expiresInSec: 600 };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const problem = (code: string) => ({ error: code, code });

function fakeFetch(queue: Response[]) {
  const calls: [string, RequestInit][] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    const r = queue.shift();
    if (!r) throw new Error("queue empty");
    return r;
  }) as unknown as typeof globalThis.fetch & { calls: [string, RequestInit][] };
  f.calls = calls;
  return f;
}
function deps(f: typeof globalThis.fetch, clock?: { t: number }) {
  const sleeps: number[] = [];
  return {
    fetch: f, sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); if (clock) clock.t += ms; },
    now: () => (clock ? clock.t : 0),
  };
}

describe("device flow", () => {
  it("startDeviceFlow posts the hostname with no bearer and returns the start", async () => {
    const f = fakeFetch([json(200, start)]);
    expect(await startDeviceFlow(URL, "studio-mac", deps(f))).toEqual(start);
    expect(f.calls[0][0]).toBe(`${URL}/api/cli/device`);
    const h = f.calls[0][1].headers as Record<string, string>;
    expect(h.Authorization).toBeUndefined();
    expect(h["User-Agent"]).toMatch(/^esfera-cli\//);
    expect(JSON.parse(f.calls[0][1].body as string)).toEqual({ hostname: "studio-mac" });
  });
  it("startDeviceFlow returns 'unsupported' on 404 and throws on other errors", async () => {
    expect(await startDeviceFlow(URL, "h", deps(fakeFetch([json(404, problem("not-found"))])))).toBe("unsupported");
    await expect(startDeviceFlow(URL, "h", deps(fakeFetch([json(500, problem("boom"))])))).rejects.toThrow();
  });
  it("pollDeviceToken waits intervalSec between 428s, honours Retry-After on 429, and returns the key on 200", async () => {
    const f = fakeFetch([json(428, problem("authorization-pending")), json(429, problem("rate-limited"), { "Retry-After": "7" }), json(200, { apiKey: KEY, keyId: "esf_k_test_7fQ2mR8xKp", apiUrl: URL })]);
    const d = deps(f);
    expect(await pollDeviceToken(URL, start, d)).toEqual({ ok: true, apiKey: KEY, keyId: "esf_k_test_7fQ2mR8xKp", apiUrl: URL });
    expect(d.sleeps).toEqual([3000, 7000]);
    expect(f.calls[0][0]).toBe(`${URL}/api/cli/device/token`);
    expect(JSON.parse(f.calls[0][1].body as string)).toEqual({ deviceCode: "dc" });
    expect((f.calls[0][1].headers as Record<string, string>).Authorization).toBeUndefined();
  });
  it("410 → expired, 403 → denied, and running out of expiresInSec → expired without another call", async () => {
    expect(await pollDeviceToken(URL, start, deps(fakeFetch([json(410, problem("expired"))])))).toEqual({ ok: false, reason: "expired" });
    expect(await pollDeviceToken(URL, start, deps(fakeFetch([json(403, problem("denied"))])))).toEqual({ ok: false, reason: "denied" });
    const clock = { t: 0 };
    const f = fakeFetch([json(428, problem("p")), json(428, problem("p")), json(428, problem("p"))]);
    const short = { ...start, intervalSec: 5, expiresInSec: 10 };
    expect(await pollDeviceToken(URL, short, deps(f, clock))).toEqual({ ok: false, reason: "expired" });
    expect(f.calls.length).toBe(2);
  });
  it("a 5xx or a dropped connection mid-poll is retried at the interval; a run of them gives up", async () => {
    const ok = () => json(200, { apiKey: KEY, keyId: "esf_k_test_7fQ2mR8xKp", apiUrl: URL });
    const f = fakeFetch([json(503, problem("unavailable")), json(428, problem("p")), json(502, { error: "bad gateway" }), ok()]);
    const d = deps(f);
    expect((await pollDeviceToken(URL, start, d)).ok).toBe(true);
    expect(d.sleeps).toEqual([3000, 3000, 3000]);
    // A network error is the same kind of hiccup.
    let dropped = 0;
    const flaky = (async (url: string, init: RequestInit) => {
      if (dropped++ < 2) throw new TypeError("fetch failed");
      return fakeFetch([ok()])(url, init);
    }) as unknown as typeof globalThis.fetch;
    expect((await pollDeviceToken(URL, start, deps(flaky))).ok).toBe(true);
    // Six in a row: the last one is surfaced.
    const down = fakeFetch(Array.from({ length: 6 }, () => json(503, problem("unavailable"))));
    await expect(pollDeviceToken(URL, start, deps(down))).rejects.toThrow();
    expect(down.calls.length).toBe(6);
  });
  it("revokeSelf maps 204/409/404 and sends the bearer", async () => {
    const f = fakeFetch([json(204, null), json(409, problem("last-key")), json(404, problem("nf"))]);
    expect(await revokeSelf(URL, KEY, { fetch: f })).toBe("revoked");
    expect(await revokeSelf(URL, KEY, { fetch: f })).toBe("kept");
    expect(await revokeSelf(URL, KEY, { fetch: f })).toBe("unsupported");
    expect(f.calls[0][0]).toBe(`${URL}/api/cli/keys/self`);
    expect(f.calls[0][1].method).toBe("DELETE");
    expect((f.calls[0][1].headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });
  it("pollDeviceToken: aborting the signal ends the wait between polls at once", async () => {
    const ac = new AbortController();
    const f = fakeFetch([json(428, problem("authorization_pending"))]);
    const p = pollDeviceToken(URL, start, { fetch: f, sleep: () => new Promise(() => {}), now: () => 0, signal: ac.signal });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]![1].signal).toBe(ac.signal);
  });
});
