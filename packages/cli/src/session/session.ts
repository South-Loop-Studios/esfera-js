/**
 * The interactive session: one Screen, one key loop, a JobTracker for the
 * conversions that run behind the prompt. `runSession` touches nothing global;
 * `defaultSessionDeps` is the only place that wires `process`, the filesystem
 * and the raw terminal.
 */
import { hostname as osHostname, homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ApiError, type BwfInfo, type Esfera, type PresetsResponse, type Usage } from "@esfera/sdk";
import { configDir as defaultConfigDir } from "../credentials.js";
import { environmentLabel, keyIdOf, modeOf, resolveCredentials, type ResolvedCredentials } from "../context.js";
import { EXIT, type ExitCode } from "../exit.js";
import { openUrl, revealPath } from "../open.js";
import { defaultLoginDeps, runLogin, type LoginDeps } from "../commands/login.js";
import { defaultLogoutDeps, runLogout, type LogoutDeps } from "../commands/logout.js";
import {
  eyebrow, fit, heading, ledger, renderConversions, renderConvertLive, renderConvertReady, renderError, renderPresets, renderUsage,
  type Env, type Terminal, type Theme,
} from "../ui/index.js";
import { MAX_WIDTH, MIN_WIDTH } from "../ui/tty.js";
import { stages } from "../ui/parts.js";
import { jobRows } from "./jobRows.js";
import { parseCommand, renderSessionHelp, VOCABULARY } from "./commands.js";
import { editorInit, editorReduce, type EditorState } from "./editor.js";
import { flowInit, flowInspected, flowReduce, renderFlow, type FlowDeps, type FlowState, flowScanned, type StartChoices, type BatchFile } from "./convertFlow.js";
import { JobTracker, type QueuedConversion } from "./jobs.js";
import type { KeyEvent } from "./keys.js";
import { completePath, pickerSetCompletions } from "./picker.js";
import { Screen } from "./screen.js";
import { bellEnabled, loadConfig, loadRecent, rememberRecent } from "./store.js";
import { openRawTerminal } from "./tty.js";
import { AUDIO_FILE } from "../audioFiles.js";

export interface SessionDeps {
  terminal: Terminal;
  theme: Theme;
  /** `suspend`/`resume` leave and re-enter raw mode around cooked-mode commands; `close` is idempotent. */
  tty: { write(s: string): void; columns: number; rows?: number; keys: AsyncIterable<KeyEvent>; suspend(): void; resume(): void; close(): void };
  env: Record<string, string | undefined>;
  configDir: string;
  argv: string[];
  sdk: (opts: { apiKey: string; baseUrl: string }) => Esfera;
  fs: { readdir(dir: string): string[]; isDir(p: string): boolean; stat(path: string): { size: number } | null };
  open: (url: string) => Promise<boolean>;
  reveal: (path: string) => Promise<boolean>;
  login: (deps: LoginDeps) => Promise<ExitCode>;
  logout: (deps: LogoutDeps) => Promise<ExitCode>;
  bell: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  hostname: () => string;
}

const CTRL_C_WINDOW_MS = 2000;
/** How long quitting waits for a download that is mid-write before it returns anyway. */
const IDLE_BOUND_MS = 250;
/** A command still running after this long gets the "working… ^C cancels" hint. */
const BUSY_HINT_DELAY_MS = 150;
/** Transcript lines one wheel notch moves. */
const WHEEL_LINES = 3;
/** Files a folder batch considers. */
const HOME_LINE = "convert · presets · usage · list · get <id> · help · quit";

const clampWidth = (columns: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, columns));
/** Drop the banner (2 lines) and heading (1 line) the one-shot renderers lead with. */
const body = (s: string) => s.split("\n").slice(3).join("\n");

type Mode = "editing" | "flow";

