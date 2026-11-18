/**
 * `esfera logout [--json]`: forget the stored key. A key the browser sign-in
 * minted is revoked server-side; a pasted key is only forgotten.
 */
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadCredentials, redactKey, configDir as defaultConfigDir } from "../credentials.js";
import { keyIdOf, DEFAULT_API_URL } from "../context.js";
import { EXIT, CliExit, type ExitCode } from "../exit.js";
import { makeTheme, type Terminal } from "../ui/index.js";
import { revokeSelf } from "../device.js";

export interface LogoutDeps {
  env: Record<string, string | undefined>;
  configDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  terminal: Terminal;
  fetch: typeof globalThis.fetch;
  revoke: typeof revokeSelf;
}

export function defaultLogoutDeps(partial: Partial<LogoutDeps> = {}): LogoutDeps {
  return {
    env: process.env,
    configDir: defaultConfigDir(process.env),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    terminal: { colour: "none", width: 100, interactive: false },
    fetch: (...a) => globalThis.fetch(...a),
    revoke: revokeSelf,
    ...partial,
  };
}

export async function runLogout(args: string[], deps: LogoutDeps): Promise<ExitCode> {
  try {
    let json = false;
    for (const a of args) {
      if (a === "--json") json = true;
      else throw new CliExit(EXIT.usage, `unknown option '${a}'`);
    }
    const theme = makeTheme(deps.terminal);
    const say = (line: string, keyId: string | null, revoked: boolean) =>
      deps.stdout(json ? JSON.stringify({ keyId, revoked }) + "\n" : line + "\n");

    const creds = loadCredentials(deps.configDir);
    const envKey = deps.env.ESFERA_API_KEY;
    if (!creds) {
      say(envKey
        ? "ESFERA_API_KEY is set in your environment — unset it to sign out; nothing stored on this machine was changed"
        : "not signed in", null, false);
      return EXIT.ok;
    }

    const keyId = keyIdOf(creds.apiKey) ?? redactKey(creds.apiKey);
    const id = theme.data(keyId);
    const signedOut = theme.fg("signed out");
    let revoked = false;
    let line: string;
    if (creds.via === "device") {
      // Revoke before the file goes: once it is deleted, this machine no longer holds the secret.
      try { revoked = (await deps.revoke(creds.apiUrl || DEFAULT_API_URL, creds.apiKey, { fetch: deps.fetch })) === "revoked"; } catch { revoked = false; }
      line = revoked
        ? `${signedOut} · ${id} ${theme.fg("revoked")}`
        : `${signedOut} · ${id} ${theme.fg("could NOT be revoked — revoke it in the Esfera Console")}`;
    } else {
      line = `${signedOut} · ${id} ${theme.fg("kept — revoke it in the Esfera Console if it is no longer needed")}`;
    }
    try { unlinkSync(join(deps.configDir, "credentials.json")); } catch { /* already gone */ }
    if (envKey) line += "\n" + theme.fg("ESFERA_API_KEY in your environment is untouched — unset it to sign out");
    say(line, keyId, revoked);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CliExit) { deps.stderr(`error: ${err.message}\n`); return err.code; }
    deps.stderr(`error: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  }
}
