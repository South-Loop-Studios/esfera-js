import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredentials, loadCredentials, redactKey, configDir } from "../src/credentials.js";

// Ported from Esfera@c34437b0:packages/esfera-cli/test/credentials.test.ts.
describe("credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "esfera-cred-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips a key through a file, readable only by its owner", () => {
    saveCredentials(dir, { apiKey: "esf_sk_live_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t", apiUrl: "https://api.esfera.audio" });
    expect(loadCredentials(dir)).toEqual({ apiKey: "esf_sk_live_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t", apiUrl: "https://api.esfera.audio" });
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it("returns null when nothing has been saved", () => {
    expect(loadCredentials(join(dir, "nope"))).toBeNull();
  });
  it("redacts a key to its prefix and last four", () => {
    expect(redactKey("esf_sk_live_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t")).toBe("esf_sk_live_v1_7fQ2mR8xKp_…cr3t");
  });
  it("shows an opaque placeholder for malformed input, never echoing it back", () => {
    expect(redactKey("hunter2")).toBe("(invalid key)");
    expect(redactKey("")).toBe("(invalid key)");
    expect(redactKey("this-is-a-long-password-1234")).toBe("…1234");
  });
  it("configDir honours XDG_CONFIG_HOME", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x/cfg" })).toBe("/x/cfg/esfera");
    expect(configDir({ HOME: "/Users/b" })).toBe("/Users/b/.config/esfera");
  });
});
