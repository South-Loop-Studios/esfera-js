/**
 * `esfera convert <file.wav> [--preset <id>] [--profile <id|auto>] [--programme <n>] [-o <out.iamf>] [--json]`
 *
 * Pre-flight locally (BWF header + the per-file cap /v1/usage reports for the key's team and mode)
 * before a byte is uploaded; then create (the preset is always sent, so the
 * server auto-starts), wait, download. Stages render live on the direction-D
 * rail; `--json` prints one result object and nothing else.
 *
 * Exit codes are the contract (exit.ts). An ApiError at ANY stage is 3.
 */
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Esfera, Conversion, BwfInfo } from "@esfera/sdk";
import { ApiError, ConversionFailedError, ConversionStalledError, UploadError, PRESETS, PROFILE_IDS, SOURCE_NORMALIZATIONS, presetAllowedForOrder, type SourceNormalization } from "@esfera/sdk";
import { configDir as defaultConfigDir } from "../credentials.js";
import { resolveCredentials, environmentLabel } from "../context.js";
import { EXIT, CliExit, setCurrentJob, type ExitCode } from "../exit.js";
import { isDirectory, runConvertBatch } from "./convertBatch.js";
import { makeTheme, createSpinner, stages, renderConvertLive, renderConvertReady, renderError, sourceLabel, fmtBytes, fmtClock, type Terminal, type StageRow, type Env } from "../ui/index.js";
import { AUDIO_FILE } from "../audioFiles.js";

export interface ConvertDeps {
  env: Record<string, string | undefined>;
  configDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  terminal: Terminal;
  now: () => Date;
  sdk: (opts: { apiKey: string; baseUrl: string }) => Pick<Esfera, "files" | "usage" | "conversions">;
}

export function defaultConvertDeps(partial: Partial<ConvertDeps> = {}): ConvertDeps {
  return {
    env: process.env,
    configDir: defaultConfigDir(process.env),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    terminal: { colour: "none", width: 100, interactive: false },
    now: () => new Date(),
    sdk: () => { throw new Error("sdk factory not wired"); },
    ...partial,
  };
}

interface Args {
  file: string;
  preset: string;
  profile?: string;
  programme: string | null;
  normalization?: SourceNormalization;
  out: string | null;
  json: boolean;
}

const USAGE = "usage: esfera convert <file.wav | folder> [--preset esfera|youtube|bed714_3oa|oa3] [--profile <id>|auto] [--programme <n>] [--normalization sn3d|n3d|fuma] [-o out.iamf | folder] [--json]";

function parseArgs(args: string[]): Args {
  const files: string[] = [];
  const a: Args = { file: "", preset: "esfera", programme: null, out: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    const next = () => { if (i + 1 >= args.length) throw new CliExit(EXIT.usage, `${x} requires a value`); return args[++i]; };
    if (x === "--preset") a.preset = next();
    else if (x === "--profile") a.profile = next();
    else if (x === "--programme") a.programme = next();
    else if (x === "--normalization") {
      const v = next();
      if (!(SOURCE_NORMALIZATIONS as readonly string[]).includes(v)) throw new CliExit(EXIT.usage, `unknown normalization '${v}' — one of: ${SOURCE_NORMALIZATIONS.join(", ")}`);
      a.normalization = v as SourceNormalization;
    }
    else if (x === "-o" || x === "--out") a.out = next();
    else if (x === "--json") a.json = true;
    else if (x.startsWith("-")) throw new CliExit(EXIT.usage, `unknown option '${x}'\n${USAGE}`);
    else files.push(x);
  }
  if (files.length !== 1) throw new CliExit(EXIT.usage, USAGE);
  a.file = files[0];
  if (!(PRESETS as readonly string[]).includes(a.preset)) throw new CliExit(EXIT.usage, `unknown preset '${a.preset}' — use one of: ${PRESETS.join(", ")}`);
  if (a.profile !== undefined && a.profile !== "auto" && !(PROFILE_IDS as readonly string[]).includes(a.profile)) {
    throw new CliExit(EXIT.usage, `unknown profile '${a.profile}' — one of: ${PROFILE_IDS.join(", ")}, auto (see \`esfera presets\`)`);
  }
  return a;
}

/**
 * The `source` to send for an ambisonic file, or undefined for ADM. Refuses `--normalization`
 * on an ADM file and fuma above first order (exit 2); notes the sn3d assumption when unspecified.
 */
