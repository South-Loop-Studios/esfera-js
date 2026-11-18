import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuth, type AuthDeps } from "../src/commands/auth.js";
import { resolveCredentials, environmentLabel, keyIdOf, apiUrlFor, modeOf } from "../src/context.js";
import { saveCredentials } from "../src/credentials.js";
import { AuthenticationError } from "@esfera/sdk";
import { EXIT } from "../src/exit.js";

const KEY = "esf_sk_live_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";
const TEST_KEY = "esf_sk_test_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";

function fakeDeps(over: Partial<AuthDeps> & { usage?: () => Promise<unknown> } = {}) {
  const out: string[] = [], err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "esfera-auth-"));
  const deps: AuthDeps = {
    env: {},
    configDir: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    stdin: { isTTY: true, read: async () => null },
    prompt: async () => null,
    terminal: { colour: "none", width: 100, interactive: false },
    sdk: () => ({ usage: { get: over.usage ?? (async () => ({ plan: "pro" })) } }) as never,
    ...over,
  };
  return { deps, out, err, dir, text: () => out.join("") + err.join(""), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("resolveCredentials / environmentLabel / keyIdOf", () => {
  it("prefers the env key; the env URL overrides the stored URL; without one every key, test or live, goes to production", () => {
    const dir = mkdtempSync(join(tmpdir(), "esfera-ctx-"));
    saveCredentials(dir, { apiKey: KEY, apiUrl: "https://api.esfera.audio" });
    expect(resolveCredentials({ ESFERA_API_KEY: TEST_KEY }, dir)).toEqual({ apiKey: TEST_KEY, apiUrl: "https://api.esfera.audio", source: "env" });
    const LIVE_KEY = TEST_KEY.replace("esf_sk_test_", "esf_sk_live_");
    expect(resolveCredentials({ ESFERA_API_KEY: LIVE_KEY }, dir)).toEqual({ apiKey: LIVE_KEY, apiUrl: "https://api.esfera.audio", source: "env" });
    expect(resolveCredentials({ ESFERA_API_URL: "https://staging-api.esfera.audio" }, dir)).toEqual({ apiKey: KEY, apiUrl: "https://staging-api.esfera.audio", source: "file" });
    expect(resolveCredentials({}, join(dir, "none"))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it("apiUrlFor sends a Sandbox key to production, and ESFERA_API_URL overrides it", () => {
    expect(apiUrlFor("esf_sk_test_v1_7fQ2mR8xKp_abc")).toBe("https://api.esfera.audio");
    expect(apiUrlFor("esf_sk_live_v1_7fQ2mR8xKp_abc")).toBe("https://api.esfera.audio");
    expect(apiUrlFor("esf_sk_test_v1_7fQ2mR8xKp_abc", { ESFERA_API_URL: "https://staging-api.esfera.audio" })).toBe("https://staging-api.esfera.audio");
  });
  it("modeOf names the key's mode apart from the host", () => {
    expect(modeOf("esf_sk_test_v1_7fQ2mR8xKp_abc")).toBe("SANDBOX");
    expect(modeOf("esf_sk_live_v1_7fQ2mR8xKp_abc")).toBe("LIVE");
  });
  it("labels the two known hosts and falls back to the hostname", () => {
    expect(environmentLabel("https://api.esfera.audio")).toEqual({ label: "PRODUCTION", host: "api.esfera.audio" });
    expect(environmentLabel("https://staging-api.esfera.audio/")).toEqual({ label: "STAGING", host: "staging-api.esfera.audio" });
    expect(environmentLabel("http://localhost:8787")).toEqual({ label: "DEV", host: "localhost:8787" });
  });
  it("derives the loggable key id from a secret", () => {
    expect(keyIdOf(KEY)).toBe("esf_k_live_7fQ2mR8xKp");
    expect(keyIdOf("garbage")).toBeNull();
  });
});

describe("esfera auth login", () => {
  let f: ReturnType<typeof fakeDeps>;
  beforeEach(() => { f?.cleanup(); });

  it("reads the key from stdin when piped, checks it against the API, saves it 0600 and renders the login screen", async () => {
    f = fakeDeps({ stdin: { isTTY: false, read: async () => `${KEY}\n` } });
    const code = await runAuth(["login"], f.deps);
    expect(code).toBe(EXIT.ok);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(true);
    expect(f.text()).toContain("signed in");
    expect(f.text()).toContain("esf_k_live_7fQ2mR8xKp");
    expect(f.text()).toContain("pro");
    expect(f.text()).not.toContain("s3cr3t");
  });
  it("takes $ESFERA_API_KEY and the env URL, and the STAGING label follows the staging host", async () => {
    f = fakeDeps({ env: { ESFERA_API_KEY: TEST_KEY, ESFERA_API_URL: "https://staging-api.esfera.audio" } });
    expect(await runAuth(["login"], f.deps)).toBe(EXIT.ok);
    expect(f.text()).toContain("STAGING");
  });
  it("warns when the key is passed as an argument (shell history)", async () => {
    f = fakeDeps();
    expect(await runAuth(["login", KEY], f.deps)).toBe(EXIT.ok);
    expect(f.err.join("")).toMatch(/shell history/);
  });
  it("a malformed key is a usage error and nothing is saved", async () => {
    f = fakeDeps();
    expect(await runAuth(["login", "hunter2"], f.deps)).toBe(EXIT.usage);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
    expect(f.text()).toMatch(/esf_sk_/);
  });
  it("a key the API refuses exits 3 and nothing is saved", async () => {
    f = fakeDeps({ usage: async () => { throw new AuthenticationError({ status: 401, type: "https://esfera.audio/errors/invalid-api-key", title: "Invalid API key", detail: "The API key is missing, malformed, unknown, revoked, expired, or not valid for this environment." }); } });
    expect(await runAuth(["login", KEY], f.deps)).toBe(EXIT.refused);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
    expect(f.text()).toMatch(/not valid for this environment/);
  });
  it("a network failure while checking the key is exit 4, not an unhandled rejection, and nothing is saved", async () => {
    f = fakeDeps({ usage: async () => { throw new TypeError("fetch failed"); } });
    expect(await runAuth(["login", KEY], f.deps)).toBe(EXIT.failed);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
    expect(f.text()).toMatch(/fetch failed/);
  });
  it("prompts on a TTY when nothing else supplied the key", async () => {
    f = fakeDeps({ prompt: async () => KEY });
    expect(await runAuth(["login"], f.deps)).toBe(EXIT.ok);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(true);
  });
  it("--json prints the key id, host and plan and nothing else", async () => {
    f = fakeDeps({ stdin: { isTTY: false, read: async () => KEY } });
    expect(await runAuth(["login", "--json"], f.deps)).toBe(EXIT.ok);
    expect(JSON.parse(f.out.join(""))).toEqual({ keyId: "esf_k_live_7fQ2mR8xKp", apiUrl: "https://api.esfera.audio", plan: "pro" });
    expect(f.err.join("")).toBe("");
  });
  it("auth status shows the key id and host, or exits 3 when not signed in", async () => {
    f = fakeDeps();
    expect(await runAuth(["status"], f.deps)).toBe(EXIT.refused);
    saveCredentials(f.dir, { apiKey: KEY, apiUrl: "https://api.esfera.audio" });
    expect(await runAuth(["status"], f.deps)).toBe(EXIT.ok);
    expect(f.text()).toContain("esf_k_live_7fQ2mR8xKp");
    expect(f.text()).toContain("api.esfera.audio");
  });
});
