/** Guided `convert` flow: a pure state machine over the picker. The session host does all I/O. */
import { basename, dirname, extname } from "node:path";
import { eligibleProfiles, predictProfile, presetAllowedForOrder } from "@esfera/sdk";
import type { BwfInfo, Preset, PresetsResponse, ProfileChoice, SourceNormalization, Usage } from "@esfera/sdk";
import type { KeyEvent } from "./keys.js";
import type { RecentMaster } from "./store.js";
import { pickerInit, pickerReduce, renderPicker, type PickerItem, type PickerState } from "./picker.js";
import type { Theme } from "../ui/theme.js";
import { fit } from "../ui/tty.js";
import { sourceLabel } from "../ui/index.js";
import { fmtBytes, fmtClock } from "../ui/parts.js";

export type FlowStep = "file" | "normalization" | "preset" | "profile" | "output" | "done";
/** One master of a folder batch, already inspected. */
export interface BatchFile { path: string; info: BwfInfo; sizeBytes: number }
/** A folder picked at the file step: every ADM master inside it, converted with one preset and profile. */
export interface BatchChoice { dir: string; files: BatchFile[]; skipped: number }
export interface FlowChoices { file?: string; info?: BwfInfo; sizeBytes?: number; batch?: BatchChoice; normalization?: SourceNormalization; preset?: Preset; profile?: ProfileChoice; out?: string }
export interface FlowState { step: FlowStep; choices: FlowChoices; picker: PickerState | null; error: string | null }
/** What `start` carries: one inspected master, or a folder batch, plus the shared choices. */
export type StartChoices = FlowChoices & { preset: Preset; profile: ProfileChoice; out: string } & (
  | { file: string; info: BwfInfo; sizeBytes: number; batch?: undefined }
  | { batch: BatchChoice; file?: undefined }
);
export type FlowEffect =
  | { kind: "inspect"; path: string }
  | { kind: "complete"; text: string }
  | { kind: "start"; choices: StartChoices }
  | { kind: "cancel" }
  | null;
export interface FlowDeps { presets: PresetsResponse; recent: RecentMaster[]; usage: Usage; running: number; home: string }

function expandHome(p: string, home: string): string {
  if (p === "~" || p.startsWith("~/")) return home.replace(/\/$/, "") + p.slice(1);
  return p;
}

function filePicker(deps: FlowDeps): PickerState {
  const items: PickerItem[] = deps.recent.map((r) => ({
    label: basename(r.path),
    detail: `${fmtBytes(r.sizeBytes)} · ${r.channels} ch · ${fmtClock(r.durationSec)} · ${sourceLabel(r)}${r.objectCount > 0 ? ` · ${r.objectCount} objects` : ""}`,
    value: r.path,
  }));
  const p = pickerInit(items, { field: true });
  return items.length === 0 ? { ...p, focus: "field" } : p;
}

/** The ambisonic files of the pick: the one master, or the folder's ambisonic members. */
function ambisonicOrders(c: FlowChoices): number[] {
  const infos = c.batch ? c.batch.files.map((f) => f.info) : c.info ? [c.info] : [];
  return infos.map((i) => i.ambisonicOrder ?? 0).filter((o) => o > 0);
}

function normalizationPicker(c: FlowChoices): PickerState {
  const above = ambisonicOrders(c).some((o) => o > 1);
  const items: PickerItem[] = [
    { label: "AmbiX (SN3D)", value: "sn3d", detail: "the usual convention" },
    { label: "N3D", value: "n3d", detail: "full 3D normalization" },
    { label: "FuMa", value: "fuma", detail: "first order only", disabled: above ? "first order only — a file here is above first order" : null },
  ];
  return pickerInit(items, {});
}

/** Where the flow goes once the file (or folder) is accepted: the normalization step for ambisonic sources, else the preset. */
function afterFile(c: FlowChoices, deps: FlowDeps): { step: FlowStep; picker: PickerState } {
  return ambisonicOrders(c).length > 0 ? { step: "normalization", picker: normalizationPicker(c) } : { step: "preset", picker: presetPicker(deps, c) };
}

function presetPicker(deps: FlowDeps, c: FlowChoices): PickerState {
  // The server refuses the 3OA scene presets for a 1OA/2OA source (OrbitCore #561); say so here, before the upload.
  const low = ambisonicOrders(c).filter((o) => o < 3);
  const items: PickerItem[] = deps.presets.presets.map((p) => {
    const declares = `declares ${p.declares.join("/")}`;
    const blocked = low.length > 0 && !presetAllowedForOrder(p.id, Math.min(...low));
    return { label: p.id, detail: p.description ? `${p.description} · ${declares}` : declares, value: p.id,
      disabled: blocked ? `needs a 3OA source — ${low.length === 1 && !c.batch ? `this file is ${low[0]}OA` : "a file here is 1OA/2OA"}` : null };
  });
  const idx = items.findIndex((i) => i.value === "esfera");
  return { ...pickerInit(items, {}), index: idx >= 0 ? idx : 0 };
}

