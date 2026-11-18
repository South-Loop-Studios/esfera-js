import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CLI_VERSION } from "../src/version.js";
it("CLI_VERSION matches package.json", () => {
  expect(CLI_VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});
