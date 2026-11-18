import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticationError } from "@esfera/sdk";
import { runLogin, type LoginDeps } from "../src/commands/login.js";
import { dispatch } from "../src/cli.js";
import { EXIT } from "../src/exit.js";
import type { DeviceStart } from "../src/device.js";

const TEST_KEY = "esf_sk_test_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";
const STAGING = "https://staging-api.esfera.audio";
const START: DeviceStart = { deviceCode: "dc", userCode: "WXYZ-1234", verificationUrl: "https://staging.esfera.audio/cli", intervalSec: 2, expiresInSec: 600 };
const OK = { ok: true as const, apiKey: TEST_KEY, keyId: "esf_k_test_7fQ2mR8xKp", apiUrl: STAGING };

function fakeLogin(over: { start?: LoginDeps["device"]["start"]; poll?: LoginDeps["device"]["poll"]; open?: boolean; tty?: boolean; usage?: () => Promise<unknown>; prompt?: () => Promise<string | null>; env?: Record<string, string>; stdinText?: string } = {}) {
  const out: string[] = [], err: string[] = [], opened: string[] = [];
  const calls = { start: 0 };
  const dir = mkdtempSync(join(tmpdir(), "esfera-login-"));
  const deps: LoginDeps = {
    env: { ESFERA_API_URL: STAGING, ...(over.env ?? {}) },
    configDir: dir,
    stdout: (s) => out.push(s), stderr: (s) => err.push(s),
    stdin: { isTTY: over.tty ?? true, read: async () => over.stdinText ?? null },
    prompt: over.prompt ?? (async () => null),
    terminal: { colour: "none", width: 100, interactive: false },
    sdk: () => ({ usage: { get: over.usage ?? (async () => ({ plan: "pro" })) } }) as never,
    device: {
      start: async (...a) => { calls.start++; return (over.start ?? (async () => START))(...a); },
      poll: over.poll ?? (async () => OK),
    },
    open: async (u) => { opened.push(u); return over.open ?? true; },
    hostname: () => "mac", fetch: (async () => new Response()) as never, sleep: async () => {}, now: () => 0,
  };
  return { deps, out, err, opened, calls, dir, text: () => out.join("") + err.join(""), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));

