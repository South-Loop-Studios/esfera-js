import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBwfHeader, inspectFile, inspectBlob } from "../src/bwf.js";
import { FilesResource } from "../src/resources/files.js";
import { InvalidRequestError } from "../src/errors.js";

// Ported from Esfera@c34437b0:packages/esfera-cli/test/bwf.test.ts; the parser is
// now async so a Blob's slice().arrayBuffer() can serve as the reader.

/** Build a minimal RIFF/WAVE file with the given chunks. */
function riff(chunks: Array<[string, Uint8Array]>, magic = "RIFF", form = "WAVE"): Uint8Array {
  let bodyLen = 4;
  for (const [, data] of chunks) bodyLen += 8 + data.length + (data.length % 2);
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  const enc = new TextEncoder();
  out.set(enc.encode(magic), 0);
  dv.setUint32(4, bodyLen, true);
  out.set(enc.encode(form), 8);
  let off = 12;
  for (const [id, data] of chunks) {
    out.set(enc.encode(id), off);
    dv.setUint32(off + 4, data.length, true);
    out.set(data, off + 8);
    off += 8 + data.length + (data.length % 2);
  }
  return out;
}
function fmtChunk(channels: number, sampleRate: number, bits: number): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 1, true); dv.setUint16(2, channels, true); dv.setUint32(4, sampleRate, true);
  dv.setUint32(8, sampleRate * channels * (bits / 8), true); dv.setUint16(12, channels * (bits / 8), true); dv.setUint16(14, bits, true);
  return b;
}
const ADM_XML = `<?xml version="1.0"?><ebuCoreMain><coreMetadata><format>
<audioFormatExtended>
<audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="Main"/>
<audioProgramme audioProgrammeID="APR_1002" audioProgrammeName="Alt"/>
</audioFormatExtended></format></coreMetadata></ebuCoreMain>`;
function rf64(seconds: number) {
  const ds64 = new Uint8Array(28);
  const dv = new DataView(ds64.buffer);
  dv.setBigUint64(0, 0xFFFFFFFFn, true);
  dv.setBigUint64(8, BigInt(48000 * 12 * 3 * seconds), true);
  return riff([["ds64", ds64], ["fmt ", fmtChunk(12, 48000, 24)], ["data", new Uint8Array(64)]], "RF64");
}

describe("parseBwfHeader (in memory)", () => {
  it("reads sample rate, channels and duration from a plain WAV", async () => {
    const file = riff([["fmt ", fmtChunk(12, 48000, 24)], ["data", new Uint8Array(48000 * 12 * 3 * 2)]]);
    const info = (await parseBwfHeader(file))!;
    expect(info.sampleRate).toBe(48000); expect(info.channels).toBe(12); expect(info.bitsPerSample).toBe(24);
    expect(info.durationSec).toBeCloseTo(2, 5);
  });
  it("reports a plain WAV as not ADM, with no programmes", async () => {
    const info = (await parseBwfHeader(riff([["fmt ", fmtChunk(2, 48000, 24)], ["data", new Uint8Array(96)]])))!;
    expect(info.isAdm).toBe(false); expect(info.programmeCount).toBe(0);
  });
  it("derives the ambisonic order from the channel count when there is no axml", async () => {
    const order = async (ch: number) => (await parseBwfHeader(riff([["fmt ", fmtChunk(ch, 48000, 24)], ["data", new Uint8Array(96)]])))!.ambisonicOrder;
    expect(await order(4)).toBe(1);
    expect(await order(9)).toBe(2);
    expect(await order(16)).toBe(3);
    expect(await order(6)).toBeNull();
  });
  it("an ADM file is never ambisonic, whatever its channel count", async () => {
    const info = (await parseBwfHeader(riff([["fmt ", fmtChunk(16, 48000, 24)], ["axml", new TextEncoder().encode(ADM_XML)], ["data", new Uint8Array(96)]])))!;
    expect(info.ambisonicOrder).toBeNull();
  });
  it("detects ADM and counts declared programmes from the axml chunk", async () => {
    const info = (await parseBwfHeader(riff([["fmt ", fmtChunk(12, 48000, 24)], ["axml", new TextEncoder().encode(ADM_XML)], ["data", new Uint8Array(48000 * 12 * 3)]])))!;
    expect(info.isAdm).toBe(true); expect(info.programmeCount).toBe(2);
  });
  it("reports ZERO programmes for a bed-only master that declares none", async () => {
    const bedOnly = ADM_XML.replace(/<audioProgramme[^>]*\/>/g, "");
    const info = (await parseBwfHeader(riff([["fmt ", fmtChunk(12, 48000, 24)], ["axml", new TextEncoder().encode(bedOnly)], ["data", new Uint8Array(48000 * 12 * 3)]])))!;
    expect(info.isAdm).toBe(true); expect(info.programmeCount).toBe(0);
  });
  it("counts Objects-typed audioChannelFormat elements as objectCount", async () => {
    const axml = `<audioFormatExtended>
    <audioProgramme audioProgrammeID="APR_1001"/>
    <audioChannelFormat audioChannelFormatID="AC_00031001" typeLabel="0003" typeDefinition="Objects"/>
    <audioChannelFormat audioChannelFormatID="AC_00031002" typeDefinition="Objects"/>
    <audioChannelFormat audioChannelFormatID="AC_00010001" typeLabel="0001" typeDefinition="DirectSpeakers"/>
  </audioFormatExtended>`;
    const info = (await parseBwfHeader(riff([["fmt ", fmtChunk(3, 48000, 24)], ["axml", new TextEncoder().encode(axml)], ["data", new Uint8Array(48000 * 3 * 3)]])))!;
    expect(info.objectCount).toBe(2);
  });
  it("objectCount is 0 for a plain WAV", async () => {
    expect((await parseBwfHeader(riff([["fmt ", fmtChunk(2, 48000, 24)], ["data", new Uint8Array(96)]])))!.objectCount).toBe(0);
  });
  it("handles RF64, where the real sizes live in the ds64 chunk", async () => {
    expect((await parseBwfHeader(rf64(3)))!.durationSec).toBeCloseTo(3, 5);
  });
  it("handles BW64 — the EBU name for the ds64 form — exactly like RF64", async () => {
    const ds64 = new Uint8Array(28);
    const dv = new DataView(ds64.buffer);
    dv.setBigUint64(8, BigInt(64), true);
    const file = riff([["ds64", ds64], ["fmt ", fmtChunk(12, 48000, 24)], ["data", new Uint8Array(64)]], "BW64");
    const info = await parseBwfHeader(file);
    expect(info?.channels).toBe(12);
    expect(info?.sampleRate).toBe(48000);
  });
  it("returns null for something that isn't a WAV at all, or has no fmt chunk", async () => {
    expect(await parseBwfHeader(new TextEncoder().encode("this is an mp3, honest"))).toBeNull();
    expect(await parseBwfHeader(new Uint8Array(4))).toBeNull();
    expect(await parseBwfHeader(riff([["data", new Uint8Array(96)]]))).toBeNull();
  });
});

