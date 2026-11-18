/**
 * The public wire types of the `/v1` Converter API, as the SDK sees them.
 *
 * Owned here (never imported from the Esfera monorepo) and pinned to the
 * OpenAPI snapshot in `openapi/v1.json` by `test/contract.test.ts`: every
 * object type has a runtime `*_FIELDS` list beside it, the test compares each
 * list with the schema's property keys, and the `_Exhaustive*` assertions make
 * a type that gains a key without its list fail `tsc`.
 */

// ── Enumerations ─────────────────────────────────────────────────────────────

export const CONVERSION_STATUSES = ["uploading", "analyzing", "analyzed", "waiting", "queued", "running", "ready", "error"] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

export const PRESETS = ["esfera", "youtube", "bed714_3oa", "oa3"] as const;
export type Preset = (typeof PRESETS)[number];

export const PROFILE_IDS = ["simple", "base", "base-enhanced", "base-advanced", "advanced-1", "advanced-2"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
/** What a caller may pass as `profile`: a writable id, or "auto" (the preset decides). */
export type ProfileChoice = ProfileId | "auto";

/** Every event type, in lifecycle order. An endpoint registered without `events` receives all of them. */
export const EVENT_TYPES = [
  "conversion.created", "conversion.analyzed", "conversion.started", "conversion.completed",
  "conversion.failed", "conversion.expiring", "conversion.deleted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** The four types an endpoint registered before events existed keeps receiving. */
export const LEGACY_WEBHOOK_EVENT_TYPES: readonly EventType[] = ["conversion.analyzed", "conversion.completed", "conversion.failed", "conversion.expiring"];
/** Same list as `EVENT_TYPES`: webhooks deliver every event type. */
export const WEBHOOK_EVENT_TYPES = EVENT_TYPES;
export type WebhookEventType = EventType;

export type Plan = "free" | "creator" | "pro" | "sandbox";
/** The mode of the key that made a request: a Sandbox key (`esf_sk_test_…`) or a Live key. */
export type Mode = "sandbox" | "live";

// ── Conversions ──────────────────────────────────────────────────────────────

export type SourceNormalization = "sn3d" | "n3d" | "fuma";
export const SOURCE_NORMALIZATIONS: readonly SourceNormalization[] = ["sn3d", "n3d", "fuma"];

/**
 * The two presets that render into a 3OA scene. A 1OA/2OA ambisonic source
 * through them plays quieter than the master (OrbitCore #561), so the server
 * refuses the pair for order < 3 at start; clients apply the same rule before
 * a byte is uploaded. ADM (order null) is never affected.
 */
export const SCENE_PRESETS: readonly Preset[] = ["bed714_3oa", "oa3"];
export function presetAllowedForOrder(preset: string, order: number | null | undefined): boolean {
  return order == null || order >= 3 || !(SCENE_PRESETS as readonly string[]).includes(preset);
}

export interface Source {
  kind: "adm" | "ambisonic";
  order: 1 | 2 | 3 | null;
  normalization: SourceNormalization | null;
  /** The probe's doubt about a 4-channel file; absent for ADM. */
  note?: string | null;
}
export const SOURCE_FIELDS = ["kind", "order", "normalization", "note"] as const;

export interface OutputElement { kind: "bed" | "object" | "scene"; label: string; layout: string | null; channels: number }
export const OUTPUT_ELEMENT_FIELDS = ["kind", "label", "layout", "channels"] as const;
export interface MixPresentation { label: string; language: string | null; elements: number }
export const MIX_PRESENTATION_FIELDS = ["label", "language", "elements"] as const;
export interface Output { profile: ProfileId; channels: number; elementCount: number; foldedObjects: number; elements: OutputElement[]; mixPresentations: MixPresentation[] }
export const OUTPUT_FIELDS = ["profile", "channels", "elementCount", "foldedObjects", "elements", "mixPresentations"] as const;

export interface Conversion {
  /** Always `conversion`. */
  object: "conversion";
  id: string;
  /** The mode of the key that made it. */
  mode: Mode;
  /** The filename you gave at create. */
  name: string;
  status: ConversionStatus;
  stage: string | null;
  progress: number;
  sourceDurationSec: number | null;
  outputDurationSec: number | null;
  outputChannels: number | null;
  objectCount: number | null;
  outputLoudnessLufs: number | null;
  outputSizeBytes: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  programmeCount: number | null;
  preset: Preset | null;
  programme: number | null;
  expiresAt: string | null;
  /** The profile you asked for; "auto" when you left it to the preset. */
  profile: ProfileChoice;
  /** The profile the written file declares; null until `ready`. */
  outputProfile: ProfileId | null;
  source: Source;
  /** What the written file holds; null until `ready`. */
  output: Output | null;
}
export const CONVERSION_FIELDS = [
  "object", "mode", "id", "name", "status", "stage", "progress", "sourceDurationSec", "outputDurationSec", "outputChannels", "objectCount",
  "outputLoudnessLufs", "outputSizeBytes", "errorMessage", "createdAt", "updatedAt", "programmeCount", "preset", "programme",
  "expiresAt", "profile", "outputProfile", "source", "output",
] as const;

export type CreateConversionResult =
  | { id: string; uploadUrl: string; autoStart: boolean }
  | { id: string; duplicate: true };

export interface MultipartPartUrl { partNumber: number; url: string }
export interface MultipartInitResponse { uploadId: string; partUrls: MultipartPartUrl[] }
export interface MultipartPart { partNumber: number; etag: string }
export interface MultipartSignRequest { uploadId: string; partNumbers: number[] }
export const MULTIPART_SIGN_REQUEST_FIELDS = ["uploadId", "partNumbers"] as const;
export const MULTIPART_INIT_REQUEST_FIELDS = ["parts"] as const;
export const MULTIPART_INIT_FIELDS = ["uploadId", "partUrls"] as const;
export const MULTIPART_PART_URL_FIELDS = ["partNumber", "url"] as const;
export const MULTIPART_COMPLETE_REQUEST_FIELDS = ["uploadId", "parts"] as const;
export const MULTIPART_PART_FIELDS = ["partNumber", "etag"] as const;

/** What every list returns. Pass `next_cursor` as `startingAfter` for the next page while `has_more` is true. */
export interface List<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  /** The last item's id when `has_more`, else null. */
  next_cursor: string | null;
}
export const LIST_FIELDS = ["object", "data", "has_more", "next_cursor"] as const;

/** `GET /v1/conversions`. `items` repeats `data` (deprecated). `total`, `page` and `pageSize` come back only for a page-style read (`page`/`pageSize`, deprecated). */
export interface Page<T> extends List<T> {
  items: T[];
  total?: number;
  page?: number;
  pageSize?: number;
}
export const CONVERSION_PAGE_FIELDS = [...LIST_FIELDS, "items", "total", "page", "pageSize"] as const;

/**
 * Present, but not enumerable, on every response object returned directly
 * from an API call: the `Request-Id` of that response. Not on items yielded by
 * `listAll()` or on objects the SDK builds itself (a `ConversionJob`, a
 * `constructEvent()` result).
 */
export interface ResponseMeta {
  readonly requestId?: string;
}
export type WithRequestId<T> = T & ResponseMeta;

// ── Webhooks ─────────────────────────────────────────────────────────────────

export interface Webhook {
  /** Always `webhook_endpoint`. */
  object: "webhook_endpoint";
  /** The mode of the key that registered it. It receives events only for that mode. */
  mode: Mode;
  id: string;
  url: string;
  /** The event types this endpoint receives. */
  events: EventType[];
  /** Free text you set with `update()`; null when unset. */
  description: string | null;
  createdAt: string;
  revokedAt: string | null;
}
export const WEBHOOK_FIELDS = ["object", "mode", "id", "url", "events", "description", "createdAt", "revokedAt"] as const;

/** `webhooks.create()` input. */
export interface WebhookCreate {
  url: string;
  events?: EventType[];
  /** Free text, at most 200 characters; "" or left out means none. */
  description?: string;
}
export const WEBHOOK_CREATE_FIELDS = ["url", "events", "description"] as const;

export interface WebhookCreated {
  id: string;
  url: string;
  events: EventType[];
  /** Shown once. Verify `X-Esfera-Signature` with it. */
  secret: string;
}
export const WEBHOOK_CREATED_FIELDS = ["id", "url", "events", "secret"] as const;

/** `rotateSecret()`: the endpoint plus its new secret, shown once. */
export interface WebhookRotated extends Webhook {
  secret: string;
}

export interface WebhookUpdate {
  url?: string;
  events?: EventType[];
  /** At most 200 characters; null or "" clears it. */
  description?: string | null;
}
export const WEBHOOK_UPDATE_FIELDS = ["url", "events", "description"] as const;

/** `GET /v1/webhooks`. `webhooks` repeats `data` (deprecated). */
export interface WebhookList extends List<Webhook> {
  webhooks: Webhook[];
}
export const WEBHOOK_LIST_FIELDS = [...LIST_FIELDS, "webhooks"] as const;

export interface WebhookDelivery {
  /** Always `webhook_delivery`. */
  object: "webhook_delivery";
  /** The endpoint's mode. */
  mode: Mode;
  id: string;
  conversionId: string | null;
  event: WebhookEventType;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  /**
   * Up to 4 KB of what your endpoint last answered, as text. A binary body
   * reads "[binary N bytes]"; a body that was cut ends with "[truncated]".
   * Null before the first attempt.
   */
  lastResponseBody: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
export const WEBHOOK_DELIVERY_FIELDS = ["object", "mode", "id", "conversionId", "event", "status", "attempts", "lastStatus", "lastError", "lastResponseBody", "createdAt", "deliveredAt"] as const;

/** `GET /v1/webhooks/{id}/deliveries`. `deliveries` repeats `data` (deprecated); `total`, `page`, `pageSize` only for a page-style read. */
export interface WebhookDeliveryPage extends List<WebhookDelivery> {
  deliveries: WebhookDelivery[];
  total?: number;
  page?: number;
  pageSize?: number;
}
export const WEBHOOK_DELIVERY_PAGE_FIELDS = [...LIST_FIELDS, "deliveries", "total", "page", "pageSize"] as const;

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * Something that happened to a conversion. `GET /v1/events` returns these, and
 * a webhook delivers exactly this document. `event`, `createdAt` and
 * `data.conversion` repeat `type`, `created` and `data.object` (deprecated).
 */
export interface Event {
  /** `evt_…`. Dedupe webhook deliveries on it. */
  id: string;
  object: "event";
  type: EventType;
  mode: Mode;
  /** Unix seconds. */
  created: number;
  /** The `Request-Id` of the API request that caused it; null when nothing you sent did. */
  request_id: string | null;
  data: { object: Conversion; conversion: Conversion };
  /** Deprecated: the same as `type`. */
  event: EventType;
  /** Deprecated: `created` as ISO 8601. */
  createdAt: string;
}
export const EVENT_FIELDS = ["id", "object", "type", "mode", "created", "request_id", "data", "event", "createdAt"] as const;

/** The same type as `Event`, under a name that does not shadow the DOM's `Event`. */
export type EsferaEvent = Event;

/**
 * A webhook body, as `constructEvent()` returns it: an `Event`, except that
 * `id` can be missing. A replay of a delivery made before events existed
 * re-sends the body stored then, which had no `id`. Deduplicate on `id` when
 * it is there, otherwise on (`event`, `data.conversion.id`, `createdAt`).
 */
export type WebhookEvent = Omit<Event, "id"> & { id?: string };

export type EventList = List<Event>;

// ── Usage, profiles, presets ─────────────────────────────────────────────────

export interface Usage {
  plan: Plan;
  /** The mode of the key that asked. */
  mode: Mode;
  team: { id: string; name: string };
  /** Sandbox only; null in Live. Where the team stands against the Sandbox allowance today (UTC). */
  sandbox: {
    limits: { maxSourceMinutes: number; conversionsPerDay: number; concurrent: number; outputRetentionHours: number };
    conversionsToday: number;
    inFlight: number;
    resetsAt: string;
  } | null;
  period: { resetsMonthly: boolean; resetsAt: string | null };
  minutes: { used: number; included: number; remaining: number; planRemaining: number; credit: number };
  limits: {
    perFileMinutes: number;
    /** Largest source accepted, in bytes — what actually bounds a long multichannel master. */
    perFileBytes: number;
    concurrent: number; inFlight: number; rateLimitPerMinute: number; retentionHours: number;
  };
}
export const USAGE_FIELDS = ["plan", "mode", "team", "sandbox", "period", "minutes", "limits"] as const;

export interface Profile {
  id: ProfileId;
  code: 0 | 1 | 2 | 3 | 4 | 5;
  family: "eclipsa" | "iamf-2";
  label: string;
  maxElements: number;
  maxChannels: number;
  objects: boolean;
  /** Whether this encoder will declare it. Base-Advanced is read but not written. */
  writable: boolean;
}
export const PROFILE_FIELDS = ["id", "code", "family", "label", "maxElements", "maxChannels", "objects", "writable"] as const;

export interface PresetInfo {
  id: Preset;
  label: string;
  /** What the preset declares under auto; several means the encoder picks by content. */
  declares: ProfileId[];
  objects: "keep" | "fold" | "scene";
  inputs: ("adm" | "ambisonic")[];
  description: string;
}
export const PRESET_FIELDS = ["id", "label", "declares", "objects", "inputs", "description"] as const;

export interface PresetsResponse {
  engine: { orbitcore: string };
  profiles: Profile[];
  presets: PresetInfo[];
}

// ── Problems, files ──────────────────────────────────────────────────────────

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
}
export const PROBLEM_FIELDS = ["type", "title", "status", "detail"] as const;

export interface BwfInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSec: number;
  /** True when the file carries ADM metadata in an `axml` chunk. */
  isAdm: boolean;
  /** Programmes the ADM declares. Zero is normal for a bed-only master. */
  programmeCount: number;
  /** Objects-typed channel formats the ADM declares; 0 for bed-only or non-ADM. */
  objectCount: number;
  /** Ambisonic order (1, 2 or 3) when the file has no ADM and 4, 9 or 16 channels; otherwise null. */
  ambisonicOrder: 1 | 2 | 3 | null;
}

