# @esfera/sdk

**Server-side only** — this client carries your API key. Never ship it to a browser.

```ts
import { Esfera } from "@esfera/sdk";

const esfera = new Esfera({ apiKey: process.env.ESFERA_API_KEY! });

const job = await esfera.conversions.create({ file: "master.wav", preset: "esfera", profile: "advanced-2" });
const done = await job.wait({ onProgress: (c) => console.log(c.status, c.progress) });
await job.download("master.iamf");
console.log(done.outputProfile, done.outputLoudnessLufs);
```

- Zero runtime dependencies; Node 20+, Bun, Deno and Workers (path upload and download-to-file are Node-only).
- Every error is typed (`AuthenticationError`, `RateLimitError`, `SandboxLimitError`, `QuotaExceededError`, `InvalidRequestError`, …) and built from the API's RFC 9457 problem document. `err.requestId` is the `Request-Id` to quote to support.
- Every response object returned directly from an API call has a non-enumerable `requestId` too, and `esfera.lastRequestId` holds the last one.
- Retries a `rate-limited` 429 (honouring `Retry-After`, up to 60 s), 5xx and network errors for GET/PATCH/DELETE and keyed POSTs; `create()` always sends an `Idempotency-Key`. A 429 `sandbox-limit` is never retried: it throws `SandboxLimitError` with `limit` and `resetsAt`.
- Masters over 16 MiB upload as parallel parts, with part URLs re-signed as they near their hour. `esfera.conversions.multipart` exposes `init`, `sign`, `complete` and `abort` for your own uploader.
- `esfera.presets.get()` lists the IAMF profiles and presets the encoder accepts; `esfera.usage.get()` your team's usage and limits for the key's mode.
- Every list has `list()` for one page (`limit`, `startingAfter`) and `listAll()`, an async iterator over the cursor.
- `esfera.events` reads the last 30 days of events; `esfera.webhooks` registers, updates (`update`), rotates (`rotateSecret`) and revokes endpoints.
- Webhook receivers: `await Esfera.webhooks.constructEvent(rawBody, req.headers["x-esfera-signature"], secret)`. It accepts the two `v1=` signatures sent for 24 hours after a secret rotation.

Docs: https://developers.esfera.audio

## Profile helpers

`eligibleProfiles(presets, preset, { channels, objectCount })` lists every profile with whether (and why not) a master can use it under that preset; `predictProfile(presets, preset, file)` returns the profile `auto` would declare, or `null` when the data can't decide. Both read the `/v1/presets` response.
