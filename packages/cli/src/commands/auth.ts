/**
 * `esfera auth login [<key>] [--json]` and `esfera auth status [--json]`.
 *
 * The key comes from, in order: a positional argument (warned — it lands in
 * shell history), `$ESFERA_API_KEY`, piped stdin, or an interactive masked
 * prompt on a TTY. It is checked against the host (`usage.get`) before it is
 * saved, so a wrong-environment key never lands on disk.
 */
import type { Esfera } from "@esfera/sdk";
import { ApiError } from "@esfera/sdk";
import { configDir as defaultConfigDir, redactKey } from "../credentials.js";
import { resolveCredentials, environmentLabel, keyIdOf, modeOf } from "../context.js";
import { EXIT, CliExit, type ExitCode, apiErrorLine } from "../exit.js";
import { makeTheme, type Terminal } from "../ui/index.js";
import { runLogin } from "./login.js";

export interface AuthDeps {
  env: Record<string, string | undefined>;
  configDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: { isTTY: boolean; read: () => Promise<string | null> };
  /** Masked interactive prompt; resolves null when unavailable or empty. */
  prompt: (label: string) => Promise<string | null>;
  terminal: Terminal;
  sdk: (opts: { apiKey: string; baseUrl: string }) => Pick<Esfera, "usage">;
}

export function defaultAuthDeps(partial: Partial<AuthDeps> = {}): AuthDeps {
  return {
    env: process.env,
    configDir: defaultConfigDir(process.env),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    stdin: { isTTY: process.stdin.isTTY === true, read: readStdinLine },
    prompt: maskedPrompt,
    terminal: { colour: "none", width: 100, interactive: false },
    sdk: (opts) => { throw new Error("sdk factory not wired"); },
    ...partial,
  };
}

async function readStdinLine(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? text.split(/\r?\n/)[0].trim() : null;
}

/** Echo `•` per character; the key never appears on screen. */
async function maskedPrompt(label: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const readline = await import("node:readline");
  // Everything the prompt draws goes to stderr: stdout stays clean for --json.
  const out = (s: string) => process.stderr.write(s);
  return new Promise((resolve) => {
    out(label);
    const rl = readline.createInterface({ input: process.stdin, terminal: true });
    let value = "";
    const onKey = (ch: string) => {
      if (ch.includes("\r") || ch.includes("\n")) {
        value += ch.split(/[\r\n]/)[0];
        process.stdin.off("data", onData); process.stdin.setRawMode?.(false); out("\n"); rl.close(); resolve(value.trim() || null); return;
      }
      if (ch === "\u0003") { out("\n"); process.exit(EXIT.interrupted); }
      if (ch === "\u007f" || ch === "\b") { if (value) { value = value.slice(0, -1); out("\b \b"); } return; }
      value += ch;
      out("•".repeat([...ch].length));
    };
    const onData = (b: Buffer) => onKey(b.toString("utf8"));
    process.stdin.setRawMode?.(true);
    process.stdin.on("data", onData);
  });
}

export function parseFlags(args: string[]): { json: boolean; positional: string[] } {
  const positional: string[] = [];
  let json = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a.startsWith("-")) throw new CliExit(EXIT.usage, `unknown option '${a}'`);
    else positional.push(a);
  }
  return { json, positional };
}

export async function runAuth(args: string[], deps: AuthDeps): Promise<ExitCode> {
  const [sub, ...rest] = args;
  try {
    if (sub === "login") return await runLogin(rest, deps);
    if (sub === "status") return await status(rest, deps);
    throw new CliExit(EXIT.usage, "usage: esfera auth <login [<api-key>] | status> [--json]");
  } catch (err) {
    if (err instanceof CliExit) { deps.stderr(`error: ${err.message}\n`); return err.code; }
    if (err instanceof ApiError) { deps.stderr(`error: ${apiErrorLine(err)}\n`); return EXIT.refused; }
    deps.stderr(`error: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  }
}

async function status(args: string[], deps: AuthDeps): Promise<ExitCode> {
  const { json } = parseFlags(args);
  const creds = resolveCredentials(deps.env, deps.configDir);
  if (!creds) throw new CliExit(EXIT.refused, "not signed in — run `esfera auth login`");
  const keyId = keyIdOf(creds.apiKey) ?? redactKey(creds.apiKey);
  const env = environmentLabel(creds.apiUrl);
  if (json) {
    deps.stdout(JSON.stringify({ keyId, apiUrl: creds.apiUrl, source: creds.source }) + "\n");
    return EXIT.ok;
  }
  const theme = makeTheme(deps.terminal);
  deps.stdout(`${theme.data(keyId)}  ${theme.dim("→")}  ${theme.fg(env.host)}  ${theme.dim(`· ${env.label} · ${modeOf(creds.apiKey)} · from ${creds.source === "env" ? "$ESFERA_API_KEY" : "credentials file"}`)}\n`);
  return EXIT.ok;
}