describe("esfera login", () => {
  let f: ReturnType<typeof fakeLogin>;
  afterEach(() => f?.cleanup());

  it("^C (the signal) during the browser wait cancels sign-in: nothing saved, exit 130", async () => {
    const ac = new AbortController();
    f = fakeLogin({ poll: async (_u, _s, d) => { expect(d.signal).toBe(ac.signal); ac.abort(); throw new DOMException("sign-in cancelled", "AbortError"); } });
    expect(await runLogin([], { ...f.deps, signal: ac.signal })).toBe(EXIT.interrupted);
    expect(f.err.join("")).toContain("sign-in cancelled");
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
  });

  it("TTY + no key: starts the device flow, shows the code, opens the browser, saves the key with via=device", async () => {
    f = fakeLogin();
    expect(await runLogin([], f.deps)).toBe(EXIT.ok);
    expect(f.err.join("")).toContain("WXYZ-1234");
    expect(f.opened).toEqual(["https://staging.esfera.audio/cli?code=WXYZ-1234"]);
    expect(saved(f.dir)).toEqual({ apiKey: TEST_KEY, apiUrl: STAGING, via: "device" });
    expect(f.text()).not.toContain("s3cr3t");
  });
  it("when the browser can't be opened the URL is shown and the flow still completes", async () => {
    f = fakeLogin({ open: false });
    expect(await runLogin([], f.deps)).toBe(EXIT.ok);
    expect(f.err.join("")).toContain("https://staging.esfera.audio/cli");
    expect(f.err.join("")).toContain("open this address");
  });
  it("--key skips the browser and takes the paste path", async () => {
    f = fakeLogin();
    expect(await runLogin(["--key", TEST_KEY], f.deps)).toBe(EXIT.ok);
    expect(f.calls.start).toBe(0);
    expect(saved(f.dir).via).toBe("paste");
    expect(f.text()).not.toContain("s3cr3t");
  });
  it("non-TTY stdin takes the paste path", async () => {
    f = fakeLogin({ tty: false, stdinText: TEST_KEY });
    expect(await runLogin([], f.deps)).toBe(EXIT.ok);
    expect(f.calls.start).toBe(0);
    expect(saved(f.dir).via).toBe("paste");
  });
  it("a pasted test key is a Sandbox key and is stored against production, like a live key; ESFERA_API_URL still wins", async () => {
    f = fakeLogin({ env: { ESFERA_API_URL: undefined as unknown as string } });
    expect(await runLogin(["--key", TEST_KEY], f.deps)).toBe(EXIT.ok);
    expect(saved(f.dir).apiUrl).toBe("https://api.esfera.audio");
    f.cleanup();
    f = fakeLogin({ env: { ESFERA_API_URL: undefined as unknown as string } });
    expect(await runLogin(["--key", TEST_KEY.replace("esf_sk_test_", "esf_sk_live_")], f.deps)).toBe(EXIT.ok);
    expect(saved(f.dir).apiUrl).toBe("https://api.esfera.audio");
    f.cleanup();
    f = fakeLogin({ env: { ESFERA_API_URL: STAGING } });
    expect(await runLogin(["--key", TEST_KEY], f.deps)).toBe(EXIT.ok);
    expect(saved(f.dir).apiUrl).toBe(STAGING);
  });
  it("$ESFERA_API_KEY takes the paste path", async () => {
    f = fakeLogin({ env: { ESFERA_API_KEY: TEST_KEY } });
    expect(await runLogin([], f.deps)).toBe(EXIT.ok);
    expect(f.calls.start).toBe(0);
  });
  it("404 from the host falls back to the paste prompt with one note", async () => {
    f = fakeLogin({ start: async () => "unsupported", prompt: async () => TEST_KEY });
    expect(await runLogin([], f.deps)).toBe(EXIT.ok);
    expect(f.err.join("")).toMatch(/no browser sign-in yet/);
    expect(f.err.join("").match(/no browser sign-in yet/g)).toHaveLength(1);
    expect(saved(f.dir).via).toBe("paste");
  });
  it("404 fallback with a refused key still exits 3", async () => {
    f = fakeLogin({ start: async () => "unsupported", prompt: async () => TEST_KEY, usage: async () => { throw new AuthenticationError(401, { title: "Unauthorized", detail: "bad key" } as never); } });
    expect(await runLogin([], f.deps)).toBe(EXIT.refused);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
  });
  it("a refused device key exits 3 and nothing is saved", async () => {
    f = fakeLogin({ usage: async () => { throw new AuthenticationError(401, { title: "Unauthorized", detail: "bad key" } as never); } });
    expect(await runLogin([], f.deps)).toBe(EXIT.refused);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
  });
  it("expired → exit 3 with 'expired'; denied → exit 3 with 'denied'; nothing saved", async () => {
    f = fakeLogin({ poll: async () => ({ ok: false, reason: "expired" }) });
    expect(await runLogin([], f.deps)).toBe(EXIT.refused);
    expect(f.err.join("")).toMatch(/expired/);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
    f.cleanup();
    f = fakeLogin({ poll: async () => ({ ok: false, reason: "denied" }) });
    expect(await runLogin([], f.deps)).toBe(EXIT.refused);
    expect(f.err.join("")).toMatch(/denied/);
    expect(existsSync(join(f.dir, "credentials.json"))).toBe(false);
  });
  it("--json prints only { keyId, apiUrl, plan } on stdout", async () => {
    f = fakeLogin();
    expect(await runLogin(["--json"], f.deps)).toBe(EXIT.ok);
    expect(f.out).toHaveLength(1);
    expect(JSON.parse(f.out[0])).toEqual({ keyId: "esf_k_test_7fQ2mR8xKp", apiUrl: STAGING, plan: "pro" });
    expect(f.err.join("")).toContain("WXYZ-1234");
  });
});

describe("dispatch routing", () => {
  const terminal = { colour: "none" as const, width: 100, interactive: false };
  // A malformed key is rejected by the paste path before any network call, so this proves the route.
  for (const argv of [["auth", "login", "hunter2"], ["login", "--key", "hunter2"]]) {
    it(`${argv.slice(0, 2).join(" ")} reaches the paste path`, async () => {
      const err: string[] = [];
      const code = await dispatch(argv, { stdout: () => {}, stderr: (s) => err.push(s), terminal, env: {} });
      expect(code).toBe(EXIT.usage);
      expect(err.join("")).toMatch(/does not look like an Esfera API key/);
      expect(err.join("")).not.toContain("hunter2");
    });
  }
});
