/** What every command needs: where output goes, which terminal, which key. */
import type { Esfera } from "@esfera/sdk";
import { ApiError } from "@esfera/sdk";
import { configDir as defaultConfigDir } from "../credentials.js";
import { resolveCredentials, environmentLabel } from "../context.js";
import { EXIT, CliExit, type ExitCode } from "../exit.js";
import { makeTheme, renderError, type Terminal, type Theme, type Env } from "../ui/index.js";

export interface CommandDeps {
  env: Record<string, string | undefined>;
  configDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  terminal: Terminal;
  now: () => Date;
  sdk: (opts: { apiKey: string; baseUrl: string }) => Esfera;
  /** Ask a yes/no question on the terminal. Resolves null when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean | null>;
}

/** y/N on stderr, so stdout stays clean for --json. Null when stdin is not a terminal. */
export async function terminalConfirm(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY) return null;
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function defaultCommandDeps(partial: Partial<CommandDeps> = {}): CommandDeps {
  return {
    env: process.env,
    configDir: defaultConfigDir(process.env),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    terminal: { colour: "none", width: 100, interactive: false },
    now: () => new Date(),
    sdk: () => { throw new Error("sdk factory not wired"); },
    confirm: terminalConfirm,
    ...partial,
  };
}

export interface Session {
  sdk: Esfera;
  env: Env;
  theme: Theme;
  width: number;
}

/** Resolve credentials and build the client; `not signed in` is exit 3. */
export function openSession(deps: CommandDeps): Session {
  const creds = resolveCredentials(deps.env, deps.configDir);
  if (!creds) throw new CliExit(EXIT.refused, "not signed in — run `esfera auth login`");
  return {
    sdk: deps.sdk({ apiKey: creds.apiKey, baseUrl: creds.apiUrl }),
    env: { ...environmentLabel(creds.apiUrl), user: deps.env.USER },
    theme: makeTheme(deps.terminal),
    width: deps.terminal.width,
  };
}

/** Parse `--json` plus named options with values; anything else unknown is a usage error. */
export function parseOptions(args: string[], valued: string[], usage: string): { json: boolean; opts: Record<string, string>; positional: string[] } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (valued.includes(a)) {
      if (i + 1 >= args.length) throw new CliExit(EXIT.usage, `${a} requires a value\n${usage}`);
      opts[a.replace(/^--/, "")] = args[++i];
    } else if (a.startsWith("-")) throw new CliExit(EXIT.usage, `unknown option '${a}'\n${usage}`);
    else positional.push(a);
  }
  return { json, opts, positional };
}

/** Run a command body, mapping CliExit and ApiError to exit codes and output. */
export async function runGuarded(deps: CommandDeps, command: string, body: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof CliExit) { deps.stderr(`error: ${err.message}\n`); return err.code; }
    if (err instanceof ApiError) {
      const creds = resolveCredentials(deps.env, deps.configDir);
      deps.stderr(renderError(makeTheme(deps.terminal), deps.terminal.width, {
        env: creds ? environmentLabel(creds.apiUrl) : { label: "PRODUCTION", host: "api.esfera.audio" },
        command, title: err.title.toLowerCase(), status: err.status, slug: err.slug, detail: err.detail, requestId: err.requestId, exitCode: EXIT.refused,
      }) + "\n");
      return EXIT.refused;
    }
    deps.stderr(`error: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  }
}
