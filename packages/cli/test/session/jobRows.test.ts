import { describe, it, expect } from "vitest";
import { jobRows, stageOf } from "../../src/session/jobRows.js";
import type { TrackedJob } from "../../src/session/jobs.js";

const job = (o: Partial<TrackedJob> = {}): TrackedJob => ({
  id: "conv_c99d21e8aa", name: "Illuma.wav", out: "/o/Illuma - Demo Track - Orbit.iamf", status: "running", stage: "encoding", progress: 42, profile: "base-enhanced", source: "ADM", startedAt: 0, ...o,
});

describe("jobRows", () => {
  it("encoding: the passed stages are done rows, the current one carries the bar", () => {
    expect(jobRows(job())).toEqual([
      { state: "done", label: "uploaded" },
      { state: "done", label: "analysed" },
      { state: "done", label: "downloaded" },
      { state: "active", label: "encoding", bar: { pct: 42 }, suffix: "c99d21e8 · Illuma - Demo Track - Orbit.iamf" },
    ]);
  });
  it("the analysing note names what the master is", () => {
    const note = (o: Partial<TrackedJob>) => jobRows(job({ status: "analyzing", stage: null, progress: 0, ...o }))[1]!.detail;
    expect(note({ source: "3OA" })).toContain("reading the 3OA ·");
    expect(note({ source: null })).toContain("reading the master ·");
  });
  it("stages the server does not measure get a note, not a 0 % bar", () => {
    expect(jobRows(job({ status: "analyzing", stage: null, progress: 0 }))).toEqual([
      { state: "done", label: "uploaded" },
      { state: "active", label: "analysing", detail: "reading the ADM · c99d21e8 · Illuma - Demo Track - Orbit.iamf" },
    ]);
    expect(jobRows(job({ status: "queued", stage: null, progress: 0 })).map((r) => r.label)).toEqual(["uploaded", "analysed", "queued"]);
    expect(jobRows(job({ status: "running", stage: "downloading", progress: 0 })).map((r) => [r.state, r.label])).toEqual([
      ["done", "uploaded"], ["done", "analysed"], ["active", "downloading"],
    ]);
    // The upload from this machine is measured, so it gets a bar and nothing is ticked yet.
    expect(jobRows(job({ id: "local-1", status: "uploading", stage: null, progress: 50 }))).toEqual([
      { state: "active", label: "uploading", bar: { pct: 50 }, suffix: "local-1 · Illuma - Demo Track - Orbit.iamf" },
    ]);
  });
  it("uploading with a meter: sent / total and the rate lead the suffix; no rate until it can be measured", () => {
    const up = (rate: number | null) => jobRows(job({ id: "local-1", status: "uploading", stage: null, progress: 42, upload: { sent: 1_230_000_000, total: 2_900_000_000, rate } }))[0]!.suffix;
    expect(up(48_200_000)).toBe("1.2 GB / 2.9 GB · 48.2 MB/s · local-1 · Illuma - Demo Track - Orbit.iamf");
    expect(up(null)).toBe("1.2 GB / 2.9 GB · local-1 · Illuma - Demo Track - Orbit.iamf");
    expect(jobRows(job({ status: "running", stage: "encoding", progress: 42, upload: { sent: 1, total: 1, rate: 1 } }))[3]!.suffix).toBe("c99d21e8 · Illuma - Demo Track - Orbit.iamf");
    expect(jobRows(job({ id: "local-1", status: "uploading", stage: null, progress: 42 }))).toEqual([
      { state: "active", label: "uploading", bar: { pct: 42 }, suffix: "local-1 · Illuma - Demo Track - Orbit.iamf" },
    ]);
  });
  it("after encoding, the encode row reads done — never stuck at its last percentage", () => {
    const rows = jobRows(job({ stage: "uploading", progress: 97 }));
    expect(rows.map((r) => [r.state, r.label])).toEqual([["done", "uploaded"], ["done", "analysed"], ["done", "downloaded"], ["done", "encoded"], ["active", "uploading"]]);
    expect(rows.some((r) => r.bar)).toBe(false);
  });
  it("stageOf maps every server status somewhere sensible", () => {
    expect(stageOf({ status: "running", stage: null })).toBe("encoding");
    expect(stageOf({ status: "running", stage: "done" })).toBe("uploading");
    expect(stageOf({ status: "waiting", stage: null })).toBe("queued");
    expect(stageOf({ status: "ready", stage: null })).toBe("uploading");
  });
});
