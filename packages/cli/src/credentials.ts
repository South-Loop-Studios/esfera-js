/**
 * Where the API key lives on disk: a 0600 file under the user's config
 * directory. Deliberately NOT an environment variable written into a shell
 * profile (shell history, `env` dumps, CI logs). `ESFERA_API_KEY` is still
 * honoured for CI, where a secret store is the right home.
 *
 * Ported from Esfera@c34437b0:packages/esfera-cli/src/credentials.ts.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  apiKey: string;
  apiUrl: string;
  /** How the key was obtained: minted by browser sign-in, or pasted. */
  via?: "device" | "paste";
}

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
  return join(base, "esfera");
}

export function saveCredentials(dir: string, creds: Credentials): void {
  // `mode` only applies when the thing is CREATED; chmod reasserts it on every save.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "credentials.json");
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadCredentials(dir: string): Credentials | null {
  const path = join(dir, "credentials.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** The key's shape: esf_sk_<live|test>_v1_<keyid>_<secret> — six underscore-separated parts. */
export const KEY_SHAPE = /^esf_sk_(live|test)_v1_[A-Za-z0-9]+_[A-Za-z0-9]+$/;

export function looksLikeKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

/** Enough of a key to identify it, never enough to use it. Malformed input is never echoed. */
export function redactKey(key: string): string {
  const parts = key.split("_");
  const looksLikeToken = parts.length === 6 && parts[0] === "esf" && parts[1] === "sk";
  if (!looksLikeToken) return key.length > 12 ? `…${key.slice(-4)}` : "(invalid key)";
  return `${parts.slice(0, 5).join("_")}_…${key.slice(-4)}`;
}
