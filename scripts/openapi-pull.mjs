#!/usr/bin/env node
/** Rewrites openapi/v1.json from the served document (staging by default). */
import { writeFileSync } from "node:fs";
import { normalize, fetchDocument, SNAPSHOT_PATH, DEFAULT_URL, isMainModule } from "./openapi-lib.mjs";

export async function runPull({ url = process.env.ESFERA_OPENAPI_URL ?? DEFAULT_URL, fetchDocument: fetchDoc = fetchDocument, path = SNAPSHOT_PATH } = {}) {
  const doc = await fetchDoc(url);
  writeFileSync(path, normalize(doc));
  return { paths: Object.keys(doc.paths ?? {}).length, version: doc.info?.version, path };
}

if (isMainModule(import.meta.url)) {
  const r = await runPull();
  console.log(`openapi snapshot written: ${r.path} (v${r.version}, ${r.paths} paths)`);
}
