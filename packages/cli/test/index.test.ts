import { describe, it, expect } from "vitest";
import { dispatch, HELP, cliSdk } from "../src/cli.js";
import { CLI_VERSION } from "../src/version.js";
import { EXIT } from "../src/exit.js";

function io() {
  const out: string[] = [], err: string[] = [];
  return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
}
const terminal = { colour: "none" as const, width: 100, interactive: false };

describe("esfera (entry point)", () => {
  it("the SDK the CLI builds names the CLI in X-Esfera-Client", async () => {
    const seen: Headers[] = [];
    const fetch = (async (_u: unknown, init: RequestInit = {}) => { seen.push(new Headers(init.headers)); return Response.json({ profiles: [], presets: [] }); }) as unknown as typeof globalThis.fetch;
    await cliSdk({ apiKey: "esf_sk_test_v1_k_s", baseUrl: "https://api.test", fetch }).presets.get();
    expect(seen[0].get("x-esfera-client")).toBe(`esfera-cli/${CLI_VERSION}`);
  });
  it("an unknown command prints usage on stderr and exits 1", async () => {
    const { err, stdout, stderr } = io();
    expect(await dispatch(["frobnicate"], { stdout, stderr, terminal, env: {} })).toBe(EXIT.usage);
    expect(err.join("")).toMatch(/usage: esfera/);
  });
  it("--help lists every command with the banner", async () => {
    const { out, stdout, stderr } = io();
    expect(await dispatch(["--help"], { stdout, stderr, terminal, env: {} })).toBe(EXIT.ok);
    const t = out.join("");
    for (const c of ["login", "logout", "status", "auth login", "convert", "conversions list", "conversions get", "events list", "events get", "webhooks update", "webhooks rotate-secret", "presets"]) expect(t).toContain(c);
    expect(t).toContain("E S F E R A");
    expect(t).toBe(HELP(terminal) + "\n");
  });
  it("no arguments behaves like --help but exits 1", async () => {
    const { out, stdout, stderr } = io();
    expect(await dispatch([], { stdout, stderr, terminal, env: {} })).toBe(EXIT.usage);
    expect(out.join("") + "").toContain("convert");
  });
  it("no arguments on a terminal opens the session", async () => {
    const { out, stdout, stderr } = io();
    const calls: string[][] = [];
    const tty = { ...terminal, interactive: true };
    const session = async (argv: string[]) => { calls.push(argv); return EXIT.ok; };
    expect(await dispatch([], { stdout, stderr, terminal: tty, env: {}, session })).toBe(EXIT.ok);
    expect(await dispatch(["session", "--no-bell"], { stdout, stderr, terminal: tty, env: {}, session })).toBe(EXIT.ok);
    expect(calls).toEqual([[], ["session", "--no-bell"]]);
    expect(out.join("")).toBe("");
  });
  it("no arguments off a terminal still prints help and exits 1", async () => {
    const { out, stdout, stderr } = io();
    const session = async () => { throw new Error("must not open"); };
    expect(await dispatch([], { stdout, stderr, terminal, env: {}, session })).toBe(EXIT.usage);
    expect(out.join("")).toContain("open the session (interactive)");
  });
  it("--version prints the package version", async () => {
    const { out, stdout, stderr } = io();
    expect(await dispatch(["--version"], { stdout, stderr, terminal, env: {} })).toBe(EXIT.ok);
    expect(out.join("").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
