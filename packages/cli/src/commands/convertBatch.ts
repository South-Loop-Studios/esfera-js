/**
 * `esfera convert <folder>` — every ADM master in the folder, with one preset and
 * profile, at most the team's concurrency (for the key's mode) in flight at once. One line per
 * master as it finishes, a summary, exit 0 only when every one is ready.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ApiError, ConversionFailedError, type BwfInfo, type Esfera, type SourceNormalization, presetAllowedForOrder } from "@esfera/sdk";
import { chooseSource } from "./convert.js";
import { EXIT, CliExit, type ExitCode, apiErrorLine } from "../exit.js";
import { fmtBytes, heading, makeTheme, renderJobLine, type Env, type Terminal } from "../ui/index.js";
import { AUDIO_FILE } from "../audioFiles.js";


export interface BatchArgs { dir: string; preset: string; profile?: string; out: string | null; json: boolean; normalization?: SourceNormalization }
export interface BatchIO { stdout: (s: string) => void; stderr: (s: string) => void; terminal: Terminal; env: Env }

interface Master { file: string; info: BwfInfo; out: string; source?: { normalization: SourceNormalization } }
interface Result { file: string; ok: boolean; id?: string; output?: string; bytes?: number; outputProfile?: string | null; reason?: string }

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export async function runConvertBatch(a: BatchArgs, sdk: Pick<Esfera, "files" | "usage" | "conversions">, io: BatchIO): Promise<ExitCode> {
  const theme = makeTheme(io.terminal);
  const width = io.terminal.width;
  const names = readdirSync(a.dir).filter((n) => AUDIO_FILE.test(n)).sort();
  if (names.length === 0) throw new CliExit(EXIT.preflight, `${a.dir} has no WAV/RF64/BW64 files`);
  const outDir = a.out ?? a.dir;
  if (!isDirectory(outDir)) throw new CliExit(EXIT.usage, `-o must be a folder when converting a folder: ${outDir}`);
  const usage = await sdk.usage.get();

  // ── pre-flight per master: the ones that cannot go are named, the rest proceed ──
  const masters: Master[] = [];
  for (const n of names) {
    const file = join(a.dir, n);
    let info: BwfInfo;
    try { info = await sdk.files.inspect(file); } catch (err) {
      if (err instanceof ApiError) { io.stderr(`skip: ${n} is not a WAV/RF64/BW64 file\n`); continue; }
      throw err;
    }
    if (!info.isAdm && (info.ambisonicOrder ?? null) === null) { io.stderr(`skip: ${n} — no ADM metadata and not ambisonic (4, 9 or 16 channels)\n`); continue; }
    let source: Master["source"];
    try { source = chooseSource(info, a.normalization, file, io.stderr); } catch (err) {
      if (err instanceof CliExit && info.isAdm) { io.stderr(`note: --normalization ignored for ${n} (ADM)\n`); } else if (err instanceof CliExit) { io.stderr(`skip: ${n} — ${err.message}\n`); continue; } else throw err;
    }
    if (source && !presetAllowedForOrder(a.preset, info.ambisonicOrder)) { io.stderr(`skip: ${n} — ${a.preset} needs a 3OA source (${info.ambisonicOrder}OA); use esfera or youtube\n`); continue; }
    const minutes = info.durationSec / 60;
    if (minutes > usage.limits.perFileMinutes) { io.stderr(`skip: ${n} is ${Math.ceil(minutes)} minutes — over the ${usage.limits.perFileMinutes}-minute limit\n`); continue; }
    const size = statSync(file).size;
    if (size > usage.limits.perFileBytes) { io.stderr(`skip: ${n} is ${fmtBytes(size)} — over the ${fmtBytes(usage.limits.perFileBytes)} limit for one file\n`); continue; }
    masters.push({ file, info, source, out: join(outDir, n.replace(AUDIO_FILE, "") + ".iamf") });
  }
  if (masters.length === 0) throw new CliExit(EXIT.preflight, `nothing to convert in ${a.dir}`);

  const limit = Math.max(1, usage.limits.concurrent);
  if (!a.json) {
    io.stdout(heading(theme, width, "convert", `${basename(a.dir) || a.dir}  →  ${masters.length} master${masters.length === 1 ? "" : "s"} · ${Math.min(limit, masters.length)} at a time`) + "\n\n");
  }

  // ── a small worker pool: `limit` masters in flight, each create → wait → download ──
  const results: Result[] = [];
  const queue = [...masters];
  const one = async (m: Master): Promise<void> => {
    let r: Result;
    try {
      const job = await sdk.conversions.create({ file: m.file, preset: a.preset, profile: a.profile ?? "auto", ...(m.source ? { source: m.source } : {}) } as Parameters<Esfera["conversions"]["create"]>[0]);
      const done = await job.wait({});
      const written = await job.download(m.out);
      r = { file: m.file, ok: true, id: done.id, output: written.path, bytes: written.bytes, outputProfile: done.outputProfile };
      if (!a.json) io.stdout(renderJobLine(theme, width, { id: done.id, out: m.out, ok: true, profile: done.outputProfile, bytes: written.bytes }) + "\n");
    } catch (err) {
      const reason = err instanceof ConversionFailedError ? (err.conversion.errorMessage ?? "no reason given")
        : err instanceof ApiError ? apiErrorLine(err)
        : err instanceof Error ? err.message : String(err);
      r = { file: m.file, ok: false, reason };
      if (!a.json) io.stdout(renderJobLine(theme, width, { id: "", out: m.out, ok: false, reason }).replace(/^(\S+)  · /, "$1 ") + "\n");
    }
    results.push(r);
    if (a.json) io.stdout(JSON.stringify(r) + "\n");
  };
  const worker = async () => { for (let m = queue.shift(); m; m = queue.shift()) await one(m); };
  await Promise.all(Array.from({ length: Math.min(limit, masters.length) }, worker));

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  if (!a.json) {
    const mark = failed ? theme.danger("✗") : theme.success("✓");
    io.stdout(`\n${mark} ${ok} of ${results.length} ready${failed ? ` · ${failed} failed` : ""}\n`);
  }
  return failed ? EXIT.failed : EXIT.ok;
}
