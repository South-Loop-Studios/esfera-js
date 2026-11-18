import { ApiError, ConversionFailedError, type BwfInfo, type ConversionJob, type ConversionStatus, type Esfera, type Preset, type ProfileChoice, type SourceNormalization } from "@esfera/sdk";
import { fit, renderJobLine, sourceLabel, type Theme } from "../ui/index.js";
import { apiErrorLine } from "../exit.js";

export interface TrackedJob {
  id: string;
  name: string;
  out: string;
  status: ConversionStatus;
  stage: string | null;
  progress: number;
  profile: string;
  /** What the master is — "ADM", "3OA" — for the analysing note; null when unknown (a followed job). */
  source: string | null;
  startedAt: number;
  /** While the master is leaving this machine: how far, out of how much, and how fast. */
  upload?: UploadMeter;
}

export interface UploadMeter {
  sent: number;
  total: number;
  /** Bytes per second over the last few seconds; null until there is enough to measure. */
  rate: number | null;
}

/** The rate is read over this window, so a stall shows within a few seconds and one slow chunk does not swing it. */
const RATE_WINDOW_MS = 3000;
const RATE_MIN_SPAN_MS = 500;

/** Fold a progress sample into the meter: sent / total now, and the rate across the recent window. */
export function meterUpload(samples: { t: number; sent: number }[], now: number, sent: number, total: number): UploadMeter {
  samples.push({ t: now, sent });
  while (samples.length > 1 && now - samples[0]!.t > RATE_WINDOW_MS) samples.shift();
  const first = samples[0]!;
  const span = now - first.t;
  const rate = span >= RATE_MIN_SPAN_MS ? ((sent - first.sent) / span) * 1000 : null;
  return { sent, total, rate };
}

/** A conversion waiting its turn: the master, where its output goes, and the choices made for it. */
export interface QueuedConversion {
  file: string;
  out: string;
  preset: Preset;
  profile: ProfileChoice;
  info: BwfInfo;
  sizeBytes: number;
  programme?: number;
  /** Ambisonic masters only: the channel normalization to declare. */
  normalization?: SourceNormalization;
}

export interface JobTrackerDeps {
  sdk: Pick<Esfera, "conversions">;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  bell: () => void;
  bellOn: boolean;
  onLine: (line: string) => void;
  onChange: () => void;
  theme: Theme;
  width: number;
  /** How many conversions may be in flight at once — uploading or running on the server. */
  limit?: () => number;
  /** A queued conversion has become a server job (print its heading, remember the master). */
  onCreated?: (job: ConversionJob, item: QueuedConversion) => void;
  /**
   * The session's lifetime. Once aborted the tracker is closed: polling stops,
   * nothing is downloaded, and no line, redraw or bell reaches the terminal.
   */
  signal?: AbortSignal;
}

/** Ids of jobs still being uploaded; they have no server id yet. */
const LOCAL = "local-";

/**
 * Follows conversions to the end in the background: a queue of masters to
 * upload, at most `limit()` of them in flight at once, each one polled to
 * ready and downloaded, then one transcript line and (optionally) the bell.
 */
export class JobTracker {
  private readonly jobs = new Map<string, TrackedJob>();
  private readonly pending: QueuedConversion[] = [];
  private readonly chains = new Set<Promise<void>>();
  private seq = 0;
  /** The current run, from the first enqueue while idle to the last job's end. */
  private batch = { total: 0, ok: 0, failed: 0 };

  constructor(private readonly deps: JobTrackerDeps) {}

  private get closed(): boolean { return this.deps.signal?.aborted === true; }
  private line(l: string): void { if (!this.closed) this.deps.onLine(l); }
  private changed(): void { if (!this.closed) this.deps.onChange(); }
  private ring(): void { if (!this.closed && this.deps.bellOn) this.deps.bell(); }
  private limit(): number { return Math.max(1, this.deps.limit?.() ?? 1); }

  /** Queue conversions; as many start now as the limit allows, the rest as slots free up. */
  enqueue(items: QueuedConversion[]): void {
    if (this.jobs.size === 0 && this.pending.length === 0) this.batch = { total: 0, ok: 0, failed: 0 };
    this.batch.total += items.length;
    this.pending.push(...items);
    this.pump();
    this.changed();
  }

  private pump(): void {
    while (!this.closed && this.pending.length > 0 && this.jobs.size < this.limit()) this.start(this.pending.shift()!);
  }

