/**
 * `esfera login [--key <secret>] [--json]`.
 *
 * Decision order: `--key`/positional, `$ESFERA_API_KEY`, or a non-TTY stdin
 * take the paste path (CI). Otherwise the browser device flow runs; a host
 * without the endpoint (404) falls back to the paste prompt with one note.
 */
import { hostname as osHostname } from "node:os";
import { ApiError, type Usage } from "@esfera/sdk";
import { saveCredentials, looksLikeKey, redactKey } from "../credentials.js";
import { environmentLabel, keyIdOf, DEFAULT_API_URL, apiUrlFor } from "../context.js";
import { EXIT, CliExit, type ExitCode, apiErrorLine } from "../exit.js";
import { makeTheme, renderLogin, renderDeviceCode } from "../ui/index.js";
import { startDeviceFlow, pollDeviceToken } from "../device.js";
import { openUrl } from "../open.js";
import { defaultAuthDeps, type AuthDeps } from "./auth.js";

export interface LoginDeps extends AuthDeps {
  device: { start: typeof startDeviceFlow; poll: typeof pollDeviceToken };
  open: (url: string) => Promise<boolean>;
  hostname: () => string;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Aborting it cancels a browser sign-in in progress (the session wires ^C to it). */
  signal?: AbortSignal;
}

export function defaultLoginDeps(partial: Partial<LoginDeps> = {}): LoginDeps {
  return {
    ...defaultAuthDeps(partial),
    device: { start: startDeviceFlow, poll: pollDeviceToken },
    open: (url) => openUrl(url, process.platform),
    hostname: osHostname,
    fetch: (...a) => globalThis.fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    ...partial,
  };
}

function parseLoginFlags(args: string[]): { json: boolean; key?: string; positional: string[] } {
  const positional: string[] = [];
  let json = false;
  let key: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--key") {
      const v = args[++i];
      if (!v) throw new CliExit(EXIT.usage, "--key needs a value");
      key = v;
    } else if (a.startsWith("--key=")) key = a.slice(6);
    else if (a.startsWith("-")) throw new CliExit(EXIT.usage, `unknown option '${a}'`);
    else positional.push(a);
  }
  return { json, key, positional };
}

export async function runLogin(args: string[], partial: AuthDeps & Partial<Omit<LoginDeps, keyof AuthDeps>>): Promise<ExitCode> {
  const deps = defaultLoginDeps(partial);
  try {
    const { key, positional } = parseLoginFlags(args);
    if (key || positional[0] || deps.env.ESFERA_API_KEY || !deps.stdin.isTTY) return await pasteLogin(args, deps);
    return await deviceLogin(args, deps);
  } catch (err) {
    if (deps.signal?.aborted) { deps.stderr("sign-in cancelled\n"); return EXIT.interrupted; }
    if (err instanceof CliExit) { deps.stderr(`error: ${err.message}\n`); return err.code; }
    if (err instanceof ApiError) { deps.stderr(`error: ${apiErrorLine(err)}\n`); return EXIT.refused; }
    deps.stderr(`error: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  }
}

async function deviceLogin(args: string[], deps: LoginDeps): Promise<ExitCode> {
  const { json } = parseLoginFlags(args);
  const apiUrl = deps.env.ESFERA_API_URL ?? DEFAULT_API_URL;
  const env = environmentLabel(apiUrl);
  const dd = { fetch: deps.fetch, sleep: deps.sleep, now: deps.now, signal: deps.signal };
  const start = await deps.device.start(apiUrl, deps.hostname(), dd);
  if (start === "unsupported") {
    return pasteLogin(args, deps, "note: this host has no browser sign-in yet — paste a key instead");
  }
  const url = `${start.verificationUrl}?code=${start.userCode}`;
  const opened = await deps.open(url);
  const theme = makeTheme(deps.terminal);
  deps.stderr(renderDeviceCode(theme, deps.terminal.width, { env, userCode: start.userCode, url: start.verificationUrl, opened }) + "\n");

  const result = await deps.device.poll(apiUrl, start, dd);
  if (!result.ok) {
    throw new CliExit(EXIT.refused, result.reason === "expired" ? "sign-in expired — run esfera login again" : "sign-in was denied in the browser");
  }
  let usage: Usage;
  try {
    usage = await deps.sdk({ apiKey: result.apiKey, baseUrl: apiUrl }).usage.get();
  } catch (err) {
    if (err instanceof ApiError) throw new CliExit(EXIT.refused, apiErrorLine(err));
    throw err;
  }
  saveCredentials(deps.configDir, { apiKey: result.apiKey, apiUrl, via: "device" });
  return finish(deps, json, apiUrl, result.apiKey, usage.plan);
}

function finish(deps: AuthDeps, json: boolean, apiUrl: string, key: string, plan: string): ExitCode {
  const env = environmentLabel(apiUrl);
  const keyId = keyIdOf(key) ?? redactKey(key);
  if (json) {
    deps.stdout(JSON.stringify({ keyId, apiUrl, plan }) + "\n");
    return EXIT.ok;
  }
  const theme = makeTheme(deps.terminal);
  deps.stdout(renderLogin(theme, deps.terminal.width, {
    env, keyId, plan,
    name: deps.env.USER ?? deps.env.USERNAME ?? "you",
    path: `${deps.configDir.replace(deps.env.HOME ?? "", "~")}/credentials.json`,
  }) + "\n");
  return EXIT.ok;
}

/** Paste path, shared with `auth login`: positional/env/stdin/prompt → verify → save. */
export async function pasteLogin(args: string[], deps: AuthDeps, note?: string): Promise<ExitCode> {
  const { json, key: flagKey, positional } = parseLoginFlags(args);
  if (note) deps.stderr(note + "\n");
  let key: string | undefined = flagKey ?? positional[0];
  const fromArgument = Boolean(key);
  if (!key) key = deps.env.ESFERA_API_KEY;
  if (!key && !deps.stdin.isTTY) key = (await deps.stdin.read()) ?? undefined;
  if (!key && deps.stdin.isTTY) key = (await deps.prompt("  Paste your API key · it is stored, never echoed\n  ")) ?? undefined;
  if (!key) throw new CliExit(EXIT.usage, "usage: esfera login [--key <secret>]  (reads $ESFERA_API_KEY, piped stdin, or prompts on a terminal)");
  if (fromArgument) deps.stderr("note: passing the key as an argument records it in shell history — prefer piping it to stdin\n");
  key = key.trim();
  if (!looksLikeKey(key)) throw new CliExit(EXIT.usage, `that does not look like an Esfera API key (expected esf_sk_live_v1_… or esf_sk_test_v1_…), got ${redactKey(key)}`);

  // A Sandbox key is a production key: only $ESFERA_API_URL sends it elsewhere.
  const apiUrl = apiUrlFor(key, deps.env);
  let usage: Usage;
  try {
    usage = await deps.sdk({ apiKey: key, baseUrl: apiUrl }).usage.get();
  } catch (err) {
    if (err instanceof ApiError) throw new CliExit(EXIT.refused, apiErrorLine(err));
    throw err;
  }
  saveCredentials(deps.configDir, { apiKey: key, apiUrl, via: "paste" });
  return finish(deps, json, apiUrl, key, usage.plan);
}