function profilePicker(deps: FlowDeps, c: FlowChoices): PickerState {
  const shapes = c.batch
    ? c.batch.files.map((f) => ({ channels: f.info.channels, objectCount: f.info.objectCount, ambisonicOrder: f.info.ambisonicOrder ?? null }))
    : [{ channels: c.info!.channels, objectCount: c.info!.objectCount, ambisonicOrder: c.info!.ambisonicOrder ?? null }];
  const predictions = [...new Set(shapes.map((sh) => predictProfile(deps.presets, c.preset!, sh)))];
  const predicted = predictions.length === 1 ? predictions[0] : null;
  const autoNote = c.batch
    ? (predicted ? ` → ${predicted} for every master` : ` → varies by master (${predictions.filter(Boolean).join(", ")})`)
    : (predicted ? ` → ${predicted} for this master` : "");
  // For a folder, a profile is offered only when every master in it can take it.
  const perShape = shapes.map((sh) => eligibleProfiles(deps.presets, c.preset!, sh));
  const eligible = perShape[0]!.map((e) => {
    const blocked = perShape.map((list) => list.find((x) => x.profile.id === e.profile.id)?.reason ?? null).find((r) => r);
    return { profile: e.profile, reason: blocked ?? null };
  });
  const items: PickerItem[] = [
    { label: "auto", value: "auto", detail: "the preset picks by content" + autoNote },
    ...eligible.map(({ profile, reason }) => ({
      label: profile.id,
      value: profile.id,
      detail: `${profile.label} · ${profile.family} · ${profile.maxElements} el / ${profile.maxChannels} ch`,
      disabled: reason,
    })),
  ];
  return pickerInit(items, {});
}

function outputPicker(c: FlowChoices): PickerState {
  // A single master: its name with .iamf, beside it. A folder: the folder — every output lands there.
  const out = c.batch ? c.batch.dir : `${dirname(c.file!)}/${basename(c.file!, extname(c.file!))}.iamf`;
  const p = pickerInit([], { field: true, initialText: out, pristine: true });
  return { ...p, focus: "field" };
}

export function flowInit(deps: FlowDeps): FlowState {
  return { step: "file", choices: {}, picker: filePicker(deps), error: null };
}

export function flowReduce(s: FlowState, e: KeyEvent, deps: FlowDeps): [FlowState, FlowEffect] {
  if (!s.picker) return [s, null];
  const [picker, eff] = pickerReduce(s.picker, e);
  const next: FlowState = { ...s, picker };
  if (!eff) return [next, null];
  if (eff.kind === "complete") return [next, eff];
  const c = s.choices;
  if (eff.kind === "back") {
    switch (s.step) {
      case "file": return [next, { kind: "cancel" }];
      case "normalization": return [{ step: "file", choices: {}, picker: filePicker(deps), error: null }, null];
      case "preset": {
        if (ambisonicOrders(c).length > 0) {
          const { preset: _p, ...rest } = c;
          return [{ step: "normalization", choices: rest, picker: normalizationPicker(rest), error: null }, null];
        }
        return [{ step: "file", choices: {}, picker: filePicker(deps), error: null }, null];
      }
      case "profile": {
        const { preset: _p, profile: _q, out: _o, ...rest } = c;
        return [{ step: "preset", choices: rest, picker: presetPicker(deps, rest), error: null }, null];
      }
      case "output": {
        const { profile: _q, out: _o, ...rest } = c;
        return [{ step: "profile", choices: rest, picker: profilePicker(deps, rest), error: null }, null];
      }
      default: return [next, null];
    }
  }
  // pick
  switch (s.step) {
    case "file":
    {
      const path = expandHome(eff.value, deps.home);
      return [{ ...next, choices: { ...c, file: path }, error: null }, { kind: "inspect", path }];
    }
    case "normalization":
      return [{ step: "preset", choices: { ...c, normalization: eff.value as SourceNormalization }, picker: presetPicker(deps, c), error: null }, null];
    case "preset":
      return [{ step: "profile", choices: { ...c, preset: eff.value as Preset }, picker: profilePicker(deps, { ...c, preset: eff.value as Preset }), error: null }, null];
    case "profile":
      return [{ step: "output", choices: { ...c, profile: eff.value as ProfileChoice }, picker: outputPicker(c), error: null }, null];
    case "output": {
      // Beyond the team's concurrency the session queues; nothing is refused here.
      const choices = { ...c, out: expandHome(eff.value, deps.home) } as StartChoices;
      return [{ step: "done", choices, picker: null, error: null }, { kind: "start", choices }];
    }
    default:
      return [next, null];
  }
}