describe("RF64 with axml AFTER the data payload (Orbit's layout for a master over 4 GB)", () => {
  it("steps over the data chunk by its ds64 size and still finds the ADM", async () => {
    const dataBytes = 48000 * 12 * 3; // 1 s; the 32-bit size field carries the RF64 sentinel instead
    const ds64 = new Uint8Array(28);
    const dv = new DataView(ds64.buffer);
    dv.setBigUint64(0, 0xFFFFFFFFn, true);
    dv.setBigUint64(8, BigInt(dataBytes), true);
    const chunks: Array<[string, Uint8Array]> = [["ds64", ds64], ["fmt ", fmtChunk(12, 48000, 24)], ["data", new Uint8Array(dataBytes)], ["axml", new TextEncoder().encode(ADM_XML)]];
    const file = riff(chunks, "RF64");
    // overwrite the data chunk's 32-bit size with the sentinel, as a real RF64 writer does
    const dataHeader = 12 + (8 + 28) + (8 + 16);
    new DataView(file.buffer).setUint32(dataHeader + 4, 0xFFFFFFFF, true);
    const info = (await parseBwfHeader(file))!;
    expect(info.isAdm).toBe(true);
    expect(info.programmeCount).toBe(2);
    expect(info.durationSec).toBeCloseTo(1, 5);
  });
});

describe("inspectFile / inspectBlob", () => {
  let dir: string;
  const write = (name: string, bytes: Uint8Array) => { dir ??= mkdtempSync(join(tmpdir(), "esfera-bwf-")); const p = join(dir, name); writeFileSync(p, bytes); return p; };
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("finds axml AFTER the data payload — the real-master layout — without loading the file", async () => {
    const file = riff([["fmt ", fmtChunk(12, 48000, 24)], ["data", new Uint8Array(48000 * 12 * 3)], ["axml", new TextEncoder().encode(ADM_XML)]]);
    const info = (await inspectFile(write("axml-last.wav", file)))!;
    expect(info.isAdm).toBe(true); expect(info.programmeCount).toBe(2); expect(info.durationSec).toBeCloseTo(1, 5);
    expect(info).toEqual(await parseBwfHeader(file));
  });
  it("agrees with the in-memory parser on RF64 and on a non-WAV", async () => {
    expect(await inspectFile(write("big.wav", rf64(3)))).toEqual(await parseBwfHeader(rf64(3)));
    expect(await inspectFile(write("not.wav", new TextEncoder().encode("this is an mp3, honest")))).toBeNull();
  });
  it("reads a Blob through slice().arrayBuffer()", async () => {
    const file = riff([["fmt ", fmtChunk(12, 48000, 24)], ["data", new Uint8Array(48000 * 12 * 3)], ["axml", new TextEncoder().encode(ADM_XML)]]);
    const info = (await inspectBlob(new Blob([file])))!;
    expect(info.programmeCount).toBe(2);
    expect(info).toEqual(await parseBwfHeader(file));
  });
});

describe("FilesResource.inspect", () => {
  it("returns BwfInfo for a WAV and throws InvalidRequestError for anything else", async () => {
    const files = new FilesResource();
    const wav = new Blob([riff([["fmt ", fmtChunk(2, 48000, 16)], ["data", new Uint8Array(48000 * 2 * 2)]])]);
    expect((await files.inspect(wav)).durationSec).toBeCloseTo(1, 5);
    await expect(files.inspect(new Blob([new TextEncoder().encode("nope")]))).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