export function chooseSource(info: BwfInfo, norm: SourceNormalization | undefined, file: string, stderr: (s: string) => void): { normalization: SourceNormalization } | undefined {
  const order = info.ambisonicOrder ?? null;
  if (order === null) {
    if (norm !== undefined) throw new CliExit(EXIT.usage, `--normalization applies to ambisonic files; ${basename(file)} is ADM`);
    return undefined;
  }
  if (norm === "fuma" && order > 1) throw new CliExit(EXIT.usage, `fuma is first order only — ${basename(file)} is ${order}OA`);
  if (norm === undefined) {
    stderr(`note: ${basename(file)} is ambisonic (${order}OA, ${info.channels} ch) — AmbiX (SN3D) assumed; --normalization n3d|fuma to change\n`);
    return { normalization: "sn3d" };
  }
  return { normalization: norm };
}

/** The programme to send: only when the file offers a real choice (0-based). */
function chooseProgramme(info: BwfInfo, arg: string | null, file: string, stderr: (s: string) => void): number | undefined {
  if (info.programmeCount >= 2) {
    if (arg !== null) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0 || n >= info.programmeCount) {
        throw new CliExit(EXIT.usage, `--programme must be an integer from 0 to ${info.programmeCount - 1} for this file (it declares ${info.programmeCount} programmes)`);
      }
      return n;
    }
    stderr(`note: file declares ${info.programmeCount} programmes; converting the first (--programme 0) — override with --programme <n>, 0 to ${info.programmeCount - 1}\n`);
    return 0;
  }
  if (arg !== null) stderr(`note: --programme ignored — ${basename(file)} declares ${info.programmeCount} programme(s), nothing to choose between\n`);
  return undefined;
}