export function flowInspected(
  s: FlowState,
  r: { ok: true; info: BwfInfo; sizeBytes: number } | { ok: false; reason: string },
  deps: FlowDeps,
): FlowState {
  if (s.step !== "file") return s;
  if (!r.ok) return { ...s, error: r.reason };
  if (!r.info.isAdm && !r.info.ambisonicOrder) return { ...s, error: "this file carries no ADM metadata and is not ambisonic (4, 9 or 16 channels)" };
  const limit = deps.usage.limits.perFileMinutes;
  if (r.info.durationSec / 60 > limit) return { ...s, error: `this master is over the ${limit}-minute limit` };
  const bytes = deps.usage.limits.perFileBytes;
  if (r.sizeBytes > bytes) return { ...s, error: `this master is ${fmtBytes(r.sizeBytes)} — over the ${fmtBytes(bytes)} limit for one file` };
  const choices = { ...s.choices, info: r.info, sizeBytes: r.sizeBytes };
  const next = afterFile(choices, deps);
  return { step: next.step, choices, picker: next.picker, error: null };
}

/** The session scanned the folder picked at the file step. */
export function flowScanned(
  s: FlowState,
  r: { ok: true; dir: string; files: BatchFile[]; skipped: number } | { ok: false; reason: string },
  deps: FlowDeps,
): FlowState {
  if (s.step !== "file") return s;
  if (!r.ok) return { ...s, error: r.reason };
  if (r.files.length === 0) return { ...s, error: `no ADM or ambisonic masters in ${basename(r.dir) || r.dir}${r.skipped ? ` (${r.skipped} file${r.skipped === 1 ? "" : "s"} skipped)` : ""}` };
  const limit = deps.usage.limits.perFileMinutes;
  const long = r.files.filter((f) => f.info.durationSec / 60 > limit);
  if (long.length) return { ...s, error: `${basename(long[0]!.path)} is over the ${limit}-minute limit` };
  const bytes = deps.usage.limits.perFileBytes;
  const big = r.files.filter((f) => f.sizeBytes > bytes);
  if (big.length) return { ...s, error: `${basename(big[0]!.path)} is ${fmtBytes(big[0]!.sizeBytes)} — over the ${fmtBytes(bytes)} limit for one file` };
  const { file: _f, info: _i, sizeBytes: _b, ...rest } = s.choices;
  const choices = { ...rest, batch: { dir: r.dir, files: r.files, skipped: r.skipped } };
  const next = afterFile(choices, deps);
  return { step: next.step, choices, picker: next.picker, error: null };
}

const LABEL_W = 9;
export function renderFlow(theme: Theme, width: number, s: FlowState, deps: FlowDeps): string[] {
  void deps;
  const lines: string[] = [];
  const tick = (label: string, text: string) =>
    lines.push(fit("  " + theme.success("✓") + " " + theme.dim(label.padEnd(LABEL_W)) + theme.fg(text), width));
  const c = s.choices;
  if (c.batch) {
    const total = c.batch.files.reduce((n, f) => n + f.info.durationSec, 0);
    tick("folder", `${basename(c.batch.dir) || c.batch.dir} · ${c.batch.files.length} master${c.batch.files.length === 1 ? "" : "s"} · ${fmtClock(total)}${c.batch.skipped ? ` · ${c.batch.skipped} skipped` : ""}`);
  } else if (c.file && c.info) tick("file", `${basename(c.file)} · ${c.info.channels} ch · ${fmtClock(c.info.durationSec)}`);
  if (c.normalization) tick("channels", c.normalization === "sn3d" ? "AmbiX (SN3D)" : c.normalization === "n3d" ? "N3D" : "FuMa");
  if (c.preset) tick("preset", c.preset);
  if (c.profile) tick("profile", c.profile);
  if (s.error) lines.push(fit("  " + theme.danger(`✗ ${s.error}`), width));
  if (s.picker) {
    const t: Record<string, [string, string]> = {
      file: ["pick a master", "↑↓ choose · type a path or a folder · drag it here · Esc cancels"],
      normalization: ["ambisonic channel order", "↑↓ choose · Enter · Esc back"],
      preset: ["preset", "↑↓ choose · Enter · Esc back"],
      profile: ["profile", "↑↓ choose · Enter · Esc back"],
      output: [c.batch ? "output folder" : "output", c.batch ? "Enter accepts · every master lands here as <name>.iamf · Esc back" : "Enter accepts · type another path · Esc back"],
    };
    const [title, hint] = t[s.step] ?? ["", ""];
    lines.push(...renderPicker(theme, width, s.picker, title, hint));
  }
  return lines;
}
