/**
 * Webhook signature verification — the mirror of the server's signing
 * (Esfera `lib/apiWebhooks.ts`): header `t=<unix seconds>,v1=<hex>[,v1=<hex>]`
 * where each hex is HMAC-SHA256 over `"<t>.<raw body>"`. For 24 hours after a
 * secret rotation the header carries two `v1=` parts, one per secret; a
 * delivery verifies when ANY part matches the secret you hold. Constant-time
 * comparison; 300 s tolerance by default; fails closed on anything malformed.
 * Uses `crypto.subtle` so it runs anywhere the SDK runs.
 */
import { SignatureVerificationError } from "./errors.js";
import { EVENT_TYPES, type Conversion, type WebhookEvent } from "./types.js";

export interface VerifyOptions {
  /** Seconds the timestamp may differ from now. Default 300. */
  toleranceSec?: number;
  /** Injectable clock (ms), for tests. */
  now?: number;
}

const WEBHOOK_EVENTS: ReadonlySet<string> = new Set(EVENT_TYPES);
const enc = new TextEncoder();

/** `t` and every well-formed `v1` part; null when either is missing. */
function parseHeader(header: string): { t: number; v1: string[] } | null {
  if (typeof header !== "string" || !header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return t !== null && v1.length > 0 ? { t, v1 } : null;
}

async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, message as BufferSource));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? enc.encode(body) : body;
}

/** True when any `v1=` part of the header signs this exact body with this secret, and `t` is fresh. Never throws. */
export async function verifyWebhookSignature(rawBody: string | Uint8Array, signatureHeader: string, secret: string, opts: VerifyOptions = {}): Promise<boolean> {
  try {
    if (!secret) return false;
    const parsed = parseHeader(signatureHeader);
    if (!parsed) return false;
    const tolerance = opts.toleranceSec ?? 300;
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    if (Math.abs(nowSec - parsed.t) > tolerance) return false;
    const body = toBytes(rawBody);
    const prefix = enc.encode(`${parsed.t}.`);
    const message = new Uint8Array(prefix.length + body.length);
    message.set(prefix, 0);
    message.set(body, prefix.length);
    const expected = await hmacHex(secret, message);
    // Compare every part (no early exit), so timing says nothing about which matched.
    let ok = false;
    for (const candidate of parsed.v1) if (constantTimeEqual(expected, candidate)) ok = true;
    return ok;
  } catch {
    return false;
  }
}

/**
 * Verify, then parse the event. Throws `SignatureVerificationError`.
 *
 * Every delivery carries the full event document (`id`, `type`, `created`,
 * `data.object`, and the older `event`, `createdAt`, `data.conversion`). A
 * replay of a delivery made before events existed re-sends the body stored at
 * the time, which has only the older fields; those are filled in from each
 * other here, and `id` stays absent: deduplicate such a body on (`event`,
 * `data.conversion.id`, `createdAt`) instead.
 */
export async function constructWebhookEvent(rawBody: string | Uint8Array, signatureHeader: string, secret: string, opts: VerifyOptions = {}): Promise<WebhookEvent> {
  if (!(await verifyWebhookSignature(rawBody, signatureHeader, secret, opts))) {
    throw new SignatureVerificationError("webhook signature did not verify (wrong secret, altered body, or stale timestamp)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody));
  } catch {
    throw new SignatureVerificationError("webhook body is not JSON");
  }
  const ev = (parsed && typeof parsed === "object" ? parsed : {}) as Partial<WebhookEvent> & { data?: { object?: Conversion; conversion?: Conversion } };
  const type = typeof ev.type === "string" ? ev.type : ev.event;
  const conversion = ev.data?.object ?? ev.data?.conversion;
  if (typeof type !== "string" || !WEBHOOK_EVENTS.has(type) || !conversion || typeof conversion !== "object") {
    throw new SignatureVerificationError(`webhook body is not a known Esfera event (${String(type)})`);
  }
  const created = typeof ev.created === "number" ? ev.created
    : typeof ev.createdAt === "string" && !Number.isNaN(Date.parse(ev.createdAt)) ? Math.floor(Date.parse(ev.createdAt) / 1000) : 0;
  return {
    ...ev,
    object: "event",
    type: type as WebhookEvent["type"],
    event: type as WebhookEvent["type"],
    created,
    createdAt: typeof ev.createdAt === "string" ? ev.createdAt : new Date(created * 1000).toISOString(),
    request_id: ev.request_id ?? null,
    mode: ev.mode ?? conversion.mode,
    data: { object: conversion, conversion },
  } as WebhookEvent;
}
