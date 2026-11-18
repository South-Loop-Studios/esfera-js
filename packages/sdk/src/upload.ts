/**
 * The presigned PUT to storage. The bytes go straight to R2 — the API Worker
 * is never in the data path (its 100 MB body limit would make a master
 * impossible), which is also why nothing here carries the API key.
 *
 * Content-Length is explicit and not optional: given a stream, fetch would fall
 * back to chunked transfer encoding, and S3-style endpoints refuse that.
 * `duplex: "half"` is what the fetch spec requires for a streaming body.
 */
import { UploadError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { planMultipart } from "./multipartPlan.js";
import type { MultipartInitResponse, MultipartPart, MultipartSignRequest } from "./types.js";

export interface StreamSource {
  stream: ReadableStream<Uint8Array>;
  size: number;
  name: string;
}

export type FileSource = string | Blob | StreamSource;

export interface UploadProgress {
  sent: number;
  total: number;
}

export interface ResolvedSource {
  name: string;
  size: number;
  /** Re-readable sources (a path, a Blob) can be retried; a raw stream cannot. */
  rereadable: boolean;
  open: () => Promise<ReadableStream<Uint8Array>>;
  /** Random access for header inspection; absent for a raw stream. */
  read?: (offset: number, length: number) => Promise<Uint8Array>;
}

export function isStreamSource(f: FileSource): f is StreamSource {
  // A Blob also has a `stream` member — a method. A StreamSource carries the stream itself.
  if (typeof f !== "object" || f === null || f instanceof Blob) return false;
  return "stream" in f && typeof (f as StreamSource).stream === "object";
}

/** Normalise the three accepted source kinds. A path string is Node-only. */
export async function resolveSource(file: FileSource, filename?: string): Promise<ResolvedSource> {
  if (typeof file === "string") {
    const fs = await import("node:fs");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");
    const size = (await fsp.stat(file)).size;
    return {
      name: filename ?? path.basename(file),
      size,
      rereadable: true,
      open: async () => {
        const { Readable } = await import("node:stream");
        return Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
      },
      read: async (offset, length) => {
        const fh = await fsp.open(file, "r");
        try {
          const buf = new Uint8Array(length);
          const { bytesRead } = await fh.read(buf, 0, length, offset);
          return buf.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
      },
    };
  }
  if (isStreamSource(file)) {
    let opened = false;
    return {
      name: filename ?? file.name,
      size: file.size,
      rereadable: false,
      open: async () => {
        if (opened) throw new UploadError(0, "a stream source can only be read once");
        opened = true;
        return file.stream;
      },
    };
  }
  const blobName = filename ?? ((file as File).name || "master.wav");
  return {
    name: blobName,
    size: file.size,
    rereadable: true,
    open: async () => file.stream(),
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

/** Count bytes as they pass, for progress reporting. fetch exposes none. */
function counting(stream: ReadableStream<Uint8Array>, total: number, onProgress?: (p: UploadProgress) => void): ReadableStream<Uint8Array> {
  if (!onProgress) return stream;
  let sent = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        onProgress({ sent, total });
      },
    }),
  );
}

export interface PutOptions {
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  contentType?: string;
}

/**
 * PUT the source to the presigned URL. Retries once on a network error for a
 * re-readable source; never for a stream (its bytes are gone).
 */
export async function putToPresignedUrl(fetchImpl: typeof globalThis.fetch, url: string, source: ResolvedSource, opts: PutOptions = {}): Promise<void> {
  const attempts = source.rereadable ? 2 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const body = counting(await source.open(), source.size, opts.onProgress);
      const res = await fetchImpl(url, {
        method: "PUT",
        body,
        duplex: "half",
        signal: opts.signal,
        headers: { "Content-Type": opts.contentType ?? "audio/wav", "Content-Length": String(source.size) },
      } as RequestInit & { duplex: "half" });
      if (!res.ok) throw new UploadError(res.status);
      return;
    } catch (err) {
      if (err instanceof UploadError) throw err;
      if ((err as { name?: string })?.name === "AbortError") throw err;
      lastErr = err;
    }
  }
  throw new UploadError(0, `upload failed: ${(lastErr as Error)?.message ?? String(lastErr)}`);
}

