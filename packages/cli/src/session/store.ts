/**
 * Session preferences and the recent-masters list: `config.json` and
 * `recent.json` under the config dir. Both are forgiving on read (missing or
 * malformed → defaults) and the recent list is written 0600 like credentials.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SessionConfig {
  bell: boolean;
  recentLimit: number;
}

const DEFAULTS: SessionConfig = { bell: true, recentLimit: 10 };

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadConfig(dir: string): SessionConfig {
  const raw = readJson(join(dir, "config.json"));
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.bell === "boolean") out.bell = r.bell;
    if (typeof r.recentLimit === "number" && Number.isInteger(r.recentLimit) && r.recentLimit > 0) {
      out.recentLimit = r.recentLimit;
    }
  }
  return out;
}

export interface RecentMaster {
  path: string;
  sizeBytes: number;
  channels: number;
  durationSec: number;
  isAdm: boolean;
  ambisonicOrder?: number | null;
  objectCount: number;
  lastUsed: string;
}

function readRecentRaw(dir: string): RecentMaster[] {
  const raw = readJson(join(dir, "recent.json"));
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is RecentMaster => !!e && typeof e === "object" && typeof (e as RecentMaster).path === "string",
  );
}

/** Newest first; entries whose file has since gone are dropped (not written back). */
export function loadRecent(dir: string): RecentMaster[] {
  return readRecentRaw(dir).filter((e) => existsSync(e.path));
}

export function rememberRecent(
  dir: string,
  entry: Omit<RecentMaster, "lastUsed">,
  now: Date,
  limit: number,
): RecentMaster[] {
  const key = resolve(entry.path);
  const rest = loadRecent(dir).filter((e) => resolve(e.path) !== key);
  const next = [{ ...entry, lastUsed: now.toISOString() }, ...rest].slice(0, limit);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "recent.json");
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return next;
}

export function bellEnabled(
  config: SessionConfig,
  env: Record<string, string | undefined>,
  argv: string[],
): boolean {
  if (argv.includes("--no-bell")) return false;
  if (env.ESFERA_NO_BELL !== undefined && env.ESFERA_NO_BELL !== "") return false;
  return config.bell !== false;
}
