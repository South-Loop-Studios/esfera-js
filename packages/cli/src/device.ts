import { errorFromResponse } from "@esfera/sdk";
import { CLI_VERSION } from "./version.js";

export interface DeviceStart { deviceCode: string; userCode: string; verificationUrl: string; intervalSec: number; expiresInSec: number }
export type DeviceResult = { ok: true; apiKey: string; keyId: string; apiUrl: string } | { ok: false; reason: "expired" | "denied" };
export interface DeviceDeps {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Aborting it ends sign-in at once: the in-flight request and the wait between polls both stop. */
  signal?: AbortSignal;
}

const aborted = () => new DOMException("sign-in cancelled", "AbortError");

/** `sleep` that loses the race to `signal`. */
function sleepUnless(ms: number, deps: DeviceDeps): Promise<void> {
  const signal = deps.signal;
  if (!signal) return deps.sleep(ms);
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    deps.sleep(ms).then(() => { signal.removeEventListener("abort", onAbort); resolve(); }, reject);
  });
}

const base = (apiUrl: string) => apiUrl.replace(/\/+$/, "");
const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  "User-Agent": `esfera-cli/${CLI_VERSION}`,
  Accept: "application/json",
  ...extra,
});

async function fail(res: Response): Promise<never> {
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  throw errorFromResponse(res.status, body, res.headers);
}

/** POST /api/cli/device. "unsupported" on 404; any other non-2xx throws. */
export async function startDeviceFlow(apiUrl: string, hostname: string, deps: DeviceDeps): Promise<DeviceStart | "unsupported"> {
  const res = await deps.fetch(`${base(apiUrl)}/api/cli/device`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ hostname }),
    signal: deps.signal,
  });
  if (res.status === 404) return "unsupported";
  if (!res.ok) return fail(res);
  return (await res.json()) as DeviceStart;
}

/** Polls /api/cli/device/token until 200/410/403 or expiresInSec has elapsed. */
/** Consecutive 5xx answers or network failures tolerated while a person is still approving. */
const POLL_TRANSIENT_LIMIT = 5;

export async function pollDeviceToken(apiUrl: string, start: DeviceStart, deps: DeviceDeps): Promise<DeviceResult> {
  const deadline = deps.now() + start.expiresInSec * 1000;
  let wait = start.intervalSec * 1000;
  let transient = 0;
  for (;;) {
    if (deps.signal?.aborted) throw aborted();
    if (deps.now() >= deadline) return { ok: false, reason: "expired" };
    let res: Response;
    try {
      res = await deps.fetch(`${base(apiUrl)}/api/cli/device/token`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ deviceCode: start.deviceCode }),
        signal: deps.signal,
      });
    } catch (err) {
      // A dropped connection mid-poll is not a verdict: the code is still pending server-side.
      if (deps.signal?.aborted || ++transient > POLL_TRANSIENT_LIMIT) throw err;
      wait = start.intervalSec * 1000;
      if (deps.now() + wait >= deadline) return { ok: false, reason: "expired" };
      await sleepUnless(wait, deps);
      continue;
    }
    if (res.status === 200) {
      const b = (await res.json()) as { apiKey: string; keyId: string; apiUrl: string };
      return { ok: true, apiKey: b.apiKey, keyId: b.keyId, apiUrl: b.apiUrl };
    }
    if (res.status === 410) return { ok: false, reason: "expired" };
    if (res.status === 403) return { ok: false, reason: "denied" };
    if (res.status === 428) { transient = 0; wait = start.intervalSec * 1000; }
    else if (res.status === 429) {
      transient = 0;
      const ra = Number(res.headers.get("Retry-After"));
      wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : start.intervalSec * 1000;
    } else if (res.status >= 500 && ++transient <= POLL_TRANSIENT_LIMIT) {
      // The Worker hiccuped; the server never said no. Poll again at the normal interval.
      wait = start.intervalSec * 1000;
    } else return fail(res);
    if (deps.now() + wait >= deadline) return { ok: false, reason: "expired" };
    await sleepUnless(wait, deps);
  }
}

/** DELETE /api/cli/keys/self with Bearer apiKey. */
export async function revokeSelf(apiUrl: string, apiKey: string, deps: Pick<DeviceDeps, "fetch">): Promise<"revoked" | "kept" | "unsupported"> {
  const res = await deps.fetch(`${base(apiUrl)}/api/cli/keys/self`, {
    method: "DELETE",
    headers: headers({ Authorization: `Bearer ${apiKey}` }),
  });
  if (res.status === 204) return "revoked";
  if (res.status === 409) return "kept";
  if (res.status === 404) return "unsupported";
  return fail(res);
}
