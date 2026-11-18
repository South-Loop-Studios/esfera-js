/**
 * Which key and which host a command runs against, and how the banner names it.
 */
import { loadCredentials, looksLikeKey } from "./credentials.js";
import type { Env } from "./ui/index.js";

export const DEFAULT_API_URL = "https://api.esfera.audio";
export const STAGING_API_URL = "https://staging-api.esfera.audio";

/** Every key, Sandbox or Live, goes to production unless `ESFERA_API_URL` says otherwise. Staging is reached only that way, or with `--api-url`. */
export function apiUrlFor(_key: string, env: Record<string, string | undefined> = {}): string {
  return env.ESFERA_API_URL ?? DEFAULT_API_URL;
}

/** The key's mode, named apart from the host it talks to: `esf_sk_test_…` is Sandbox, `esf_sk_live_…` is Live. */
export function modeOf(key: string): "SANDBOX" | "LIVE" {
  return key.startsWith("esf_sk_test_") ? "SANDBOX" : "LIVE";
}

export interface ResolvedCredentials {
  apiKey: string;
  apiUrl: string;
  source: "env" | "file";
}

/** The env key wins; the env URL overrides even a stored URL (a design partner pointing one command at staging). Without one, every key goes to production. */
export function resolveCredentials(env: Record<string, string | undefined>, dir: string): ResolvedCredentials | null {
  const envKey = env.ESFERA_API_KEY;
  if (envKey) return { apiKey: envKey, apiUrl: apiUrlFor(envKey, env), source: "env" };
  const stored = loadCredentials(dir);
  if (!stored) return null;
  return { apiKey: stored.apiKey, apiUrl: env.ESFERA_API_URL ?? stored.apiUrl, source: "file" };
}

export function environmentLabel(apiUrl: string): Env {
  let host: string;
  try {
    host = new URL(apiUrl).host;
  } catch {
    host = apiUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  const label = host === "api.esfera.audio" ? "PRODUCTION" : host === "staging-api.esfera.audio" ? "STAGING" : "DEV";
  return { label, host };
}

/** The loggable id (`esf_k_live_7fQ2mR8xKp`) for a secret (`esf_sk_live_v1_7fQ2mR8xKp_…`), or null. */
export function keyIdOf(secret: string): string | null {
  if (!looksLikeKey(secret)) return null;
  const [, , envName, , keyId] = secret.split("_");
  return `esf_k_${envName}_${keyId}`;
}
