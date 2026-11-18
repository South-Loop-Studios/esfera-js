#!/usr/bin/env node
/**
 * Fails (exit 1) when openapi/v1.json differs from the document the API
 * serves — or when the API can't be reached. A network failure is a failure,
 * not a pass: a stale snapshot must never hide behind an outage.
 */
import { normalize, fetchDocument, readSnapshot, isMainModule, DEFAULT_URL } from "./openapi-lib.mjs";

export async function runCheck({ committed, fetchDocument: fetchDoc = fetchDocument, url = process.env.ESFERA_OPENAPI_URL ?? DEFAULT_URL } = {}) {
  let served;
  try {
    served = await fetchDoc(url);
  } catch (err) {
    return { code: 1, message: `openapi check: could not fetch ${url}: ${err?.message ?? err}` };
  }
  const servedText = normalize(served);
  const paths = Object.keys(served.paths ?? {}).length;
  if (servedText === committed) return { code: 0, message: `openapi snapshot matches ${url} (${paths} paths)` };
  return { code: 1, message: `openapi snapshot differs from ${url} (served: ${paths} paths) — run \`pnpm openapi:pull\` and commit the result` };
}

if (isMainModule(import.meta.url)) {
  const r = await runCheck({ committed: readSnapshot() });
  console[r.code ? "error" : "log"](r.message);
  process.exit(r.code);
}
