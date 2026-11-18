/**
 * Command routing. `dispatch()` is pure enough to test: it takes the output
 * sinks and the terminal, and returns the exit code instead of exiting.
 */
import { Esfera } from "@esfera/sdk";
import { runAuth, defaultAuthDeps } from "./commands/auth.js";
import { runLogin, defaultLoginDeps } from "./commands/login.js";
import { runLogout, defaultLogoutDeps } from "./commands/logout.js";
import { runConvert, defaultConvertDeps } from "./commands/convert.js";
import { runConversions } from "./commands/conversions.js";
import { runPresets } from "./commands/presets.js";
import { runUsage } from "./commands/usage.js";
import { runEvents } from "./commands/events.js";
import { runWebhooks } from "./commands/webhooks.js";
import { defaultCommandDeps } from "./commands/shared.js";
import { EXIT, type ExitCode } from "./exit.js";
import { banner, heading, makeTheme, type Terminal } from "./ui/index.js";
import { defaultSessionDeps, runSession } from "./session/session.js";
import { CLI_VERSION } from "./version.js";

export interface DispatchIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  terminal: Terminal;
  env: Record<string, string | undefined>;
  configDir?: string;
  /** Test seam: runs the interactive session instead of the real one. */
  session?: (argv: string[]) => Promise<ExitCode>;
}

const COMMANDS: [string, string][] = [
  ["esfera", "open the session (interactive)"],
  ["login [--key <secret>]", "sign in — opens the browser; --key, stdin or $ESFERA_API_KEY for CI"],
  ["logout", "forget the stored key (revokes it if the browser sign-in minted it)"],
  ["status", "which key and host this machine uses"],
  ["auth login | auth status", "aliases of login and status"],
  ["convert <file.wav | folder>", "convert an ADM or ambisonic master — or every master in a folder — to IAMF; --preset, --profile, --programme, -o"],
  ["conversions list", "your conversions — --status, --page, --page-size"],
  ["conversions get <id>", "one conversion"],
  ["events list", "events of the last 30 days — --type, --since, --until, --limit, --starting-after"],
  ["events get <evt_id>", "one event, as its webhooks deliver it"],
  ["webhooks update <id>", "change an endpoint — --url, --events, --description, --clear-description"],
  ["webhooks rotate-secret <id>", "new signing secret; asks first — --expire-old-now, --yes"],
  ["presets", "the profiles and presets the encoder accepts"],
  ["usage", "what your team has used in this key's mode, and its limits"],
];

export function HELP(terminal: Terminal): string {
  const theme = makeTheme(terminal);
  const w = terminal.width;
  const col = Math.max(...COMMANDS.map(([c]) => c.length)) + 2;
  return [
    banner(theme, w, `esfera ${CLI_VERSION}`),
    heading(theme, w, "usage", "esfera <command> [options]"),
    "",
    ...COMMANDS.map(([c, d]) => `  ${theme.fg(c.padEnd(col))}${theme.dim(d)}`),
    "",
    `  ${theme.dim("--json on every command prints machine output only · --help · --version")}`,
    `  ${theme.dim("exit codes  0 ok · 1 usage · 2 pre-flight refused · 3 the API refused · 4 the conversion failed")}`,
    `  ${theme.faint("docs  developers.esfera.audio")}`,
  ].join("\n");
}

/** The SDK client every command uses: it names the CLI in `X-Esfera-Client`. */
export function cliSdk(opts: { apiKey: string; baseUrl: string; fetch?: typeof globalThis.fetch }): Esfera {
  return new Esfera({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetch: opts.fetch, clientName: `esfera-cli/${CLI_VERSION}` });
}

export async function dispatch(argv: string[], io: DispatchIO): Promise<ExitCode> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") { io.stdout(CLI_VERSION + "\n"); return EXIT.ok; }
  if (command === "--help" || command === "-h" || command === "help") { io.stdout(HELP(io.terminal) + "\n"); return EXIT.ok; }
  const sdk = (opts: { apiKey: string; baseUrl: string }) => cliSdk(opts);
  if (argv.every((a) => a === "session" || a === "--no-bell")) {
    if (io.terminal.interactive) {
      if (io.session) return io.session(argv);
      const theme = makeTheme(io.terminal);
      return runSession(defaultSessionDeps({ terminal: io.terminal, theme, env: io.env, argv, sdk, ...(io.configDir ? { configDir: io.configDir } : {}) }));
    }
    if (!command) { io.stdout(HELP(io.terminal) + "\n"); return EXIT.usage; }
    io.stderr("error: the session needs an interactive terminal — try `esfera --help`\n");
    return EXIT.usage;
  }

  const base = { env: io.env, stdout: io.stdout, stderr: io.stderr, terminal: io.terminal, ...(io.configDir ? { configDir: io.configDir } : {}) };

  switch (command) {
    case "login": return runLogin(rest, defaultLoginDeps({ ...base, sdk }));
    case "logout": return runLogout(rest, defaultLogoutDeps({ ...base }));
    case "status": return runAuth(["status", ...rest], defaultAuthDeps({ ...base, sdk }));
    case "auth":
      if (rest[0] === "login") return runLogin(rest.slice(1), defaultLoginDeps({ ...base, sdk }));
      return runAuth(rest, defaultAuthDeps({ ...base, sdk }));
    case "convert": return runConvert(rest, defaultConvertDeps({ ...base, sdk }));
    case "conversions": return runConversions(rest, defaultCommandDeps({ ...base, sdk }));
    case "presets": return runPresets(rest, defaultCommandDeps({ ...base, sdk }));
    case "usage": return runUsage(rest, defaultCommandDeps({ ...base, sdk }));
    case "events": return runEvents(rest, defaultCommandDeps({ ...base, sdk }));
    case "webhooks": return runWebhooks(rest, defaultCommandDeps({ ...base, sdk }));
    default:
      io.stderr(`error: unknown command '${command}'\nusage: esfera <auth|convert|conversions|events|webhooks|presets|usage> [...] — try \`esfera --help\`\n`);
      return EXIT.usage;
  }
}
