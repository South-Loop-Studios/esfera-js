import { describe, it, expect } from "vitest";
// node:crypto is the INDEPENDENT implementation we check crypto.subtle's bytes
// against — the same technique as Esfera/packages/esfera-backend/test/apiWebhooks.test.ts.
import { createHmac } from "node:crypto";
import { verifyWebhookSignature, constructWebhookEvent } from "../src/signature.js";
import { SignatureVerificationError } from "../src/errors.js";

const SECRET = "whsec_esf_test";
const T = 1756200000;
const BODY = '{"event":"conversion.completed","createdAt":"2026-08-26T10:40:00.000Z","data":{"conversion":{"id":"c1"}}}';
const sig = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const now = T * 1000;

describe("verifyWebhookSignature", () => {
  it("known answer: accepts the header the server would have produced", async () => {
    expect(await verifyWebhookSignature(BODY, sig(SECRET, T, BODY), SECRET, { now })).toBe(true);
  });
  it("accepts the raw body as bytes too", async () => {
    expect(await verifyWebhookSignature(new TextEncoder().encode(BODY), sig(SECRET, T, BODY), SECRET, { now })).toBe(true);
  });
  it("rejects a tampered body, a wrong secret, and a stale timestamp", async () => {
    expect(await verifyWebhookSignature(BODY + " ", sig(SECRET, T, BODY), SECRET, { now })).toBe(false);
    expect(await verifyWebhookSignature(BODY, sig("other", T, BODY), SECRET, { now })).toBe(false);
    expect(await verifyWebhookSignature(BODY, sig(SECRET, T, BODY), SECRET, { now: now + 301_000 })).toBe(false);
    expect(await verifyWebhookSignature(BODY, sig(SECRET, T, BODY), SECRET, { now: now + 299_000 })).toBe(true);
    expect(await verifyWebhookSignature(BODY, sig(SECRET, T, BODY), SECRET, { now: now + 301_000, toleranceSec: 600 })).toBe(true);
  });
  it("fails closed on malformed headers and an empty secret, never throwing", async () => {
    for (const bad of ["", "t=,v1=", "v1=abc", "t=abc,v1=zz", `t=${T}`, `t=${T},v1=0g`]) {
      expect(await verifyWebhookSignature(BODY, bad, SECRET, { now })).toBe(false);
    }
    expect(await verifyWebhookSignature(BODY, sig(SECRET, T, BODY), "", { now })).toBe(false);
  });
});

describe("verifyWebhookSignature during a rotation (two v1 parts)", () => {
  const OLD = "whsec_esf_old";
  const NEW = "whsec_esf_new";
  const hex = (secret: string) => createHmac("sha256", secret).update(`${T}.${BODY}`).digest("hex");
  const both = `t=${T},v1=${hex(NEW)},v1=${hex(OLD)}`;

  it("accepts t=…,v1=<a>,v1=<b> when either part matches the secret held", async () => {
    expect(await verifyWebhookSignature(BODY, both, NEW, { now })).toBe(true);
    expect(await verifyWebhookSignature(BODY, both, OLD, { now })).toBe(true);
    // order does not matter
    expect(await verifyWebhookSignature(BODY, `t=${T},v1=${hex(OLD)},v1=${hex(NEW)}`, NEW, { now })).toBe(true);
  });
  it("rejects when no part matches, and still enforces the 300 s tolerance", async () => {
    expect(await verifyWebhookSignature(BODY, both, "whsec_esf_other", { now })).toBe(false);
    expect(await verifyWebhookSignature(BODY + " ", both, NEW, { now })).toBe(false);
    expect(await verifyWebhookSignature(BODY, both, OLD, { now: now + 301_000 })).toBe(false);
    expect(await verifyWebhookSignature(BODY, both, OLD, { now: now + 300_000 })).toBe(true);
  });
  it("ignores a malformed extra part rather than failing on it", async () => {
    expect(await verifyWebhookSignature(BODY, `t=${T},v1=zz,v1=${hex(NEW)}`, NEW, { now })).toBe(true);
  });
  it("constructEvent accepts either secret during the overlap", async () => {
    expect((await constructWebhookEvent(BODY, both, OLD, { now })).type).toBe("conversion.completed");
    expect((await constructWebhookEvent(BODY, both, NEW, { now })).type).toBe("conversion.completed");
  });
});

describe("constructWebhookEvent", () => {
  const FULL = JSON.stringify({
    id: "evt_0123456789abcdefghijklmn", object: "event", type: "conversion.started", mode: "sandbox", created: 1756200000, request_id: "req_5U4Psco0sEHr2sJaa7bGhia0",
    data: { object: { id: "c2", mode: "sandbox" }, conversion: { id: "c2", mode: "sandbox" } }, event: "conversion.started", createdAt: "2025-08-26T09:20:00.000Z",
  });
  it("returns the full event document for a current delivery", async () => {
    const ev = await constructWebhookEvent(FULL, sig(SECRET, T, FULL), SECRET, { now });
    expect(ev.id).toBe("evt_0123456789abcdefghijklmn");
    expect(ev.type).toBe("conversion.started");
    expect(ev.request_id).toBe("req_5U4Psco0sEHr2sJaa7bGhia0");
    expect(ev.data.object.id).toBe("c2");
    expect(ev.created).toBe(1756200000);
  });
  it("fills the new fields from the old ones for a replayed pre-events body", async () => {
    const ev = await constructWebhookEvent(BODY, sig(SECRET, T, BODY), SECRET, { now });
    expect(ev.event).toBe("conversion.completed");
    expect(ev.type).toBe("conversion.completed");
    expect(ev.data.conversion.id).toBe("c1");
    expect(ev.data.object.id).toBe("c1");
    expect(ev.createdAt).toBe("2026-08-26T10:40:00.000Z");
    expect(ev.created).toBe(Math.floor(Date.parse("2026-08-26T10:40:00.000Z") / 1000));
    expect(ev.request_id).toBeNull();
    expect(ev.id).toBeUndefined();
  });
  it("throws SignatureVerificationError on a bad signature and on an unknown event name", async () => {
    await expect(constructWebhookEvent(BODY, sig("other", T, BODY), SECRET, { now })).rejects.toBeInstanceOf(SignatureVerificationError);
    const odd = BODY.replace("conversion.completed", "conversion.exploded");
    await expect(constructWebhookEvent(odd, sig(SECRET, T, odd), SECRET, { now })).rejects.toBeInstanceOf(SignatureVerificationError);
  });
});
