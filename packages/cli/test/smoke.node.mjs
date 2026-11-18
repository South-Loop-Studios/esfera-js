// Bare Node after `pnpm build`: the binary starts and answers --version without a bundler.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const v = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim();
if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`unexpected --version output: ${v}`);
console.log(`smoke ok (esfera ${v})`);

// Signed-out behaviour, with an empty config dir so no real credentials are read.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const home = mkdtempSync(join(tmpdir(), "esfera-smoke-"));
const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home };
delete env.ESFERA_API_KEY;
const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: "utf8", env });
const st = run("status");
if (st.status !== 3 || !/not signed in/i.test(st.stdout + st.stderr)) throw new Error(`status: exit ${st.status}: ${st.stdout}${st.stderr}`);
const lo = run("logout");
if (lo.status !== 0 || !/not signed in/i.test(lo.stdout + lo.stderr)) throw new Error(`logout: exit ${lo.status}: ${lo.stdout}${lo.stderr}`);
console.log("smoke ok (signed-out status/logout)");