export interface MultipartOptions extends PutOptions {
  /** Injectable backoff sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (ms), for tests. */
  now?: () => number;
  /** Parts in flight at once. Default from planMultipart (4, or 8 from 1 GiB). */
  concurrency?: number;
}

/** The four multipart calls, as the public `esfera.conversions.multipart` exposes them. */
export interface MultipartApi {
  init(id: string, body: { parts: number }, opts?: { signal?: AbortSignal }): Promise<MultipartInitResponse>;
  sign(id: string, body: MultipartSignRequest, opts?: { signal?: AbortSignal }): Promise<MultipartInitResponse>;
  complete(id: string, body: { uploadId: string; parts: MultipartPart[] }, opts?: { signal?: AbortSignal }): Promise<void>;
  abort(id: string, body: { uploadId: string }, opts?: { signal?: AbortSignal }): Promise<void>;
}

export function multipartApi(http: HttpClient): MultipartApi {
  const path = (id: string, verb: string) => `/v1/conversions/${encodeURIComponent(id)}/multipart/${verb}`;
  return {
    init: (id, body, o = {}) => http.request<MultipartInitResponse>("POST", path(id, "init"), { body, signal: o.signal }),
    sign: (id, body, o = {}) => http.request<MultipartInitResponse>("POST", path(id, "sign"), { body, signal: o.signal }),
    complete: async (id, body, o = {}) => { await http.request("POST", path(id, "complete"), { body, signal: o.signal }); },
    abort: async (id, body, o = {}) => { await http.request("POST", path(id, "abort"), { body, signal: o.signal }); },
  };
}

const PART_ATTEMPTS = 4; // the first try + 3 retries
const CHUNK = 256 * 1024;
/** Part URLs live an hour and storage checks them when a PUT starts. A part
 *  about to start on a URL older than this gets a fresh one first. */
export const RESIGN_AFTER_MS = 45 * 60_000;
/** The most part numbers one `multipart/sign` call takes. */
export const SIGN_MAX_PARTS = 100;

/** A part's bytes as a stream that reports each chunk as fetch pulls it. */
function partStream(bytes: Uint8Array, onBytes: (n: number) => void): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (off >= bytes.byteLength) { controller.close(); return; }
      const chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.byteLength));
      off += chunk.byteLength;
      controller.enqueue(chunk);
      onBytes(chunk.byteLength);
    },
  });
}

/**
 * Upload a random-access source as parallel multipart parts: init, N workers
 * each PUT a part straight to storage (no API key on those), then complete. Any
 * failure after init aborts the upload (best effort) and rethrows. Progress has
 * the same `{ sent, total }` shape as the single PUT and never goes backwards.
 *
 * Part URLs live an hour. Before a part starts on a URL older than 45 minutes,
 * it and the next parts not yet started get fresh URLs from `multipart/sign`
 * (up to 100 per call; later parts are re-signed the same way as they come
 * due); a part whose PUT answers 403 is re-signed and sent again, once. A
 * re-sign writes nothing, so a 5xx or network failure is retried like a part.
 */
