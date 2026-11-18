/**
 * The six screens of direction D (Figma `16 · Sketches`, row y≈68570):
 * login · convert live · convert ready · presets · conversions list · error.
 * Pure functions of (theme, width, data) → string, so each is snapshot-tested
 * at the Figma width (108) and at a narrow width (72).
 */
import type { Conversion, PresetsResponse, Profile, PresetInfo, BwfInfo, Usage, Output } from "@esfera/sdk";
import type { Theme } from "./theme.js";
import { banner, heading, eyebrow, stages, ledger, table, bar, fmtBytes, fmtClock, relTime, hoursUntil, profileLabel, type StageRow } from "./parts.js";
import { fit, visibleLength } from "./tty.js";

export { detectTerminal, fit, visibleLength, stripAnsi, type Terminal } from "./tty.js";
export { makeTheme, type Theme, type Paint } from "./theme.js";
export * from "./parts.js";
export { createSpinner, type Spinner } from "./spinner.js";

export interface Env {
  /** The host: `PRODUCTION` or `STAGING`. The key's mode (`SANDBOX`/`LIVE`) is shown apart from it. */
  label: string;
  host: string;
  user?: string;
}

const envRight = (env: Env) => [env.label, env.host, env.user].filter(Boolean).join(" · ");
const E = "";

// ── login ────────────────────────────────────────────────────────────────────

export interface LoginData {
  env: Env;
  keyId: string;
  plan: string;
  name: string;
  path: string;
}

export function renderLogin(theme: Theme, width: number, d: LoginData): string {
  return [
    banner(theme, width, d.env.host),
    heading(theme, width, "login"),
    E,
    stages(theme, [{ state: "done", label: "signed in", detail: `${d.name} · ${d.plan} · ${d.env.label}` }], width),
    ledger(theme, [["key", theme.data(d.keyId)], ["saved to", theme.fg(d.path), "0600"]], width),
    E,
    fit(`  ${theme.dim("next")}   ${theme.fg("esfera convert master.wav --preset esfera")}`, width),
  ].join("\n");
}

export interface DeviceCodeData { env: Env; userCode: string; url: string; opened: boolean }

export function renderDeviceCode(theme: Theme, width: number, d: DeviceCodeData): string {
  return [
    banner(theme, width, envRight(d.env)),
    heading(theme, width, "login"),
    E,
    eyebrow(theme, "code"),
    fit(`  ${theme.bold(theme.data(d.userCode))}`, width),
    E,
    fit(`  ${theme.fg(d.url)}`, width),
    fit(`  ${theme.dim(d.opened ? "opening your browser…" : "open this address in a browser")}`, width),
    E,
    fit(`  ${theme.faint("waiting · ^C cancels")}`, width),
  ].join("\n");
}

// ── convert · live ───────────────────────────────────────────────────────────

export type SourceSummary = BwfInfo;

export interface ConvertLiveData {
  env: Env;
  file: string;
  out: string;
  source: SourceSummary;
  stages: StageRow[];
  id?: string;
}

/** What a master is, as one short label: ADM, its ambisonic order, or a plain WAV. */
export function sourceLabel(s: { isAdm: boolean; ambisonicOrder?: number | null }): "ADM" | "1OA" | "2OA" | "3OA" | "WAV" {
  if (s.isAdm) return "ADM";
  const o = s.ambisonicOrder;
  return o === 1 ? "1OA" : o === 2 ? "2OA" : o === 3 ? "3OA" : "WAV";
}

/** "7.1.4 bed + 14 objects · 26 ch · 15 elements · 1 mix (Default Mix)" — what the written file holds. */
export function describeOutput(o: Output): string {
  const groups: string[] = [];
  let objects = 0;
  let objectsAt = -1;
  for (const e of o.elements) {
    if (e.kind === "object") {
      if (objectsAt < 0) { objectsAt = groups.length; groups.push(""); }
      objects++;
    } else groups.push(`${e.layout ?? e.label} ${e.kind}`);
  }
  if (objectsAt >= 0) groups[objectsAt] = `${objects} object${objects === 1 ? "" : "s"}`;
  const parts = [groups.join(" + "), `${o.channels} ch`];
  if (o.elementCount !== groups.length) parts.push(`${o.elementCount} element${o.elementCount === 1 ? "" : "s"}`);
  if (o.foldedObjects > 0) parts.push(`${o.foldedObjects} object${o.foldedObjects === 1 ? "" : "s"} folded`);
  const labels = o.mixPresentations.map((m) => (m.language ? `${m.label} [${m.language}]` : m.label));
  if (labels.length > 0) parts.push(`${labels.length} mix${labels.length === 1 ? "" : "es"} (${labels.join(", ")})`);
  return parts.join(" · ");
}

