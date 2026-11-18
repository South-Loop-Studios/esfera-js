/**
 * Local pre-flight for a WAV / RF64 / BW64 master — what the file DECLARES about
 * itself, read from the chunk table. No audio is decoded; cost is the size of
 * the ADM metadata (`axml`), never the size of the file.
 *
 * Ported from the Esfera CLI (Esfera@c34437b0:packages/esfera-cli/src/bwf.ts),
 * made async so a Blob's `slice().arrayBuffer()` can serve as the reader next
 * to positional file reads. The chunk order is a writer's choice, not a spec
 * guarantee: Orbit's own export writes `axml` AFTER the audio payload, so the
 * table is walked to the end rather than sampled from a bounded head.
 *
 * RF64: a master over 4 GB cannot express its size in the 32-bit RIFF field;
 * the magic becomes "RF64", the sizes read 0xFFFFFFFF, and the 64-bit truth
 * lives in a leading `ds64` chunk.
 */
import type { BwfInfo } from "./types.js";

/** Random access over the bytes: up to `length` bytes at `offset`, fewer at EOF. */
export type ChunkReader = (offset: number, length: number) => Promise<Uint8Array>;

/** Ceiling on the `axml` body we hold: real ADM metadata is MBs; past this is malformed or hostile. */
const MAX_AXML_BYTES = 64 * 1024 * 1024;

const ascii = (buf: Uint8Array, off: number, len: number) => String.fromCharCode(...buf.subarray(off, off + len));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export async function parseBwfChunks(read: ChunkReader, fileSize: number): Promise<BwfInfo | null> {
  const head = await read(0, 12);
  if (head.length < 12) return null;
  const magic = ascii(head, 0, 4);
  // BW64 (EBU Tech 3306) is the ds64 form by its own name; the chunk mechanics are RF64's.
  if (magic !== "RIFF" && magic !== "RF64" && magic !== "BW64") return null;
  if (ascii(head, 8, 4) !== "WAVE") return null;

  let sampleRate = 0, channels = 0, bitsPerSample = 0;
  let dataSize = -1, ds64DataSize = -1;
  let isAdm = false, programmeCount = 0, objectCount = 0;

  let off = 12;
  while (off + 8 <= fileSize) {
    const header = await read(off, 8);
    if (header.length < 8) break;
    const id = ascii(header, 0, 4);
    const size = view(header).getUint32(4, true);
    const body = off + 8;
    if (id === "ds64") {
      const b = await read(body, 16);
      if (b.length >= 16) ds64DataSize = Number(view(b).getBigUint64(8, true));
    } else if (id === "fmt ") {
      const b = await read(body, 16);
      if (b.length >= 16) {
        const dv = view(b);
        channels = dv.getUint16(2, true);
        sampleRate = dv.getUint32(4, true);
        bitsPerSample = dv.getUint16(14, true);
      }
    } else if (id === "data") {
      dataSize = size; // the payload is stepped over, never read
    } else if (id === "axml") {
      const b = await read(body, Math.min(size, MAX_AXML_BYTES));
      const xml = new TextDecoder().decode(b);
      isAdm = xml.includes("audioFormatExtended");
      programmeCount = (xml.match(/<audioProgramme[\s>]/g) ?? []).length;
      objectCount = (xml.match(/<audioChannelFormat\b[^>]*>/g) ?? []).filter((t) => /typeDefinition="Objects"|typeLabel="0003"/.test(t)).length;
    }
    if (size === 0xffffffff) {
      // RF64 sentinel. For the data chunk the real size is in ds64 — step over
      // the payload with it, because Orbit writes `axml` AFTER the audio.
      if (id === "data" && ds64DataSize >= 0) { off = body + ds64DataSize + (ds64DataSize % 2); continue; }
      break;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }

  if (!sampleRate || !channels || !bitsPerSample) return null;
  const bytes = ds64DataSize >= 0 ? ds64DataSize : dataSize;
  if (bytes < 0) return null;
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const ambisonicOrder = isAdm ? null : channels === 4 ? 1 : channels === 9 ? 2 : channels === 16 ? 3 : null;
  return { sampleRate, channels, bitsPerSample, durationSec: bytesPerSecond > 0 ? bytes / bytesPerSecond : 0, isAdm, programmeCount, objectCount, ambisonicOrder };
}

/** Parse bytes already in memory (tests, small files). */
export function parseBwfHeader(buf: Uint8Array): Promise<BwfInfo | null> {
  return parseBwfChunks(
    async (offset, length) => buf.subarray(Math.min(offset, buf.length), Math.min(offset + length, buf.length)),
    buf.length,
  );
}

/** Reader over a Blob/File — the browser-side and test-side source. */
export function readerForBlob(blob: Blob): ChunkReader {
  return async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

export function inspectBlob(blob: Blob): Promise<BwfInfo | null> {
  return parseBwfChunks(readerForBlob(blob), blob.size);
}

/** Node only: positional reads on an open handle; peak memory is the `axml` chunk. */
export async function inspectFile(path: string): Promise<BwfInfo | null> {
  const fsp = await import("node:fs/promises");
  const fh = await fsp.open(path, "r");
  try {
    const size = (await fh.stat()).size;
    return await parseBwfChunks(async (offset, length) => {
      if (length <= 0 || offset >= size) return new Uint8Array(0);
      const want = Math.min(length, size - offset);
      const buf = new Uint8Array(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      return buf.subarray(0, bytesRead);
    }, size);
  } finally {
    await fh.close();
  }
}