export async function uploadMultipart(http: HttpClient, id: string, source: ResolvedSource, opts: MultipartOptions = {}): Promise<void> {
  if (!source.read) throw new UploadError(0, "multipart upload needs a re-readable source (a path or Blob)");
  const read = source.read;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const api = multipartApi(http);
  const plan = planMultipart(source.size);
  const { partSize, partCount } = plan;
  const concurrency = Math.max(1, opts.concurrency ?? plan.concurrency);
  const { uploadId, partUrls } = await api.init(id, { parts: partCount }, { signal: opts.signal });

  // Live URL and signing time per part number; `started` holds parts already handed to a worker.
  const urls = new Map<number, { url: string; signedAt: number }>();
  const initAt = now();
  for (const p of partUrls) urls.set(p.partNumber, { url: p.url, signedAt: initAt });
  const started = new Set<number>();
  let signing: Promise<void> | null = null;

  const stale = (n: number) => now() - urls.get(n)!.signedAt >= RESIGN_AFTER_MS;

  /** One `multipart/sign` call, retried on 5xx and network errors like a part PUT. */
  const signWithRetry = async (partNumbers: number[]) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      try {
        return await api.sign(id, { uploadId, partNumbers }, { signal: opts.signal });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") throw err;
        const status = (err as { status?: unknown })?.status;
        // A 4xx (already-started, invalid-multipart) will not change: surface it as it is.
        if (typeof status === "number" && status < 500) throw err;
        lastErr = err;
      }
    }
    const why = (lastErr as Error)?.message ?? String(lastErr);
    throw Object.assign(new UploadError(0, `re-signing part URLs failed after ${PART_ATTEMPTS} attempts: ${why}`), { permanent: true });
  };

  /**
   * Fresh URLs for `first` plus the next parts not started yet, up to 100.
   * `force` (a 403) signs `first` even if another worker just did; otherwise
   * parts that a concurrent re-sign already refreshed are skipped.
   */
  const resign = async (first: number[], force = false): Promise<void> => {
    while (signing) await signing;
    const due = force ? first : first.filter(stale);
    if (due.length === 0) return;
    const pending = partUrls.map((p) => p.partNumber).filter((n) => !started.has(n) && !due.includes(n));
    const partNumbers = [...due, ...pending].slice(0, SIGN_MAX_PARTS);
    signing = (async () => {
      const at = now();
      const fresh = await signWithRetry(partNumbers);
      for (const p of fresh.partUrls) urls.set(p.partNumber, { url: p.url, signedAt: at });
    })();
    try { await signing; } finally { signing = null; }
  };

  const total = source.size;
  const counted = new Array<number>(partUrls.length).fill(0);
  let reported = 0;
  const report = () => {
    if (!opts.onProgress) return;
    const sent = Math.max(reported, counted.reduce((a, b) => a + b, 0));
    reported = sent;
    opts.onProgress({ sent, total });
  };

  const putPart = async (i: number, partNumber: number, start: number, end: number): Promise<string> => {
    const length = end - start;
    let lastErr: unknown;
    let resignedOn403 = false;
    for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      try {
        while (signing) await signing;
        if (stale(partNumber)) await resign([partNumber]);
        const bytes = await read(start, length);
        counted[i] = 0;
        const res = await http.rawFetch(urls.get(partNumber)!.url, {
          method: "PUT",
          body: partStream(bytes, (n) => { counted[i] += n; report(); }),
          duplex: "half",
          signal: opts.signal,
          headers: { "Content-Type": opts.contentType ?? "audio/wav", "Content-Length": String(length) },
        } as RequestInit & { duplex: "half" });
        if (res.status === 403 && !resignedOn403) {
          // Most likely an expired URL. Re-sign this part and send it again, not counted as a retry.
          counted[i] = 0;
          resignedOn403 = true;
          await res.body?.cancel().catch(() => { /* already consumed or closed */ });
          await resign([partNumber], true);
          attempt--;
          continue;
        }
        if (res.status >= 500) throw new UploadError(res.status);
        if (!res.ok) { counted[i] = 0; throw Object.assign(new UploadError(res.status), { permanent: true }); }
        const etag = res.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "");
        if (!etag) throw Object.assign(new UploadError(0, "part upload returned no ETag"), { permanent: true });
        counted[i] = length;
        report();
        return etag;
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") throw err;
        if ((err as { permanent?: boolean })?.permanent) throw err;
        if (!(err instanceof UploadError) && err instanceof Error && "status" in err) throw err; // an API error from sign
        lastErr = err;
      }
    }
    if (lastErr instanceof UploadError) throw lastErr;
    throw new UploadError(0, `part ${i + 1} failed: ${(lastErr as Error)?.message ?? String(lastErr)}`);
  };

  const parts: MultipartPart[] = new Array(partUrls.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < partUrls.length) {
      const i = next++;
      const { partNumber } = partUrls[i];
      started.add(partNumber);
      const start = (partNumber - 1) * partSize;
      try {
        parts[i] = { partNumber, etag: await putPart(i, partNumber, start, Math.min(start + partSize, total)) };
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, partUrls.length) }, () => worker()));
    await api.complete(id, { uploadId, parts }, { signal: opts.signal });
  } catch (err) {
    await api.abort(id, { uploadId }).catch(() => { /* best effort */ });
    throw err;
  }
}