function sourceLine(theme: Theme, s: SourceSummary): string {
  const bits = [`${s.channels} ch`, `${Math.round(s.sampleRate / 1000)} kHz`, `${s.bitsPerSample}-bit`, fmtClock(s.durationSec)];
  if (s.isAdm) bits.push(`${s.programmeCount} programme${s.programmeCount === 1 ? "" : "s"}`);
  if (s.objectCount > 0) bits.push(`${s.objectCount} objects`);
  // The format badge leads, as in the presets table: ADM in the data colour, a plain WAV faint.
  const label = sourceLabel(s);
  const badge = label === "WAV" ? theme.faint(label) : theme.data(label);
  return "  " + badge + "  " + theme.fg(bits.join(" · "));
}

export function renderConvertLive(theme: Theme, width: number, d: ConvertLiveData): string {
  return [
    banner(theme, width, envRight(d.env)),
    heading(theme, width, "convert", `${d.file}  →  ${d.out}`),
    E,
    eyebrow(theme, "source"),
    fit(sourceLine(theme, d.source), width),
    E,
    ...(d.stages.length ? [eyebrow(theme, "stages"), stages(theme, d.stages, width), E] : []),
    fit(`  ${theme.data(d.id ?? "")}${d.id ? theme.faint("   ·   ^C detaches, the job keeps running") : ""}`, width),
  ].join("\n");
}

// ── convert · ready ──────────────────────────────────────────────────────────

export interface ConvertReadyData {
  env: Env;
  file: string;
  out: string;
  conversion: Conversion;
  encodeSec?: number;
  uploadDetail?: string;
  now: Date;
}

export function renderConvertReady(theme: Theme, width: number, d: ConvertReadyData): string {
  const c = d.conversion;
  const objects = c.objectCount ? `7.1.4 bed + ${c.objectCount} objects` : `${c.outputChannels ?? "—"} ch`;
  return [
    banner(theme, width, envRight(d.env)),
    heading(theme, width, "convert", `${d.file}  →  ${d.out}`),
    E,
    stages(theme, [
      { state: "done", label: "uploaded", detail: d.uploadDetail ?? "" },
      { state: "done", label: "analysed", detail: objects },
      { state: "done", label: "encoded", detail: d.encodeSec !== undefined ? fmtClock(d.encodeSec) : "" },
      { state: "done", label: "ready" },
    ], width),
    E,
    eyebrow(theme, "result"),
    ledger(theme, [
      ["file", theme.bold(theme.fg(d.out)), fmtBytes(c.outputSizeBytes)],
      ["profile", theme.brandOrange(profileLabel(c.outputProfile)), c.outputChannels ? `${c.outputChannels} ch` : ""],
      ...(c.output ? [["holds", theme.fg(describeOutput(c.output))] as [string, string]] : []),
      ["loudness", theme.data(c.outputLoudnessLufs !== null ? `${c.outputLoudnessLufs.toFixed(1)} LUFS` : "—"), "matched to the source"],
      ["retention", theme.fg(hoursUntil(c.expiresAt, d.now)), `esfera conversions get ${c.id}`],
    ], width),
  ].join("\n");
}

// ── presets ──────────────────────────────────────────────────────────────────

export interface PresetsData {
  env: Env;
  presets: PresetsResponse;
}