export async function runConvert(args: string[], deps: ConvertDeps): Promise<ExitCode> {
  const theme = makeTheme(deps.terminal);
  const width = deps.terminal.width;
  let env: Env = { label: "PRODUCTION", host: "api.esfera.audio" };
  let a: Args | null = null;
  let spinnerRef: { cancel(): void } | null = null;
  try {
    a = parseArgs(args);
    const creds = resolveCredentials(deps.env, deps.configDir);
    if (!creds) throw new CliExit(EXIT.refused, "not signed in — run `esfera auth login`");
    env = { ...environmentLabel(creds.apiUrl), user: deps.env.USER };
    const sdk = deps.sdk({ apiKey: creds.apiKey, baseUrl: creds.apiUrl });
    if (isDirectory(a.file)) {
      // A folder: every ADM master inside it, one preset and profile for all.
      if (a.programme !== null) deps.stderr("note: --programme ignored for a folder — each master converts its first programme\n");
      return await runConvertBatch({ dir: a.file, preset: a.preset, profile: a.profile, out: a.out, json: a.json, normalization: a.normalization }, sdk, { stdout: deps.stdout, stderr: deps.stderr, terminal: deps.terminal, env });
    }

    // ── pre-flight: nothing is uploaded until all of this passes ──────────
    let sizeBytes: number;
    try { sizeBytes = statSync(a.file).size; } catch { throw new CliExit(EXIT.preflight, `${a.file} could not be read`); }
    let info: BwfInfo;
    try { info = await sdk.files.inspect(a.file); } catch (err) {
      if (err instanceof ApiError) throw new CliExit(EXIT.preflight, `${a.file} is not a WAV/RF64/BW64 file`);
      throw err;
    }
    if (!info.isAdm && (info.ambisonicOrder ?? null) === null) throw new CliExit(EXIT.preflight, `${a.file} carries no ADM metadata and is not ambisonic (4, 9 or 16 channels) — this is a plain WAV`);
    const source = chooseSource(info, a.normalization, a.file, deps.stderr);
    if (source && !presetAllowedForOrder(a.preset, info.ambisonicOrder)) {
      throw new CliExit(EXIT.usage, `${a.preset} needs a 3OA source — ${basename(a.file)} is ${info.ambisonicOrder}OA; use --preset esfera or youtube`);
    }
    const usage = await sdk.usage.get();
    const minutes = info.durationSec / 60;
    if (minutes > usage.limits.perFileMinutes) {
      throw new CliExit(EXIT.preflight, `${a.file} is ${Math.ceil(minutes)} minutes — over the ${usage.limits.perFileMinutes}-minute limit`);
    }
    if (sizeBytes > usage.limits.perFileBytes) {
      throw new CliExit(EXIT.preflight, `${a.file} is ${fmtBytes(sizeBytes)} — over the ${fmtBytes(usage.limits.perFileBytes)} limit for one file`);
    }
    const programme = chooseProgramme(info, a.programme, a.file, deps.stderr);
    const out = a.out ?? join(dirname(a.file), basename(a.file).replace(AUDIO_FILE, "") + ".iamf");

    // ── live stages ───────────────────────────────────────────────────────
    const rows: StageRow[] = [
      { state: "active", label: "uploading", bar: { pct: 0 }, suffix: fmtBytes(sizeBytes) },
      { state: "pending", label: "analysed" },
      { state: "pending", label: "encoding" },
      { state: "pending", label: "ready" },
    ];
    const live = !a.json;
    const spinner = createSpinner({ write: deps.stderr }, deps.terminal, (f) => theme.brand(f));
    const draw = () => { if (live) spinner.update(stages(theme, rows.filter((r) => r.state === "active"), width)); };
    const settle = (i: number, detail: string) => {
      rows[i] = { state: "done", label: rows[i].label.replace(/ing$/, "ed").replace("uploaded", "uploaded"), detail };
      if (live) spinner.stop(stages(theme, [rows[i]], width));
    };
    if (live) {
      deps.stdout(renderConvertLive(theme, width, {
        env, file: basename(a.file), out: basename(out),
        source: info, stages: [], id: undefined,
      }).replace(/\n\s*\n\s*$/, "\n") + "\n");
    }

    const startedUpload = Date.now();
    draw();
    spinnerRef = spinner;
    const job = await sdk.conversions.create({
      file: a.file, preset: a.preset as (typeof PRESETS)[number], profile: a.profile as never, programme, source,
      onUploadProgress: (p) => { rows[0] = { ...rows[0], bar: { pct: (p.sent / p.total) * 100 } }; draw(); },
    });
    setCurrentJob(job.id);
    if (live) deps.stderr(`  ${theme.data(job.id)}${theme.faint("   ·   ^C detaches, the job keeps running")}\n`);
    const upSec = (Date.now() - startedUpload) / 1000;
    settle(0, `${fmtBytes(sizeBytes)} in ${fmtClock(upSec)}${upSec > 0 ? ` · ${fmtBytes(sizeBytes / upSec)}/s` : ""}`);
    rows[0].label = "uploaded";

    rows[1] = { state: "active", label: "analysing", detail: `reading the ${sourceLabel(info)}` }; draw();
    const analysed = await job.wait({ until: "analyzed", onProgress: () => draw() });
    settle(1, analysed.objectCount !== null ? `${analysed.outputChannels ?? info.channels} ch · ${analysed.objectCount} objects` : `${info.channels} ch`);
    rows[1].label = "analysed";

    const startedEncode = Date.now();
    rows[2] = { state: "active", label: "encoding", bar: { pct: 0 }, suffix: a.profile ?? a.preset }; draw();
    const done: Conversion = await job.wait({
      onProgress: (c) => { rows[2] = { ...rows[2], bar: { pct: c.progress }, suffix: `${c.outputProfile ?? c.profile}${c.stage ? ` · ${c.stage}` : ""}` }; draw(); },
    });
    const encodeSec = (Date.now() - startedEncode) / 1000;
    settle(2, `${done.outputProfile ?? "—"} · ${fmtClock(encodeSec)}`);
    rows[2].label = "encoded";

    const written = await job.download(out);
    rows[3] = { state: "done", label: "ready" };
    if (live) spinner.stop(stages(theme, [rows[3]], width));

    if (a.json) {
      deps.stdout(JSON.stringify({ id: done.id, output: written.path, bytes: written.bytes, outputProfile: done.outputProfile, durationSec: done.outputDurationSec }) + "\n");
      return EXIT.ok;
    }
    deps.stdout("\n" + renderConvertReady(theme, width, { env, file: basename(a.file), out, conversion: done, encodeSec, uploadDetail: rows[0].detail, now: deps.now() }).split("\n").slice(3).join("\n") + "\n");
    return EXIT.ok;
  } catch (err) {
    spinnerRef?.cancel();
    if (err instanceof CliExit) { deps.stderr(`error: ${err.message}\n`); return err.code; }
    if (err instanceof ApiError) {
      deps.stderr(renderError(theme, width, {
        env, command: "convert", file: a ? basename(a.file) : undefined,
        title: err.title.toLowerCase(), status: err.status, slug: err.slug, detail: err.detail, requestId: err.requestId,
        writable: err.slug === "profile-not-writable" || err.slug === "invalid-profile" ? PROFILE_IDS.filter((p) => p !== "base-advanced") : undefined,
        exitCode: EXIT.refused,
      }) + "\n");
      return EXIT.refused;
    }
    if (err instanceof ConversionStalledError) { deps.stderr(`error: ${err.message}\n`); return EXIT.failed; }
    if (err instanceof ConversionFailedError) { deps.stderr(`error: conversion failed — ${err.conversion.errorMessage ?? "no reason given"}\n`); return EXIT.failed; }
    if (err instanceof UploadError) { deps.stderr(`error: ${err.message}\n`); return EXIT.failed; }
    deps.stderr(`error: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  } finally {
    spinnerRef?.cancel();
  }
}
