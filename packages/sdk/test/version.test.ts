import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SDK_VERSION } from "../src/version.js";
it("SDK_VERSION matches package.json", () => {
  expect(SDK_VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});