  private start(item: QueuedConversion): void {
    const name = item.file.split(/[\\/]/).pop() ?? item.file;
    const t: TrackedJob = { id: `${LOCAL}${++this.seq}`, name, out: item.out, status: "uploading", stage: null, progress: 0, profile: item.profile, source: sourceLabel(item.info), startedAt: this.deps.now(), upload: { sent: 0, total: item.sizeBytes, rate: null } };
    this.jobs.set(t.id, t);
    const samples: { t: number; sent: number }[] = [{ t: t.startedAt, sent: 0 }]; // the start is the first sample
    const run = (async () => {
      try {
        const job = await this.deps.sdk.conversions.create({
          file: item.file, preset: item.preset, profile: item.profile, programme: item.programme, ...(item.normalization ? { source: { normalization: item.normalization } } : {}), signal: this.deps.signal,
          onUploadProgress: (p: { sent: number; total: number }) => {
            t.progress = p.total > 0 ? (p.sent / p.total) * 100 : 0;
            t.upload = meterUpload(samples, this.deps.now(), p.sent, p.total);
            this.changed();
          },
        } as Parameters<Esfera["conversions"]["create"]>[0]);
        if (this.closed) return;
        this.jobs.delete(t.id);
        t.id = job.id; t.status = "queued"; t.progress = 0; t.upload = undefined;
        this.jobs.set(job.id, t);
        this.deps.onCreated?.(job, item);
        await this.track(job, t);
      } catch (err) {
        if (this.closed) return;
        this.batch.failed++;
        const reason = errorText(err);
        try { this.line(fit(`${this.deps.theme.danger("✗")} ${name} · upload failed · ${reason}`, this.deps.width)); } catch { /* never reject */ }
      } finally {
        this.jobs.delete(t.id);
        this.settle();
      }
    })();
    this.chains.add(run);
    void run.finally(() => this.chains.delete(run));
  }

  /** Follow a job that already exists on the server (a one-shot `convert` that was detached, a test). */
  follow(job: ConversionJob, name: string, out: string, profile: string): void {
    const t: TrackedJob = { id: job.id, name, out, status: "queued", stage: null, progress: 0, profile, source: null, startedAt: this.deps.now() };
    this.jobs.set(job.id, t);
    if (this.jobs.size === 1 && this.pending.length === 0) this.batch = { total: 0, ok: 0, failed: 0 };
    this.batch.total++;
    const run = this.track(job, t).finally(() => { this.jobs.delete(job.id); this.settle(); });
    this.chains.add(run);
    void run.finally(() => this.chains.delete(run));
    this.changed();
  }

  /** Poll to the end, download, print the line. Never rejects. */
  private async track(job: ConversionJob, t: TrackedJob): Promise<void> {
    const { theme, width } = this.deps;
    const out = t.out;
    try {
      const c = await job.wait({
        signal: this.deps.signal,
        onProgress: (p) => {
          t.status = p.status; t.stage = p.stage; t.progress = p.progress;
          this.changed();
        },
      });
      if (this.closed) return;
      let bytes: number;
      try {
        ({ bytes } = await job.download(out));
      } catch (err) {
        if (this.closed) return;
        // The encode succeeded; only the write failed (a directory, a full disk, a
        // permission). Say so — "error" would send the person back to re-convert.
        this.batch.failed++;
        const reason = err instanceof Error ? err.message : String(err);
        this.line(renderJobLine(theme, width, { id: job.id, out, ok: false, reason, downloadFailed: true }));
        this.line(fit(`  ${theme.faint(`ready on the server · get ${job.id}`)}`, width));
        this.ring();
        return;
      }
      this.batch.ok++;
      this.line(renderJobLine(theme, width, { id: job.id, out, ok: true, profile: c.outputProfile, bytes, output: c.output }));
      this.ring();
    } catch (err) {
      if (this.closed) return;
      this.batch.failed++;
      const reason = err instanceof ConversionFailedError
        ? (err.conversion.errorMessage ?? "no reason given")
        : errorText(err);
      try {
        this.line(renderJobLine(theme, width, { id: job.id, out, ok: false, reason }));
        this.ring();
      } catch { /* never reject */ }
    }
  }

  /** A slot freed: start the next queued master; when a batch is all done, say how it went. */
  private settle(): void {
    try {
      this.pump();
      if (this.jobs.size === 0 && this.pending.length === 0 && this.batch.total > 1) {
        const { theme, width } = this.deps;
        const { total, ok, failed } = this.batch;
        const mark = failed === 0 ? theme.success("✓") : theme.danger("✗");
        this.line(fit(`${mark} ${ok} of ${total} ready${failed ? ` · ${failed} failed` : ""}`, width));
        this.batch = { total: 0, ok: 0, failed: 0 };
      }
      this.changed();
    } catch { /* never reject */ }
  }

  running(): TrackedJob[] { return [...this.jobs.values()]; }
  queued(): number { return this.pending.length; }

  statusText(): string {
    const n = this.jobs.size, q = this.pending.length;
    if (n === 0 && q === 0) return "no jobs running";
    const run = `${n} job${n === 1 ? "" : "s"} running`;
    return q ? `${run} · ${q} queued` : run;
  }

  /** Server-side ids only: an upload still in flight has nothing to come back to. */
  ids(): string[] { return [...this.jobs.keys()].filter((id) => !id.startsWith(LOCAL)); }

  /** Resolve when every followed job has settled, or after `boundMs`. */
  async idle(boundMs?: number): Promise<void> {
    const all = Promise.allSettled([...this.chains]).then(() => undefined);
    if (boundMs === undefined) return all;
    await Promise.race([all, this.deps.sleep(boundMs)]);
  }
}

/** An error as one line; an API refusal carries its Request-Id. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) return apiErrorLine(err);
  return err instanceof Error ? err.message : String(err);
}
