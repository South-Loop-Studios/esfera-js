import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
