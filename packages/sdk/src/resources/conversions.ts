/**
 * `esfera.conversions` — create a job, upload the master, follow it to `ready`,
 * download the IAMF.
 *
 * Two deliberate absences: the SDK never calls `start()` for a job created with
 * a `preset` (auto-start is the server's job; doing it here would hang every
 * other integration at `analyzed`), and `wait()` treats `queued` as healthy
 * however long it lasts (a capacity wait is designed behaviour, not a stall).
 */
import type { HttpClient } from "../http.js";
import { ConversionFailedError, ConversionStalledError, InvalidRequestError, ConflictError } from "../errors.js";
import { putToPresignedUrl, uploadMultipart, multipartApi, type MultipartApi, resolveSource, isStreamSource, type FileSource, type UploadProgress, type ResolvedSource } from "../upload.js";
import type { Conversion, ConversionStatus, CreateConversionResult, Page, Preset, ProfileChoice, SourceNormalization, WithRequestId } from "../types.js";
import { autoPage, LIST_ALL_LIMIT, type CursorOptions } from "../pagination.js";
import { shouldUseMultipart } from "../multipartPlan.js";
import { inspectResolvedSource } from "./files.js";

export interface CreateConversionOptions {
  file: FileSource;
  /** Supply to auto-start once the upload lands; omit for the two-step flow. */
  preset?: Preset;
  /** IAMF profile to declare; "auto" (default) lets the preset decide. */
  profile?: ProfileChoice;
  /** 0-based programme when the ADM declares several. */
  programme?: number;
  /** Ambisonic sources: the channel normalization. Sent verbatim; the server refuses it for ADM. */
  source?: { normalization: SourceNormalization };
  /** Overrides the name taken from the path / Blob. */
  filename?: string;
  /** Required for a raw stream source; inspected from a path / Blob when omitted. */
  durationSec?: number;
  idempotencyKey?: string;
  onUploadProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface StartOptions {
  preset?: Preset;
  programme?: number;
  profile?: ProfileChoice;
  /** Ambisonic sources: the channel normalization. Sent verbatim. */
  source?: { normalization: SourceNormalization };
}

export interface WaitOptions {
  until?: "ready" | "analyzed";
  pollIntervalMs?: number;
  /**
   * No sign of life for this long → ConversionStalledError. Life is a change to status, progress
   * or `updatedAt`: the converter heartbeats `updatedAt` through the passes that write no progress
   * (the loudness and pre-render passes of a long master). `queued` and `waiting` are exempt.
   */
  stallMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (c: Conversion) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface ListOptions extends CursorOptions {
  status?: ConversionStatus;
  /** Deprecated: use `startingAfter`. Cannot be combined with the cursor options. */
  page?: number;
  /** Deprecated: use `limit`. */
  pageSize?: number;
}

/** Hook for Task 5: inspect a re-readable source for duration and channel facts. */
export type SourceInspector = (source: ResolvedSource) => Promise<{ durationSec: number; programmeCount: number } | null>;

const TERMINAL: ReadonlySet<ConversionStatus> = new Set(["ready", "error"]);

export class ConversionsResource {
  readonly #http: HttpClient;
  /**
   * The four multipart calls, for your own uploader. `create()` already runs
   * them (and re-signs part URLs as they near their hour) for any master over 16 MiB.
   */
  readonly multipart: MultipartApi;
  readonly #sleep: (ms: number) => Promise<void>;
  #inspect: SourceInspector;

  constructor(http: HttpClient, deps: { sleep?: (ms: number) => Promise<void>; inspect?: SourceInspector } = {}) {
    this.#http = http;
    this.multipart = multipartApi(http);
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Default: the BWF header walk (files.ts), so a path or Blob needs no durationSec.
    this.#inspect = deps.inspect ?? inspectResolvedSource;
  }

  /** @internal Task 5 wires the BWF inspector in. */
  setInspector(inspect: SourceInspector): void {
    this.#inspect = inspect;
  }

