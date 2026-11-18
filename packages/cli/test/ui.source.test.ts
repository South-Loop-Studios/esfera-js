import { describe, expect, it } from "vitest";
import { sourceLabel } from "../src/ui/index.js";

describe("sourceLabel", () => {
  it("names ADM, each ambisonic order, and a plain WAV", () => {
    expect(sourceLabel({ isAdm: true, ambisonicOrder: null })).toBe("ADM");
    expect(sourceLabel({ isAdm: false, ambisonicOrder: 1 })).toBe("1OA");
    expect(sourceLabel({ isAdm: false, ambisonicOrder: 2 })).toBe("2OA");
    expect(sourceLabel({ isAdm: false, ambisonicOrder: 3 })).toBe("3OA");
    expect(sourceLabel({ isAdm: false })).toBe("WAV");
  });
});