// ── Compile-time exhaustiveness: a type that gains a key without its list fails here.
type Exhaustive<T, L extends readonly (keyof T)[]> = Exclude<keyof T, L[number]> extends never ? true : never;
const _conversion: Exhaustive<Conversion, typeof CONVERSION_FIELDS> = true;
const _source: Exhaustive<Source, typeof SOURCE_FIELDS> = true;
const _output: Exhaustive<Output, typeof OUTPUT_FIELDS> = true;
const _outputElement: Exhaustive<OutputElement, typeof OUTPUT_ELEMENT_FIELDS> = true;
const _mix: Exhaustive<MixPresentation, typeof MIX_PRESENTATION_FIELDS> = true;
const _webhook: Exhaustive<Webhook, typeof WEBHOOK_FIELDS> = true;
const _webhookCreated: Exhaustive<WebhookCreated, typeof WEBHOOK_CREATED_FIELDS> = true;
const _webhookUpdate: Exhaustive<WebhookUpdate, typeof WEBHOOK_UPDATE_FIELDS> = true;
const _webhookList: Exhaustive<WebhookList, typeof WEBHOOK_LIST_FIELDS> = true;
const _deliveryPage: Exhaustive<WebhookDeliveryPage, typeof WEBHOOK_DELIVERY_PAGE_FIELDS> = true;
const _conversionPage: Exhaustive<Page<Conversion>, typeof CONVERSION_PAGE_FIELDS> = true;
const _event: Exhaustive<Event, typeof EVENT_FIELDS> = true;
const _delivery: Exhaustive<WebhookDelivery, typeof WEBHOOK_DELIVERY_FIELDS> = true;
const _usage: Exhaustive<Usage, typeof USAGE_FIELDS> = true;
const _profile: Exhaustive<Profile, typeof PROFILE_FIELDS> = true;
const _preset: Exhaustive<PresetInfo, typeof PRESET_FIELDS> = true;
const _problem: Exhaustive<Problem, typeof PROBLEM_FIELDS> = true;
const _mpInit: Exhaustive<MultipartInitResponse, typeof MULTIPART_INIT_FIELDS> = true;
const _mpUrl: Exhaustive<MultipartPartUrl, typeof MULTIPART_PART_URL_FIELDS> = true;
const _mpPart: Exhaustive<MultipartPart, typeof MULTIPART_PART_FIELDS> = true;
const _mpSign: Exhaustive<MultipartSignRequest, typeof MULTIPART_SIGN_REQUEST_FIELDS> = true;
void [_webhookCreated, _webhookUpdate, _webhookList, _deliveryPage, _conversionPage, _event, _mpInit, _mpUrl, _mpPart, _mpSign, _conversion, _source, _output, _outputElement, _mix, _webhook, _delivery, _usage, _profile, _preset, _problem];
