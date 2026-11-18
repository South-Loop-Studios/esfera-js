/**
 * `esfera.files.inspect(source)` — what a WAV / RF64 master declares, read
 * locally in milliseconds with no upload: sample rate, channels, duration,
 * whether it carries ADM, and how many programmes it declares. Use it before
 * `conversions.create()` to refuse a non-ADM or over-length file for free.
 */
import { inspectBlob, inspectFile, parseBwfChunks } from "../bwf.js";
import { InvalidRequestError } from "../errors.js";
import type { BwfInfo } from "../types.js";
import type { ResolvedSource } from "../upload.js";

export class FilesResource {
  async inspect(source: string | Blob): Promise<BwfInfo> {
    const info = typeof source === "string" ? await inspectFile(source) : await inspectBlob(source);
    if (!info) {
      const name = typeof source === "string" ? source : (source as File).name || "the source";
      throw new InvalidRequestError({
        status: 400, type: "https://esfera.audio/errors/invalid-request", title: "Invalid request",
        detail: `${name} is not a WAV/RF64 file`,
      });
    }
    return info;
  }
}

/** Inspector for `conversions.create()`: works on any re-readable resolved source. */
export async function inspectResolvedSource(source: ResolvedSource): Promise<{ durationSec: number; programmeCount: number } | null> {
  if (!source.read) return null;
  const read = source.read;
  const info = await parseBwfChunks(read, source.size);
  return info ? { durationSec: info.durationSec, programmeCount: info.programmeCount } : null;
}