  async create(opts: CreateConversionOptions): Promise<ConversionJob> {
    const source = await resolveSource(opts.file, opts.filename);
    let durationSec = opts.durationSec;
    if (durationSec === undefined) {
      if (isStreamSource(opts.file)) {
        throw new InvalidRequestError({
          status: 400, type: "https://esfera.audio/errors/invalid-request", title: "Invalid request",
          detail: isStreamSource(opts.file)
            ? "durationSec is required for a stream source (no random access to read the header)"
            : "durationSec is required",
        });
      }
      const info = await this.#inspect(source);
      if (!info) {
        throw new InvalidRequestError({
          status: 400, type: "https://esfera.audio/errors/invalid-request", title: "Invalid request",
          detail: `${source.name} is not a WAV/RF64 file`,
        });
      }
      durationSec = info.durationSec;
    }

    // The size lets the server refuse a master over its per-file byte cap before any upload.
    const body: Record<string, unknown> = { filename: source.name, durationSec, ...(source.size > 0 ? { sizeBytes: source.size } : {}) };
    if (opts.preset !== undefined) body.preset = opts.preset;
    if (opts.programme !== undefined) body.programme = opts.programme;
    if (opts.profile !== undefined) body.profile = opts.profile;
    if (opts.source !== undefined) body.source = opts.source;

    const result = await this.#http.request<CreateConversionResult>("POST", "/v1/conversions", {
      body,
      idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
      signal: opts.signal,
    });

    const job = new ConversionJob(this, result.id);
    if ("duplicate" in result) {
      // Idempotent replay: the first call carried the upload URL; nothing to send.
      job.uploaded = false;
      return job;
    }
    // Storage caps a single PUT at 5 GiB, so anything over 16 MiB with random
    // access goes as parallel parts. A StreamSource has no random access and
    // stays on the single PUT: a stream over 5 GiB fails with storage's EntityTooLarge.
    if (source.read && shouldUseMultipart(source.size)) {
      await uploadMultipart(this.#http, result.id, source, { onProgress: opts.onUploadProgress, signal: opts.signal });
    } else {
      await putToPresignedUrl(this.#fetch, result.uploadUrl, source, { onProgress: opts.onUploadProgress, signal: opts.signal });
    }
    job.uploaded = true;
    // The server has no "upload landed" trigger: nothing moves a row off
    // `uploading` until /analyze is called. Analysis is not start — when a preset
    // was given the server starts the encode itself once analysis completes.
    try {
      await this.analyze(result.id);
    } catch (err) {
      if (!(err instanceof ConflictError && err.slug === "already-started")) throw err;
    }
    return job;
  }

  get #fetch(): typeof globalThis.fetch {
    // The PUT goes to storage, not the API: no bearer header, no retries beyond upload.ts's own.
    return this.#http.rawFetch;
  }

  get(id: string): Promise<WithRequestId<Conversion>> {
    return this.#http.request<Conversion>("GET", `/v1/conversions/${encodeURIComponent(id)}`);
  }

