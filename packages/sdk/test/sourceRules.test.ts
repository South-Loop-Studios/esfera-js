import { describe, expect, it } from "vitest";
import { presetAllowedForOrder, SCENE_PRESETS } from "../src/index.js";

describe("presetAllowedForOrder", () => {
  it("refuses only the 3OA scene presets for a 1OA/2OA ambisonic source", () => {
    expect(SCENE_PRESETS).toEqual(["bed714_3oa", "oa3"]);
    for (const p of SCENE_PRESETS) {
      expect(presetAllowedForOrder(p, 1)).toBe(false);
      expect(presetAllowedForOrder(p, 2)).toBe(false);
      expect(presetAllowedForOrder(p, 3)).toBe(true);
      expect(presetAllowedForOrder(p, null)).toBe(true);
      expect(presetAllowedForOrder(p, undefined)).toBe(true);
    }
    expect(presetAllowedForOrder("esfera", 1)).toBe(true);
    expect(presetAllowedForOrder("youtube", 2)).toBe(true);
  });
});
