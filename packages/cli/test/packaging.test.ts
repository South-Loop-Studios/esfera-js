import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFormula } from "../scripts/brew-formula.mjs";

describe("Homebrew formula", () => {
  it("renders the npm tarball URL, its sha256, a node dependency and the std npm install", () => {
    const rb = renderFormula({ version: "0.1.0", sha256: "a".repeat(64) });
    expect(rb).toContain('url "https://registry.npmjs.org/@esfera/cli/-/cli-0.1.0.tgz"');
    expect(rb).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(rb).toContain('depends_on "node"');
    expect(rb).toContain('system "npm", "install", *std_npm_args');
    expect(rb).toContain('bin.install_symlink Dir["#{libexec}/bin/*"]');
    expect(rb).toMatch(/test do[\s\S]*--version[\s\S]*end/);
    expect(rb).toContain("class Esfera < Formula");
  });
});

describe("packed manifests", () => {
  it("neither package ships a workspace:* dependency or a private flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "esfera-pack-"));
    try {
      for (const pkg of ["sdk", "cli"]) {
        const cwd = join(import.meta.dirname, "..", "..", pkg);
        execFileSync("pnpm", ["pack", "--pack-destination", dir], { cwd, stdio: "pipe" });
        const tgz = readdirSync(dir).find((f) => f.startsWith(`esfera-${pkg}-`) && f.endsWith(".tgz"))!;
        const manifest = execFileSync("tar", ["-xOf", join(dir, tgz), "package/package.json"], { encoding: "utf8" });
        const json = JSON.parse(manifest);
        expect(JSON.stringify(json.dependencies ?? {})).not.toContain("workspace:");
        expect(json.private).toBe(false);
        expect(json.publishConfig).toEqual({ access: "public" });
        if (pkg === "cli") expect(json.bin).toEqual({ esfera: "./dist/index.js" });
        rmSync(join(dir, tgz));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