  /** One page, newest first. With `limit`/`startingAfter` it is a cursor page; with `page`/`pageSize` (deprecated) a counted one. */
  list(opts: ListOptions = {}): Promise<WithRequestId<Page<Conversion>>> {
    return this.#http.request<Page<Conversion>>("GET", "/v1/conversions", {
      query: { status: opts.status, starting_after: opts.startingAfter, limit: opts.limit, page: opts.page, pageSize: opts.pageSize },
    });
  }

  /** Every conversion (optionally of one status), page after page with `starting_after`. */
  listAll(opts: Omit<ListOptions, "page" | "pageSize"> = {}): AsyncGenerator<Conversion, void, undefined> {
    const { startingAfter, ...rest } = opts;
    const limit = rest.limit ?? LIST_ALL_LIMIT;
    return autoPage((after) => this.list({ ...rest, limit, startingAfter: after }), startingAfter);
  }

  /** Older name for `listAll()`. `pageSize` is taken as `limit`. */
  iterate(opts: Omit<ListOptions, "page"> = {}): AsyncIterable<Conversion> {
    const { pageSize, ...rest } = opts;
    return this.listAll({ ...rest, limit: rest.limit ?? pageSize });
  }

  analyze(id: string): Promise<void> {
    return this.#http.request<void>("POST", `/v1/conversions/${encodeURIComponent(id)}/analyze`);
  }

  start(id: string, opts: StartOptions = {}): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.preset !== undefined) body.preset = opts.preset;
    if (opts.programme !== undefined) body.programme = opts.programme;
    if (opts.profile !== undefined) body.profile = opts.profile;
    if (opts.source !== undefined) body.source = opts.source;
    return this.#http.request<void>("POST", `/v1/conversions/${encodeURIComponent(id)}/start`, { body });
  }

  async wait(id: string, opts: WaitOptions = {}): Promise<Conversion> {
    const until = opts.until ?? "ready";
    const poll = opts.pollIntervalMs ?? 3000;
    const stallMs = opts.stallMs ?? 300_000;
    const now = opts.now ?? Date.now;
    const started = now();
    let last: { status: ConversionStatus; progress: number; updatedAt: string } | null = null;
    let lastChange = started;
    let c = await this.get(id);
    for (;;) {
      opts.onProgress?.(c);
      if (c.status === "error") throw new ConversionFailedError(c);
      if (c.status === "ready" || (until === "analyzed" && c.status !== "uploading" && c.status !== "analyzing")) return c;

      const t = now();
      // `queued` (capacity) and `waiting` (the owner's own queue) are designed waits, not stalls.
      // A moving `updatedAt` is the converter's heartbeat: alive, even at the same progress.
      const alive = !last || last.status !== c.status || last.progress !== c.progress || last.updatedAt !== c.updatedAt;
      if (c.status === "queued" || c.status === "waiting" || alive) {
        lastChange = t;
      } else if (t - lastChange >= stallMs) {
        throw new ConversionStalledError(c, t - lastChange);
      }
      last = { status: c.status, progress: c.progress, updatedAt: c.updatedAt };
      if (opts.timeoutMs !== undefined && t - started >= opts.timeoutMs) {
        throw new Error(`wait(${id}) timed out after ${opts.timeoutMs} ms at '${c.status}'`);
      }
      if (opts.signal?.aborted) throw new DOMException("wait aborted", "AbortError");
      await this.#sleep(poll);
      c = await this.get(id);
    }
  }

  async download(id: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.#http.requestRaw("GET", `/v1/conversions/${encodeURIComponent(id)}/output`, { headers: { Accept: "audio/iamf, */*" }, noTimeout: true });
    if (!res.body) throw new Error("empty download body");
    return res.body as ReadableStream<Uint8Array>;
  }

  delete(id: string): Promise<void> {
    return this.#http.request<void>("DELETE", `/v1/conversions/${encodeURIComponent(id)}`);
  }

  job(id: string): ConversionJob {
    return new ConversionJob(this, id);
  }
}

/** A handle on one conversion: the latest snapshot plus the verbs that act on it. */
export class ConversionJob {
  readonly id: string;
  /** Latest snapshot; populated by `refresh()`/`wait()`, null until then. */
  conversion: Conversion | null = null;
  /** False when `create()` resolved an idempotent duplicate (no upload happened). */
  uploaded = false;
  readonly #r: ConversionsResource;

  constructor(resource: ConversionsResource, id: string) {
    this.#r = resource;
    this.id = id;
  }

  async refresh(): Promise<Conversion> {
    this.conversion = await this.#r.get(this.id);
    return this.conversion;
  }

  analyze(): Promise<void> {
    return this.#r.analyze(this.id);
  }

  start(opts: StartOptions = {}): Promise<void> {
    return this.#r.start(this.id, opts);
  }

  async wait(opts: WaitOptions = {}): Promise<Conversion> {
    this.conversion = await this.#r.wait(this.id, {
      ...opts,
      onProgress: (c) => { this.conversion = c; opts.onProgress?.(c); },
    });
    return this.conversion;
  }

  download(): Promise<ReadableStream<Uint8Array>>;
  download(path: string): Promise<{ path: string; bytes: number }>;
  async download(path?: string): Promise<ReadableStream<Uint8Array> | { path: string; bytes: number }> {
    const stream = await this.#r.download(this.id);
    if (path === undefined) return stream;
    const fs = await import("node:fs");
    const { Writable } = await import("node:stream");
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { bytes += chunk.byteLength; ctl.enqueue(chunk); } });
    await stream.pipeThrough(counter).pipeTo(Writable.toWeb(fs.createWriteStream(path)) as WritableStream<Uint8Array>);
    return { path, bytes };
  }

  async downloadToBuffer(): Promise<Uint8Array> {
    const stream = await this.#r.download(this.id);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async delete(): Promise<void> {
    return this.#r.delete(this.id);
  }
}

export { TERMINAL as TERMINAL_STATUSES };