export async function runSession(deps: SessionDeps): Promise<ExitCode> {
  const { theme, tty } = deps;
  let width = clampWidth(tty.columns);
  const screen = new Screen((s) => tty.write(s), theme, width, tty.columns, tty.rows ?? 0);
  /** The session's lifetime: aborted on shutdown, it stops the job tracker and every draw. */
  const life = new AbortController();
  const closed = () => life.signal.aborted;
  /** Lines printed while a cooked-mode command (login/logout) owns the terminal wait here. */
  let held: string[] | null = null;
  const print = (s: string) => {
    if (closed()) return;
    if (held) { held.push(s); return; }
    screen.print(s);
  };

  // ── sign in ────────────────────────────────────────────────────────────
  // login/logout run outside raw mode with their own defaults: the masked
  // prompt, real stdin, and a normal ^C — so the paste fallback (404 hosts) works.
  const resolve = () => resolveCredentials(deps.env, deps.configDir);
  // `login` inside a session signs in again to the environment the session is on
  // (a staging session must not quietly try production); ESFERA_API_URL still wins.
  const loginDeps = (): LoginDeps => defaultLoginDeps({
    env: deps.env.ESFERA_API_URL === undefined && creds ? { ...deps.env, ESFERA_API_URL: creds.apiUrl } : deps.env,
    configDir: deps.configDir, terminal: deps.terminal, sdk: deps.sdk,
    stdout: (s) => tty.write(s), stderr: (s) => tty.write(s),
    open: deps.open, hostname: deps.hostname, sleep: deps.sleep, now: deps.now,
  });
  let creds: ResolvedCredentials | null = resolve();
  if (!creds) {
    // The raw terminal is not open yet: nothing to suspend.
    const code = await deps.login(loginDeps());
    if (code !== EXIT.ok) { tty.close(); return code; }
    creds = resolve();
    if (!creds) { tty.close(); return EXIT.refused; }
  }

  let sdk = deps.sdk({ apiKey: creds.apiKey, baseUrl: creds.apiUrl });
  let env: Env = environmentLabel(creds.apiUrl);
  let keyId = keyIdOf(creds.apiKey) ?? "esfera";

  const config = loadConfig(deps.configDir);
  const home = deps.env.HOME ?? homedir();
  let mode: Mode = "editing";
  let editor: EditorState = editorInit([]);
  let flow: FlowState | null = null;
  let presets: PresetsResponse | null = null;
  let usage: Usage | null = null;
  let hint = "";
  let lastCtrlC: number | null = null;
  let done: ExitCode | null = null;
  /** A command in flight: keys other than ^C are dropped (never queued), ^C aborts it. */
  let busy: { ac: AbortController; label: string; slow: boolean } | null = null;
  let failure: { err: unknown } | null = null;
  let wakeLoop: () => void = () => {};
  const stopped = new Promise<null>((r) => { wakeLoop = () => r(null); });
  const outputs = new Map<string, string>();
  const order: string[] = [];

  const flowDeps = (): FlowDeps => ({
    presets: presets!, recent: loadRecent(deps.configDir), usage: usage!, running: tracker.running().length, home,
  });

  const redraw = () => {
    if (closed() || held) return;
    const status = `${keyId} · ${env.label} · ${modeOf(creds!.apiKey)} · ${env.host} · ${tracker.statusText()} · help ^C quit`;
    const busyHint = busy?.slow ? "working… ^C cancels" : "";
    // Every running job gets a stage rail above the box: passed stages ticked, the
    // current one with a bar (encoding) or a note; jobs separated by a blank row.
    const jobLines = tracker.running().flatMap((j, i) => [...(i ? [""] : []), ...stages(theme, jobRows(j), width).split("\n")]);
    if (mode === "editing") {
      const t = editor.text;
      const text = busy?.slow ? t : t.slice(0, editor.cursor) + "▏" + t.slice(editor.cursor);
      screen.live({ live: jobLines, prompt: text, promptHint: hint || busyHint, status });
    } else {
      const flowLines = flow && presets && usage ? renderFlow(theme, width, flow, flowDeps()) : [];
      const live = [...jobLines, ...(jobLines.length && flowLines.length ? [""] : []), ...flowLines];
      screen.live({ live, prompt: "", promptHint: hint || busyHint || (mode === "flow" ? "Esc back" : ""), status });
    }
  };

  const tracker = new JobTracker({
    sdk, sleep: deps.sleep, now: deps.now, bell: deps.bell, bellOn: bellEnabled(config, deps.env, deps.argv),
    onLine: print, onChange: redraw, theme, width, signal: life.signal,
    limit: () => usage?.limits.concurrent ?? 1,
    onCreated: (job, item) => {
      try {
        rememberRecent(deps.configDir, {
          path: item.file, sizeBytes: item.sizeBytes, channels: item.info.channels, durationSec: item.info.durationSec,
          isAdm: item.info.isAdm, ambisonicOrder: item.info.ambisonicOrder ?? null, objectCount: item.info.objectCount,
        }, new Date(deps.now()), config.recentLimit);
      } catch { /* a recent list that will not save must not lose the job */ }
      outputs.set(job.id, item.out); order.push(job.id);
      const live = renderConvertLive(theme, width, { env, file: basename(item.file), out: basename(item.out), source: item.info, stages: [], id: job.id });
      print(heading(theme, width, "convert", `${basename(item.file)}  →  ${basename(item.out)}`) + "\n" + body(live));
    },
  });

  const shutdown = (code: ExitCode) => {
    if (done !== null) return;
    held = null;
    try {
      screen.exit();
      const ids = tracker.ids();
      if (ids.length) screen.print(ids.map((id) => `jobs keep running · esfera conversions get ${id}`).join("\n"));
    } catch { /* the terminal is going away; restoring it matters more */ }
    life.abort();
    busy?.ac.abort();
    tty.close();
    done = code;
    wakeLoop();
  };
  const fail = (err: unknown) => {
    if (failure === null) failure = { err };
    wakeLoop();
  };

  const apiFailure = (err: unknown, command: string): string => {
    if (err instanceof ApiError) {
      return body(renderError(theme, width, {
        env, command, title: err.title.toLowerCase(), status: err.status, slug: err.slug, detail: err.detail, requestId: err.requestId, exitCode: EXIT.refused,
      }));
    }
    return `  ${theme.danger("✗")} ${theme.fg(err instanceof Error ? err.message : String(err))}`;
  };

  /** Run a command behind the prompt. ^C aborts it; a normal finish forgets any earlier ^C. */
  const background = (label: string, fn: (signal: AbortSignal) => Promise<void>) => {
    const ac = new AbortController();
    const task = { ac, label, slow: false };
    busy = task;
    // Only say "working…" for a command that is actually slow; instant ones never flash it.
    void deps.sleep(BUSY_HINT_DELAY_MS).then(() => { if (busy === task) { task.slow = true; redraw(); } }).catch(() => {});
    void (async () => {
      try {
        await fn(ac.signal);
      } catch (err) {
        if (!ac.signal.aborted) fail(err);
      } finally {
        if (busy === task) busy = null;
        if (!ac.signal.aborted) { lastCtrlC = null; hint = ""; }
        try { redraw(); } catch (err) { fail(err); }
      }
    })();
  };

  /** Run a cooked-mode command: raw mode off, its own prompt and ^C, then raw mode back and a redraw. */
  const outside = async <T>(fn: () => Promise<T>): Promise<T> => {
    screen.clear();
    held = [];
    tty.suspend();
    try {
      return await fn();
    } finally {
      const lines = held ?? [];
      held = null;
      if (!closed()) {
        tty.resume();
        for (const l of lines) print(l);
      }
    }
  };

  const defaultOutputName = (file: string) => basename(file).replace(AUDIO_FILE, "") + ".iamf";

  // ── commands ───────────────────────────────────────────────────────────
  const startConversion = (raw: StartChoices) => {
    flow = null; mode = "editing"; hint = "";
    if (raw.batch) {
      // Every master of the folder, each to <name>.iamf inside the output folder.
      if (!deps.fs.isDir(raw.out)) { print(`  ${theme.danger("✗")} ${theme.fg(`${raw.out} is not a folder`)}`); return; }
      tracker.enqueue(raw.batch.files.map((f): QueuedConversion => ({
        file: f.path, out: join(raw.out, defaultOutputName(f.path)), preset: raw.preset, profile: raw.profile, info: f.info, sizeBytes: f.sizeBytes,
        ...(f.info.ambisonicOrder && raw.normalization ? { normalization: raw.normalization } : {}),
      })));
      return;
    }
    // "~/Masters" or "." as the output means: the default name, in that folder.
    const out = deps.fs.isDir(raw.out) ? join(raw.out, defaultOutputName(raw.file)) : raw.out;
    tracker.enqueue([{ file: raw.file, out, preset: raw.preset, profile: raw.profile, info: raw.info, sizeBytes: raw.sizeBytes, ...(raw.info.ambisonicOrder && raw.normalization ? { normalization: raw.normalization } : {}) }]);
  };

  const openFlow = async (signal: AbortSignal) => {
    try { usage = await untilAborted(sdk.usage.get(), signal); } catch (err) { if (signal.aborted) throw err; /* keep the one we have */ }
    flow = flowInit(flowDeps()); mode = "flow"; hint = "";
  };

  const runCommand = async (text: string, signal: AbortSignal) => {
    const cmd = parseCommand(text);
    const call = <T>(p: Promise<T>) => untilAborted(p, signal);
    try {
      switch (cmd.name) {
        case "convert": await openFlow(signal); return;
        case "presets": {
          const p = await call(sdk.presets.get());
          print(heading(theme, width, "presets") + "\n" + body(renderPresets(theme, width, { env, presets: p })));
          return;
        }
        case "usage": {
          usage = await call(sdk.usage.get());
          print(heading(theme, width, "usage", `${usage.plan} plan`) + "\n" + body(renderUsage(theme, width, { env, usage, now: new Date(deps.now()) })));
          return;
        }
        case "list": {
          const page = await call(sdk.conversions.list({ status: cmd.status, page: 1, pageSize: 10 }));
          if (page.items.length === 0) {
            print(heading(theme, width, "conversions") + "\n\n  " + theme.dim("No conversions yet — `convert` makes the first."));
          } else {
            print(heading(theme, width, "conversions") + "\n" + body(renderConversions(theme, width, {
              env, items: page.items, total: page.total ?? page.items.length, page: page.page ?? 1, pageSize: page.pageSize ?? 10, now: new Date(deps.now()),
            })));
          }
          return;
        }
        case "get": {
          const c = await call(sdk.conversions.get(cmd.id));
          if (c.status === "ready") {
            print(heading(theme, width, "convert", `${c.name}  →  ${outputs.get(c.id) ?? "—"}`) + "\n" + body(renderConvertReady(theme, width, {
              env, file: c.name, out: outputs.get(c.id) ?? "—", conversion: c, now: new Date(deps.now()),
            })));
          } else {
            print([
              heading(theme, width, "conversion", c.name), "",
              ledger(theme, [
                ["id", theme.data(c.id)],
                ["status", theme.fg(c.status), c.status === "error" ? "" : `${Math.round(c.progress)}%${c.stage ? ` · ${c.stage}` : ""}`],
                ["profile", theme.fg(c.outputProfile ?? c.profile)],
                ...(c.errorMessage ? [["error", theme.danger(c.errorMessage)] as [string, string]] : []),
              ], width),
            ].join("\n"));
          }
          return;
        }
        case "open": {
          const running = new Set(tracker.ids());
          const id = cmd.id ?? [...order].reverse().find((i) => !running.has(i) && outputs.has(i) && deps.fs.stat(outputs.get(i)!));
          const path = id ? outputs.get(id) : undefined;
          if (!path) { print(`  ${theme.dim("no output to reveal yet")}`); return; }
          await call(deps.reveal(path));
          print(`  ${theme.dim("revealed")} ${theme.fg(path)}`);
          return;
        }
        case "help": print(renderSessionHelp(theme, width)); return;
        case "quit": shutdown(EXIT.ok); return;
        case "login": {
          const code = await outside(() => deps.login(loginDeps()));
          const next = code === EXIT.ok ? resolve() : null;
          if (next) {
            creds = next; sdk = deps.sdk({ apiKey: next.apiKey, baseUrl: next.apiUrl });
            env = environmentLabel(next.apiUrl); keyId = keyIdOf(next.apiKey) ?? "esfera";
          }
          return;
        }
        case "logout": {
          const code = await outside(() => deps.logout(defaultLogoutDeps({
            env: deps.env, configDir: deps.configDir, terminal: deps.terminal,
            stdout: (s) => tty.write(s), stderr: (s) => tty.write(s),
          })));
          if (code === EXIT.ok && !resolve()) shutdown(EXIT.ok);
          return;
        }
        case "unknown":
          print(`  ${theme.danger("✗")} ${theme.fg(`unknown command '${cmd.text}'`)} ${theme.dim("— try help")}`);
          return;
      }
    } catch (err) {
      if (signal.aborted) { print(`  ${theme.danger("✗")} ${theme.fg(`${cmd.name} cancelled`)}`); return; }
      print(apiFailure(err, cmd.name));
    }
  };

  const onEditorKey = (e: KeyEvent) => {
    const [next, eff] = editorReduce(editor, e);
    editor = next;
    if (eff?.kind === "submit") {
      if (eff.text) { const text = eff.text; background(parseCommand(text).name, (signal) => runCommand(text, signal)); }
    } else if (eff?.kind === "complete") {
      const matches = VOCABULARY.filter((w) => w.startsWith(editor.text.trim()) && editor.text.trim() !== "");
      if (matches.length === 1) { editor = { ...editor, text: matches[0]!, cursor: matches[0]!.length }; }
    }
  };

  const onFlowKey = (e: KeyEvent) => {
    if (!flow) { mode = "editing"; return; }
    const [next, eff] = flowReduce(flow, e, flowDeps());
    flow = next;
    if (!eff) return;
    switch (eff.kind) {
      case "cancel": flow = null; mode = "editing"; return;
      case "complete":
        if (flow.picker) flow = { ...flow, picker: pickerSetCompletions(flow.picker, completePath(eff.text, deps.fs, home)) };
        return;
      case "inspect": {
        const path = eff.path;
        if (deps.fs.isDir(path)) {
          // A folder: every audio file inside it is inspected; the ADM masters become the batch.
          background("scan", async (signal) => {
            let names: string[];
            try { names = deps.fs.readdir(path).filter((n) => AUDIO_FILE.test(n)).sort(); } catch { if (flow) flow = flowScanned(flow, { ok: false, reason: `${path} could not be read` }, flowDeps()); return; }
            const files: BatchFile[] = [];
            let skipped = 0;
            for (const n of names) {
              if (signal.aborted) return;
              const full = join(path, n);
              const st = deps.fs.stat(full);
              if (!st) { skipped++; continue; }
              try {
                const info = await untilAborted(sdk.files.inspect(full), signal);
                if (info.isAdm || info.ambisonicOrder) files.push({ path: full, info, sizeBytes: st.size }); else skipped++;
              } catch (err) {
                if (signal.aborted) throw err;
                skipped++;
              }
            }
            if (flow) flow = flowScanned(flow, { ok: true, dir: path, files, skipped }, flowDeps());
          });
          return;
        }
        background("inspect", async (signal) => {
          let r: Parameters<typeof flowInspected>[1];
          try {
            const st = deps.fs.stat(path);
            if (!st) r = { ok: false, reason: `${path} could not be read` };
            else r = { ok: true, info: await untilAborted(sdk.files.inspect(path), signal), sizeBytes: st.size };
          } catch (err) {
            if (signal.aborted) return;
            r = { ok: false, reason: err instanceof ApiError ? "this is not a WAV/RF64 file" : err instanceof Error ? err.message : String(err) };
          }
          if (flow) flow = flowInspected(flow, r, flowDeps());
        });
        return;
      }
      case "start": startConversion(eff.choices); return;
    }
  };

  const onKey = (e: KeyEvent) => {
    if (e.kind === "resize") {
      width = clampWidth(e.columns); screen.resize(width, e.columns, e.rows ?? tty.rows ?? 0); redraw();
      return;
    }
    if (e.kind === "ctrl" && e.ch === "c") {
      const t = deps.now();
      if (lastCtrlC !== null && t - lastCtrlC <= CTRL_C_WINDOW_MS) { shutdown(EXIT.interrupted); return; }
      lastCtrlC = t;
      if (busy) busy.ac.abort();
      else if (mode === "flow") { flow = null; mode = "editing"; }
      else editor = editorInit(editor.history);
      hint = "^C again to quit";
      redraw();
      return;
    }
    // Scrolling the transcript works at any time, even while a command runs.
    if (e.kind === "wheel") { screen.scrollBy(e.dir === "up" ? WHEEL_LINES : -WHEEL_LINES); return; }
    if (e.kind === "pageup" || e.kind === "pagedown") { screen.scrollPage(e.kind === "pageup" ? 1 : -1); return; }
    if (busy) return; // working: keys are dropped, never replayed later
    lastCtrlC = null; hint = "";
    if (mode === "editing") {
      if (e.kind === "ctrl" && e.ch === "d" && editor.text === "") { shutdown(EXIT.ok); return; }
      onEditorKey(e);
    } else if (mode === "flow") onFlowKey(e);
    if (done === null) redraw();
  };

  // ── the screen and the loop ────────────────────────────────────────────
  const keys = tty.keys[Symbol.asyncIterator]();
  try {
    screen.banner("session");
    print(`  ${theme.dim(HOME_LINE)}`);
    print("");
    try {
      [presets, usage] = await Promise.all([sdk.presets.get(), sdk.usage.get()]);
      redraw();
    } catch (err) {
      print(apiFailure(err, "session"));
      shutdown(err instanceof ApiError ? EXIT.refused : EXIT.failed);
    }
    while (done === null && failure === null) {
      const r = await Promise.race([keys.next(), stopped]);
      if (r === null || r.done) break;
      onKey(r.value);
    }
  } catch (err) {
    fail(err);
  } finally {
    if (failure !== null) shutdown(EXIT.failed);
    else if (done === null) shutdown(EXIT.ok);
    void keys.return?.()?.catch(() => {});
  }
  // Give a download that is mid-write a moment; the tracker prints nothing now either way.
  await tracker.idle(IDLE_BOUND_MS);
  if (failure !== null) {
    const { err } = failure as { err: unknown };
    try { tty.write(`error: ${err instanceof Error ? err.message : String(err)}\n`); } catch { /* nowhere left to say it */ }
    return EXIT.failed;
  }
  return done!;
}

