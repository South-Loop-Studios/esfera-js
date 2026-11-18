import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogout, type LogoutDeps } from "../src/commands/logout.js";
import { saveCredentials } from "../src/credentials.js";
import { EXIT } from "../src/exit.js";

const KEY = "esf_sk_live_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";
const KEYID = "esf_k_live_7fQ2mR8xKp";

function setup(over: Partial<LogoutDeps> = {}, stored?: { via?: "device" | "paste" }) {
  const out: string[] = [], err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "esfera-logout-"));
  if (stored) saveCredentials(dir, { apiKey: KEY, apiUrl: "https://api.esfera.audio", ...stored });
  const calls: string[] = [];
  const deps: LogoutDeps = {
    env: {}, configDir: dir,
    stdout: (s) => out.push(s), stderr: (s) => err.push(s),
    terminal: { colour: "none", width: 100, interactive: false },
    fetch: (async () => new Response("")) as never,
    revoke: (async (_u: string, k: string) => { calls.push(k); return "revoked"; }) as never,
    ...over,
  };
  return { deps, dir, calls, out: () => out.join(""), text: () => out.join("") + err.join(""), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("esfera logout", () => {
  it("not signed in", async () => {
    const t = setup();
    expect(await runLogout([], t.deps)).toBe(EXIT.ok);
    expect(t.out()).toContain("not signed in");
    t.done();
  });
  it("env key set, nothing stored: says nothing on this machine changed", async () => {
    const t = setup({ env: { ESFERA_API_KEY: KEY } });
    expect(await runLogout([], t.deps)).toBe(EXIT.ok);
    expect(t.out()).toContain("ESFERA_API_KEY is set in your environment — unset it to sign out; nothing stored on this machine was changed");
    expect(t.calls).toEqual([]);
    t.done();
  });
  it("env key set and a stored device key: revokes the stored key first, deletes the file, env key untouched", async () => {
    const t = setup({ env: { ESFERA_API_KEY: KEY } }, { via: "device" });
    expect(await runLogout([], t.deps)).toBe(EXIT.ok);
    expect(t.calls).toEqual([KEY]);
    expect(t.out()).toContain(`signed out · ${KEYID} revoked`);
    expect(t.out()).toContain("ESFERA_API_KEY in your environment is untouched — unset it to sign out");
    expect(t.out()).not.toContain("nothing stored on this machine was changed");
    expect(existsSync(join(t.dir, "credentials.json"))).toBe(false);
    expect(t.text()).not.toContain("s3cr3t");
    t.done();
  });
  it("env key set and a stored pasted key: no revoke, file deleted, both said", async () => {
    const t = setup({ env: { ESFERA_API_KEY: KEY } }, { via: "paste" });
    expect(await runLogout([], t.deps)).toBe(EXIT.ok);
    expect(t.calls).toEqual([]);
    expect(t.out()).toContain(`signed out · ${KEYID} kept`);
    expect(t.out()).toContain("ESFERA_API_KEY in your environment is untouched");
    expect(existsSync(join(t.dir, "credentials.json"))).toBe(false);
    t.done();
  });
  it("device key is revoked", async () => {
    const t = setup({}, { via: "device" });
    expect(await runLogout([], t.deps)).toBe(EXIT.ok);
    expect(t.out()).toContain(`signed out · ${KEYID} revoked`);
    expect(t.calls).toEqual([KEY]);
    expect(existsSync(join(t.dir, "credentials.json"))).toBe(false);
    expect(t.text()).not.toContain("s3cr3t");
    t.done();
  });
  it("device key the host keeps, does not support (404), or cannot be reached: says it could NOT be revoked", async () => {
    const revokes = [async () => "kept", async () => "unsupported", async () => { throw new TypeError("fetch failed"); }];
    for (const revoke of revokes) {
      const t = setup({ revoke: revoke as never }, { via: "device" });
      expect(await runLogout([], t.deps)).toBe(EXIT.ok);
      expect(t.out()).toContain(`signed out · ${KEYID} could NOT be revoked — revoke it in the Esfera Console`);
      expect(t.out()).not.toContain("not a browser-minted key");
      expect(existsSync(join(t.dir, "credentials.json"))).toBe(false);
      t.done();
    }
  });
  it("pasted key: no network, advice line; same for missing via", async () => {
    for (const via of ["paste", undefined] as const) {
      const t = setup({}, { via });
      expect(await runLogout([], t.deps)).toBe(EXIT.ok);
      expect(t.out()).toContain(`signed out · ${KEYID} kept — revoke it in the Esfera Console if it is no longer needed`);
      expect(t.calls).toEqual([]);
      expect(existsSync(join(t.dir, "credentials.json"))).toBe(false);
      expect(t.text()).not.toContain("s3cr3t");
      t.done();
    }
  });
  it("--json prints one line", async () => {
    const t = setup({}, { via: "device" });
    await runLogout(["--json"], t.deps);
    expect(JSON.parse(t.out())).toEqual({ keyId: KEYID, revoked: true });
    t.done();
    const n = setup();
    await runLogout(["--json"], n.deps);
    expect(JSON.parse(n.out())).toEqual({ keyId: null, revoked: false });
    n.done();
  });
});