export function renderPresets(theme: Theme, width: number, d: PresetsData): string {
  const familyPaint = (f: Profile["family"]) => (f === "eclipsa" ? theme.brandOrange : theme.brandPink);
  const byFamily = d.presets.profiles.map((p, i) => ({ ...p, familyCell: i === 0 || d.presets.profiles[i - 1].family !== p.family ? p.family : "" }));
  const profiles = table(theme, {
    width,
    rows: byFamily,
    rowPaint: (p) => (p.writable ? null : theme.faint),
    columns: [
      { key: "familyCell", paint: (t, p) => familyPaint(p.family)(t) },
      { key: "id" },
      { key: (p) => `${p.maxElements} el`, align: "right", paint: (t) => theme.data(t) },
      { key: (p) => `${p.maxChannels} ch`, align: "right", paint: (t) => theme.data(t) },
      { key: (p) => (p.objects ? "objects" : "—"), paint: (t, p) => (p.objects ? theme.dim(t) : theme.faint(t)) },
      { key: (p) => (p.writable ? "writable" : "read-only"), paint: (t) => theme.dim(t) },
    ],
  });
  const objectsWord: Record<PresetInfo["objects"], string> = { keep: "keeps objects", fold: "folds objects", scene: "scene" };
  const presets = table(theme, {
    width,
    rows: d.presets.presets,
    columns: [
      { key: "id", paint: (t) => theme.bold(theme.fg(t)) },
      { key: (p) => p.declares.join(" / ") },
      { key: (p) => objectsWord[p.objects], paint: (t) => theme.dim(t) },
      { key: (p) => p.inputs.join(", "), paint: (t) => theme.data(t) },
    ],
  });
  return [
    banner(theme, width, `OrbitCore ${d.presets.engine.orbitcore}`),
    heading(theme, width, "presets"),
    E,
    eyebrow(theme, "profiles"),
    profiles,
    E,
    eyebrow(theme, "presets"),
    presets,
    fit("  " + theme.faint("an ambisonic file is kept whole at its own order by esfera and youtube (a 3OA stays 3OA); the two scene presets need a 3OA file"), width),
    E,
    fit("  " + theme.faint("--profile <id> on convert · base-advanced is listed so you know it exists, not so you can pick it"), width),
  ].join("\n");
}

// ── usage ────────────────────────────────────────────────────────────────────

export interface UsageData { env: Env; usage: Usage; now: Date }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso: string) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const min = (n: number) => `${Math.round(n)} min`;

export function renderUsage(theme: Theme, width: number, d: UsageData): string {
  const u = d.usage;
  const pct = u.minutes.included > 0 ? Math.min(100, (u.minutes.used / u.minutes.included) * 100) : 0;
  const period = u.period.resetsMonthly
    ? (u.period.resetsAt ? `resets ${fmtDay(u.period.resetsAt)}` : "resets monthly")
    : "lifetime allowance";
  const barWidth = Math.max(10, Math.min(28, width - 2 - 32));
  return [
    banner(theme, width, envRight(d.env)),
    heading(theme, width, "usage", `${u.plan} plan`),
    E,
    eyebrow(theme, "minutes"),
    fit(`  ${bar(theme, pct, barWidth)}  ${theme.fg(`${Math.round(u.minutes.used)} / ${Math.round(u.minutes.included)} min`)}   ${theme.dim(period)}`, width),
    E,
    ledger(theme, [
      ["used", theme.fg(min(u.minutes.used)), u.period.resetsMonthly ? "this period" : "so far"],
      ["remaining", theme.fg(min(u.minutes.remaining)), u.minutes.credit > 0 ? `includes ${min(u.minutes.credit)} credit` : ""],
      ["per file", theme.fg(`${min(u.limits.perFileMinutes)} · up to ${fmtBytes(u.limits.perFileBytes)}`), "longest and largest master accepted"],
      ["concurrent", theme.fg(`${u.limits.concurrent} job${u.limits.concurrent === 1 ? "" : "s"}`), `${u.limits.inFlight} running now`],
      ["rate limit", theme.fg(`${u.limits.rateLimitPerMinute} / min`), ""],
      ["retention", theme.fg(`${u.limits.retentionHours} h`), "outputs stay downloadable this long"],
    ], width),
  ].join("\n");
}

// ── conversions list ─────────────────────────────────────────────────────────

export interface ConversionsData {
  env: Env;
  items: Conversion[];
  total: number;
  page: number;
  pageSize: number;
  now: Date;
}

function statusGlyph(theme: Theme, c: Conversion): string {
  switch (c.status) {
    case "ready": return theme.success("●");
    case "error": return theme.danger("✗");
    case "running": case "analyzing": return theme.brand("◐");
    default: return theme.dim("◌");
  }
}
function statusWord(c: Conversion): string {
  if (c.status === "running") return c.stage === "encoding" ? "encoding" : "running";
  if (c.status === "analyzing") return "analysing";
  return c.status;
}
function statusPaint(theme: Theme, c: Conversion) {
  return c.status === "ready" ? theme.success : c.status === "error" ? theme.danger : c.status === "running" || c.status === "analyzing" ? theme.brandOrange : theme.dim;
}

