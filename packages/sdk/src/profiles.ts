import type { Preset, PresetsResponse, Profile, ProfileId } from "./types.js";

export interface FileShape {
  channels: number;
  objectCount: number;
  /** 1–3 for an ambisonic source (no objects, one scene); null/absent otherwise. */
  ambisonicOrder?: number | null;
}
export interface ProfileEligibility { profile: Profile; eligible: boolean; reason: string | null }

/** What the preset will write for this file: how many IAMF elements, across how many channels. */
export function writtenShape(presets: PresetsResponse, preset: Preset, file: FileShape): { elements: number; channels: number } {
  if (preset === "bed714_3oa") return { elements: 2, channels: 28 };
  if (preset === "oa3") return { elements: 1, channels: 16 };
  const mode = presets.presets.find((p) => p.id === preset)?.objects ?? "keep";
  const isScene = file.ambisonicOrder != null && file.objectCount === 0;
  if (mode === "fold" && !isScene) {
    const bed = file.channels - file.objectCount;
    return { elements: (bed > 0 ? 1 : 0) + 1, channels: bed + 4 };
  }
  // keep (and a fold of an ambisonic source): the file's own elements, objects discrete.
  const bed = file.channels - file.objectCount;
  return { elements: (bed > 0 ? 1 : 0) + file.objectCount, channels: file.channels };
}

/** Every profile, in API order, with why this preset + file can't use it (read-only, objects, or budget). */
export function eligibleProfiles(presets: PresetsResponse, preset: Preset, file: FileShape): ProfileEligibility[] {
  const keep = (presets.presets.find((p) => p.id === preset)?.objects ?? "keep") === "keep" && preset !== "bed714_3oa" && preset !== "oa3";
  const shape = writtenShape(presets, preset, file);
  return presets.profiles.map((profile) => {
    let reason: string | null = null;
    if (!profile.writable) reason = "read-only";
    else if (keep && file.objectCount > 0 && !profile.objects) reason = `this master has ${file.objectCount} objects`;
    else if (keep && file.objectCount === 0 && profile.objects) reason = "no objects in this master";
    else if (profile.maxElements < shape.elements) reason = `needs ${shape.elements} elements · this profile holds ${profile.maxElements}`;
    else if (profile.maxChannels < shape.channels) reason = `needs ${shape.channels} ch · this profile holds ${profile.maxChannels}`;
    return { profile, eligible: reason === null, reason };
  });
}

/** What `auto` would declare for this preset + file, or null when the data can't decide. */
export function predictProfile(presets: PresetsResponse, preset: Preset, file: FileShape): ProfileId | null {
  const info = presets.presets.find((p) => p.id === preset);
  if (!info || info.declares.length === 0) return null;
  if (info.declares.length === 1) return info.declares[0] ?? null;
  const hasObjects = file.objectCount > 0;
  for (const id of info.declares) {
    const p = presets.profiles.find((x) => x.id === id);
    if (!p || p.objects !== hasObjects) continue;
    if (p.maxElements >= file.objectCount + 1 && p.maxChannels >= file.channels) return id;
  }
  return null;
}
