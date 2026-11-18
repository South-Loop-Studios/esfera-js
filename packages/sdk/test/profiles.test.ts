import { describe, expect, it } from "vitest";
import { eligibleProfiles, predictProfile } from "../src/profiles.js";
import type { PresetsResponse } from "../src/types.js";

const presets: PresetsResponse = {
  engine: { orbitcore: "2.2.0" },
  profiles: [
    { id: "simple", code: 0, family: "eclipsa", label: "Simple", maxElements: 1, maxChannels: 16, objects: false, writable: true },
    { id: "base", code: 1, family: "eclipsa", label: "Base", maxElements: 2, maxChannels: 18, objects: false, writable: true },
    { id: "base-enhanced", code: 2, family: "eclipsa", label: "Base-Enhanced", maxElements: 28, maxChannels: 28, objects: false, writable: true },
    { id: "base-advanced", code: 3, family: "iamf-2", label: "Base-Advanced", maxElements: 18, maxChannels: 18, objects: true, writable: false },
    { id: "advanced-1", code: 4, family: "iamf-2", label: "Advanced-1", maxElements: 18, maxChannels: 18, objects: true, writable: true },
    { id: "advanced-2", code: 5, family: "iamf-2", label: "Advanced-2", maxElements: 28, maxChannels: 28, objects: true, writable: true },
  ],
  presets: [
    { id: "esfera", label: "Esfera", declares: ["base-enhanced", "advanced-1", "advanced-2"], objects: "keep", inputs: ["adm"], description: "" },
    { id: "youtube", label: "YouTube", declares: ["base"], objects: "fold", inputs: ["adm"], description: "" },
    { id: "bed714_3oa", label: "7.1.4 + 3OA", declares: ["base-enhanced"], objects: "scene", inputs: ["adm"], description: "" },
    { id: "oa3", label: "3OA only", declares: ["base"], objects: "scene", inputs: ["adm"], description: "" },
  ],
};

const adm = { channels: 26, objectCount: 14 };
const find = (e: ReturnType<typeof eligibleProfiles>, id: string) => e.find((x) => x.profile.id === id);
describe("eligibleProfiles", () => {
  it("greys object profiles for a bed-only master, and base-advanced always", () => {
    const e = eligibleProfiles(presets, "esfera", { channels: 12, objectCount: 0 });
    expect(find(e, "advanced-1")).toMatchObject({ eligible: false, reason: "no objects in this master" });
    expect(find(e, "base-enhanced")).toMatchObject({ eligible: true, reason: null });
    expect(find(e, "base-advanced")).toMatchObject({ eligible: false, reason: "read-only" });
  });
  it("esfera keeps objects: Eclipsa profiles grey with the object count", () => {
    const e = eligibleProfiles(presets, "esfera", adm);
    for (const id of ["simple", "base", "base-enhanced"]) expect(find(e, id)).toMatchObject({ eligible: false, reason: "this master has 14 objects" });
    expect(find(e, "advanced-2")?.eligible).toBe(true);
  });
  it("oa3 folds everything into one scene: every writable profile fits", () => {
    const e = eligibleProfiles(presets, "oa3", adm);
    for (const id of ["simple", "base", "base-enhanced", "advanced-1", "advanced-2"]) expect(find(e, id)).toMatchObject({ eligible: true, reason: null });
    expect(find(e, "base-advanced")).toMatchObject({ eligible: false, reason: "read-only" });
  });
  it("youtube folds objects to a 1OA scene: needs 2 elements", () => {
    const e = eligibleProfiles(presets, "youtube", adm);
    expect(find(e, "simple")).toMatchObject({ eligible: false, reason: "needs 2 elements · this profile holds 1" });
    expect(find(e, "base")?.eligible).toBe(true);
    expect(find(e, "advanced-1")?.eligible).toBe(true);
  });
  it("bed714_3oa needs 28 ch", () => {
    const e = eligibleProfiles(presets, "bed714_3oa", adm);
    expect(find(e, "base")).toMatchObject({ eligible: false, reason: "needs 28 ch · this profile holds 18" });
    expect(find(e, "advanced-1")).toMatchObject({ eligible: false, reason: "needs 28 ch · this profile holds 18" });
    expect(find(e, "base-enhanced")?.eligible).toBe(true);
    expect(find(e, "advanced-2")?.eligible).toBe(true);
  });
  it("esfera + 1OA ambisonic: Eclipsa fits, object profiles do not", () => {
    const e = eligibleProfiles(presets, "esfera", { channels: 4, objectCount: 0, ambisonicOrder: 1 });
    expect(find(e, "simple")?.eligible).toBe(true);
    expect(find(e, "advanced-1")).toMatchObject({ eligible: false, reason: "no objects in this master" });
  });
});
describe("predictProfile", () => {
  it("esfera + 12 ch bed-only → base-enhanced", () => expect(predictProfile(presets, "esfera", { channels: 12, objectCount: 0 })).toBe("base-enhanced"));
  it("esfera + 7.1.4 + 6 objects (18 ch) → advanced-1", () => expect(predictProfile(presets, "esfera", { channels: 18, objectCount: 6 })).toBe("advanced-1"));
  it("esfera + 28 ch with 16 objects → advanced-2", () => expect(predictProfile(presets, "esfera", { channels: 28, objectCount: 16 })).toBe("advanced-2"));
  it("a single-declares preset is itself", () => expect(predictProfile(presets, "youtube", { channels: 28, objectCount: 16 })).toBe("base"));
  it("null when nothing fits", () => expect(predictProfile(presets, "esfera", { channels: 64, objectCount: 40 })).toBeNull());
});