export function renderConversions(theme: Theme, width: number, d: ConversionsData): string {
  const first = (d.page - 1) * d.pageSize + 1;
  const last = first + d.items.length - 1;
  const rows = table(theme, {
    width,
    rows: d.items,
    columns: [
      { key: (c) => statusGlyph(theme, c), paint: (t) => t },
      { key: "id", paint: (t) => theme.data(t) },
      { key: "name", max: 28 },
      { key: (c) => statusWord(c), paint: (t, c) => statusPaint(theme, c)(t) },
      { key: (c) => c.preset ?? "—", paint: (t) => theme.dim(t) },
      { key: (c) => (c.outputProfile ?? c.profile), paint: (t) => theme.dim(t) },
      { key: (c) => (c.status === "running" ? `${relTime(c.updatedAt, d.now)} · ${Math.round(c.progress)}%` : relTime(c.createdAt, d.now)), paint: (t) => theme.faint(t) },
    ],
  });
  return [
    banner(theme, width, `${d.total} · newest first`),
    heading(theme, width, "conversions"),
    E,
    rows,
    E,
    fit(`  ${theme.dim(`${first}–${last} of ${d.total}`)}${theme.faint("   ·   --page 2   ·   --status ready   ·   --json")}`, width),
  ].join("\n");
}

// ── error ────────────────────────────────────────────────────────────────────

export interface ErrorData {
  env: Env;
  command: string;
  file?: string;
  title: string;
  status?: number;
  slug?: string | null;
  detail: string;
  writable?: string[];
  /** The response's `Request-Id`, to quote to support and to find the call in the console's Logs. */
  requestId?: string;
  exitCode: number;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function renderError(theme: Theme, width: number, d: ErrorData): string {
  const lines = [
    banner(theme, width, envRight(d.env)),
    heading(theme, width, d.command, d.file ? `${d.file}  →  —` : undefined),
    E,
    fit(`  ${theme.danger("✗")} ${theme.bold(theme.fg(d.title))}${d.status ? `   ${theme.dim(`${d.status}${d.slug ? ` · ${d.slug}` : ""}`)}` : ""}`, width),
    E,
    ...wrapText(d.detail, width - 2).map((l) => "  " + theme.fg(l)),
    E,
  ];
  if (d.requestId) lines.push(fit(`  ${theme.dim("request")}  ${theme.data(d.requestId)}`, width), E);
  if (d.writable?.length) {
    lines.push(eyebrow(theme, "writable"), fit("  " + theme.fg(d.writable.join(" · ")), width), E);
  }
  lines.push(
    eyebrow(theme, "next"),
    fit(`  ${theme.faint("├─")} ${theme.fg("esfera presets")}`, width),
    fit(`  ${theme.faint("└─")} ${theme.data(`developers.esfera.audio/reference/errors${d.slug ? `#${d.slug}` : ""}`)}`, width),
    E,
    fit("  " + theme.faint(`exit ${d.exitCode}`), width),
  );
  return lines.join("\n");
}

// ── finished-job line (session) ──────────────────────────────────────────────

export interface JobLineData { id: string; out: string; ok: boolean; profile?: string | null; bytes?: number; output?: Output | null; reason?: string | null
  /** The job reached ready but writing the output failed; the file is still on the server. */
  downloadFailed?: boolean;
}

export function renderJobLine(theme: Theme, width: number, j: JobLineData): string {
  const id = j.id.replace(/^conv_/, "").slice(0, 8);
  const name = j.out.split(/[\\/]/).pop() ?? j.out;
  const segs = j.ok
    ? [id, name, "ready", j.profile ?? "—", ...(j.bytes != null ? [fmtBytes(j.bytes)] : [])]
    : j.downloadFailed
      ? [id, name, "download failed", j.reason ?? "no reason given"]
      : [id, name, "error", j.reason ?? "no reason given"];
  const mark = j.ok ? theme.success("✓") : theme.danger("✗");
  const line = `${mark} ${segs.join(" · ")}`;
  if (j.ok) return fit(line, width) + (j.output ? "\n" + fit(`  ${theme.dim(describeOutput(j.output))}`, width) : "");
  if ( visibleLength(line) <= width) return fit(line, width);
  // A long reason is the part worth reading: give it its own line, unclipped,
  // so the session wraps it (and a plain terminal does the same).
  return fit(`${mark} ${segs.slice(0, -1).join(" · ")}`, width) + "\n  " + segs[segs.length - 1];
}