/** Resolves as `p` does, or rejects with an AbortError the moment `signal` aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

// ── production wiring ────────────────────────────────────────────────────

/** Opens the raw terminal when iteration starts, so sign-in before the loop keeps a normal ^C. */
function lazyTty(): SessionDeps["tty"] {
  let term: ReturnType<typeof openRawTerminal> | null = null;
  let closed = false;
  let wake: (() => void) | null = null;
  return {
    write: (s) => void process.stdout.write(s),
    get columns() { return process.stdout.columns || 80; },
    get rows() { return process.stdout.rows || 24; },
    suspend: () => term?.suspend(),
    resume: () => term?.resume(),
    close: () => {
      if (closed) return;
      closed = true;
      term?.close(); term = null;
      wake?.();
    },
    keys: {
      [Symbol.asyncIterator](): AsyncIterator<KeyEvent> {
        const queue: KeyEvent[] = [];
        if (!closed) {
          const t = (term = openRawTerminal(process.stdin, process.stdout));
          t.onKey((e) => { queue.push(e); wake?.(); });
        }
        return {
          async next() {
            while (queue.length === 0) {
              if (term === null) return { done: true, value: undefined };
              await new Promise<void>((r) => { wake = r; });
            }
            return { done: false, value: queue.shift()! };
          },
          async return() { return { done: true, value: undefined }; },
        };
      },
    },
  };
}

/** Wire ^C (SIGINT, since login runs outside raw mode) to cancel a browser sign-in instead of killing the session. */
async function withInterrupt<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);
  try { return await fn(ac.signal); } finally { process.off("SIGINT", onSigint); }
}

export function defaultSessionDeps(partial: Pick<SessionDeps, "terminal" | "theme" | "env" | "argv"> & { configDir?: string; sdk: SessionDeps["sdk"] }): SessionDeps {
  return {
    ...partial,
    configDir: partial.configDir ?? defaultConfigDir(partial.env),
    tty: lazyTty(),
    fs: {
      readdir: (d) => readdirSync(d),
      isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
      stat: (p) => { try { const s = statSync(p); return s.isFile() ? { size: s.size } : null; } catch { return null; } },
    },
    open: (url) => openUrl(url, process.platform),
    reveal: (path) => revealPath(path, process.platform),
    login: (d) => withInterrupt((signal) => runLogin([], { ...d, signal })),
    logout: (d) => runLogout([], d),
    bell: () => void process.stdout.write("\x07"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    hostname: osHostname,
  };
}
