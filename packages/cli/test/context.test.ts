import { describe, it, expect } from "vitest";
import { apiUrlFor, modeOf, DEFAULT_API_URL } from "../src/context.js";

const TEST_KEY = "esf_sk_test_v1_7fQ2mR8xKp_secretsecretsecret";
const LIVE_KEY = "esf_sk_live_v1_7fQ2mR8xKp_secretsecretsecret";

describe("apiUrlFor", () => {
  it("sends a Sandbox (test) key to production", () => {
    expect(apiUrlFor(TEST_KEY)).toBe("https://api.esfera.audio");
    expect(apiUrlFor(TEST_KEY, {})).toBe(DEFAULT_API_URL);
  });
  it("sends a Live key to production", () => {
    expect(apiUrlFor(LIVE_KEY)).toBe("https://api.esfera.audio");
  });
  it("lets ESFERA_API_URL override either", () => {
    const env = { ESFERA_API_URL: "https://staging-api.esfera.audio" };
    expect(apiUrlFor(TEST_KEY, env)).toBe("https://staging-api.esfera.audio");
    expect(apiUrlFor(LIVE_KEY, env)).toBe("https://staging-api.esfera.audio");
  });
});

describe("modeOf", () => {
  it("names the mode from the key prefix", () => {
    expect(modeOf(TEST_KEY)).toBe("SANDBOX");
    expect(modeOf(LIVE_KEY)).toBe("LIVE");
  });
});
