# @esfera/sdk

## 0.3.1 — 2026-11-18

Released from the public [esfera-js](https://github.com/South-Loop-Studios/esfera-js) repo through npm trusted publishing. No API changes. Published with npm provenance (0.3.0 shipped without it).

## 0.3.0 — 2026-11-18

Licensed Apache-2.0 (LICENSE and NOTICE ship in the package). Includes everything listed under 0.2.0 and 0.1.0 below, which were never published.

- `webhooks.create()` takes an optional `description` (at most 200 characters), the same text `update()` can change later. Type `WebhookCreate`.

## 0.2.0 — never published

- `esfera.events`: `list`, `listAll`, `get` (alias `retrieve`). Types `Event` (also `EsferaEvent`), `EventType`, `EVENT_TYPES`; webhooks now know all seven event types.
- `esfera.webhooks.update(id, { url, events, description })` (PATCH, retried like GET) and `rotateSecret(id, { expireOldNow })` (never retried). `create()` takes `events`.
- Breaking: `webhooks.list()` returns the list envelope `{ object, data, has_more, next_cursor }` (plus the deprecated `webhooks` array), not a bare array.
- Widened: `WEBHOOK_EVENT_TYPES` (and `WebhookEventType`) grew from 4 to 7 types, the same list as `EVENT_TYPES`. A `switch` that was exhaustive over the four needs the three new cases. `LEGACY_WEBHOOK_EVENT_TYPES` keeps the old four.
- `WebhookEvent` (what `constructEvent` returns) has an optional `id`: a replayed pre-events body has none. Deduplicate on `id` when present, else on (`event`, `data.conversion.id`, `createdAt`).
- `WebhookDelivery.lastResponseBody`: up to 4 KB of the endpoint's last answer as text.
- Cursor paging: every `list()` takes `limit` and `startingAfter`; every list has `listAll()`, an async iterator over `starting_after` (100 to a page unless `limit` is given) that stops when `has_more` is false or a cursor repeats. `conversions.iterate()` is now an alias. `page`/`pageSize` still work where the API takes them. `autoPage` is exported.
- `requestId` on successful responses: every response object returned directly from an API call has it as a non-enumerable property (not items yielded by `listAll()`, nor objects the SDK builds). `esfera.lastRequestId` holds the last response's id.
- The webhook verifier accepts a header with several `v1=` parts (a secret rotation's 24-hour overlap) when any part matches. `constructEvent` returns the full event document, and fills `type`, `created` and `data.object` for a replayed pre-events body.
- `requestId` on errors is the API's `Request-Id` header (`cf-ray` only when it is missing).
- A 429 `sandbox-limit` throws `SandboxLimitError` (`limit`, `resetsAt`) and is never retried. Only `rate-limited` 429s retry, and a `Retry-After` wait is capped at 60 s.
- `esfera.conversions.multipart.{init, sign, complete, abort}` are public. The large-master upload re-signs part URLs before they expire (up to 100 parts per call, repeated as later parts come due), and once for a part refused with 403. A re-sign that fails with 5xx or a network error is retried like a part; if it keeps failing the upload is aborted with an `UploadError` that names the re-sign.
- Every request sends `X-Esfera-Client: esfera-sdk/<version>` (override with `clientName`).
- `BwfInfo.objectCount`: Objects-typed channel formats counted from the axml.
- `eligibleProfiles` and `predictProfile`, derived from `/v1/presets`.

## 0.1.0 — never published

First release: conversions (create/upload/wait/download), webhooks + signature verification, usage, presets, files.inspect. Types pinned to the `/v1` OpenAPI snapshot.
