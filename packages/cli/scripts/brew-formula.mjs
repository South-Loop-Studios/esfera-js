#!/usr/bin/env node
/**
 * Render Formula/esfera.rb for a published @esfera/cli version: fetches the npm
 * tarball, computes its sha256, fills homebrew/esfera.rb.tmpl.
 *
 *   node scripts/brew-formula.mjs 0.1.0 [out.rb]
 *
 * Pushing the result to South-Loop-Studios/homebrew-esfera is a manual step for
 * the first release (the tap repo and a token with access are Ben's).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "homebrew", "esfera.rb.tmpl");

export function tarballUrl(version) {
  return `https://registry.npmjs.org/@esfera/cli/-/cli-${version}.tgz`;
}

export function renderFormula({ version, sha256 }, template = readFileSync(TEMPLATE, "utf8")) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  return template.replaceAll("{{version}}", version).replaceAll("{{sha256}}", sha256);
}

export async function sha256OfUrl(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [version, out] = process.argv.slice(2);
  if (!version) { console.error("usage: brew-formula.mjs <version> [out.rb]"); process.exit(2); }
  const sha256 = await sha256OfUrl(tarballUrl(version));
  const rb = renderFormula({ version, sha256 });
  if (out) { writeFileSync(out, rb); console.error(`wrote ${out}`); } else process.stdout.write(rb);
}
