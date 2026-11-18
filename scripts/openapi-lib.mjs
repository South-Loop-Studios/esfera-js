/**
 * Shared by openapi-pull and openapi-check. The snapshot is the hinge between
 * the Esfera Worker (which serves /v1/openapi.json) and this repo (whose SDK
 * contract test and docs generator read the committed copy).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const DEFAULT_URL = "https://staging-api.esfera.audio/v1/openapi.json";
export const SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi", "v1.json");

/** Stable, diff-friendly serialisation: 2-space indent, trailing newline. */
export function normalize(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

export async function fetchDocument(url = process.env.ESFERA_OPENAPI_URL ?? DEFAULT_URL) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export function readSnapshot(path = SNAPSHOT_PATH) {
  return readFileSync(path, "utf8");
}

export function isMainModule(moduleUrl) {
  return process.argv[1] && fileURLToPath(moduleUrl) === process.argv[1];
}
