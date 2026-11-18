import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bellEnabled, loadConfig, loadRecent, rememberRecent } from "../../src/session/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "esfera-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (path: string) => ({ path, sizeBytes: 1, channels: 12, durationSec: 3, isAdm: true, objectCount: 2 });
const touch = (name: string) => {
  const p = join(dir, name);
  writeFileSync(p, "x");
  return p;
};

describe("loadConfig", () => {
  it("returns defaults for a missing dir", () => {
    expect(loadConfig(join(dir, "nope"))).toEqual({ bell: true, recentLimit: 10 });
  });
  it("returns defaults for malformed JSON", () => {
    writeFileSync(join(dir, "config.json"), "{nope");
    expect(loadConfig(dir)).toEqual({ bell: true, recentLimit: 10 });
  });
  it("reads known keys and ignores unknown ones", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ bell: false, recentLimit: 3, extra: 1 }));
    expect(loadConfig(dir)).toEqual({ bell: false, recentLimit: 3 });
  });
});

describe("recent masters", () => {
  it("dedupes by resolved path, moves to front, truncates", () => {
    const a = touch("a.wav"), b = touch("b.wav"), c = touch("c.wav");
    rememberRecent(dir, entry(a), new Date(1000), 2);
    rememberRecent(dir, entry(b), new Date(2000), 2);
    rememberRecent(dir, entry(a), new Date(3000), 2);
    const out = rememberRecent(dir, entry(c), new Date(4000), 2);
    expect(out.map((e) => e.path)).toEqual([c, a]);
    expect(loadRecent(dir).map((e) => e.path)).toEqual([c, a]);
    expect(out[0]!.lastUsed).toBe(new Date(4000).toISOString());
  });
  it("drops paths that no longer exist on load", () => {
    const a = touch("a.wav");
    rememberRecent(dir, entry(a), new Date(), 10);
    rmSync(a);
    expect(loadRecent(dir)).toEqual([]);
  });
  it("returns [] for a missing or malformed file", () => {
    expect(loadRecent(join(dir, "nope"))).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "recent.json"), "[[");
    expect(loadRecent(dir)).toEqual([]);
  });
});

describe("bellEnabled", () => {
  const cfg = { bell: true, recentLimit: 10 };
  it("is on by default", () => expect(bellEnabled(cfg, {}, [])).toBe(true));
  it("off via --no-bell", () => expect(bellEnabled(cfg, {}, ["--no-bell"])).toBe(false));
  it("off via env", () => expect(bellEnabled(cfg, { ESFERA_NO_BELL: "1" }, [])).toBe(false));
  it("empty env does not disable", () => expect(bellEnabled(cfg, { ESFERA_NO_BELL: "" }, [])).toBe(true));
  it("off via config", () => expect(bellEnabled({ ...cfg, bell: false }, {}, [])).toBe(false));
});
