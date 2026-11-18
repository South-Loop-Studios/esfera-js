import { describe, it, expect } from "vitest";
import { defaultSpawn, openUrl, revealPath } from "../src/open.js";

describe("open", () => {
  it("openUrl picks the platform opener", async () => {
    const calls: [string, string[]][] = [];
    const spawn = async (c: string, a: string[]) => { calls.push([c, a]); return 0; };
    await openUrl("https://esfera.audio/cli?code=WXYZ-1234", "darwin", spawn);
    await openUrl("https://x", "win32", spawn);
    await openUrl("https://x", "linux", spawn);
    expect(calls).toEqual([
      ["open", ["https://esfera.audio/cli?code=WXYZ-1234"]],
      ["cmd", ["/c", "start", "", "https://x"]],
      ["xdg-open", ["https://x"]],
    ]);
  });
  it("openUrl resolves false when the opener is missing or exits non-zero", async () => {
    expect(await openUrl("https://x", "linux", async () => { throw new Error("ENOENT"); })).toBe(false);
    expect(await openUrl("https://x", "linux", async () => 1)).toBe(false);
    expect(await openUrl("https://x", "linux", async () => 0)).toBe(true);
  });
  it.skipIf(process.platform === "win32")("defaultSpawn keeps the event loop alive until the opener exits, and lets a lingering one go after the hand-off", async () => {
    expect(await defaultSpawn("true", [])).toBe(0);
    expect(await defaultSpawn("false", [])).toBe(1);
    await expect(defaultSpawn("esfera-no-such-opener-xyz", [])).rejects.toThrow();
    const t0 = Date.now();
    expect(await defaultSpawn("sleep", ["5"])).toBe(0);   // treated as opened after the hand-off window, not after 5 s
    expect(Date.now() - t0).toBeLessThan(4000);
  });
  it("revealPath picks the platform reveal command", async () => {
    const calls: [string, string[]][] = [];
    const spawn = async (c: string, a: string[]) => { calls.push([c, a]); return 0; };
    await revealPath("/a/b/c.json", "darwin", spawn);
    await revealPath("C:\\a\\c.json", "win32", spawn);
    await revealPath("/a/b/c.json", "linux", spawn);
    expect(calls).toEqual([
      ["open", ["-R", "/a/b/c.json"]],
      ["explorer", ["/select,C:\\a\\c.json"]],
      ["xdg-open", ["/a/b"]],
    ]);
  });
});
