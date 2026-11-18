/**
 * A running job as stage-rail rows for the live area: every stage it has
 * passed as ✓ done, then the current one — a bar while uploading or encoding
 * (the two stages anyone measures), a dim note otherwise. A stage that is skipped
 * because the server jumped past it still reads as done, which is what
 * happened: nothing ever "stops at 97 %".
 */
import { fmtBytes, type StageRow } from "../ui/parts.js";
import type { TrackedJob } from "./jobs.js";

/** The stages in order: the upload from this machine, then the server's. */
const STAGES = [
  { key: "upload",      done: "uploaded",   note: "" },
  { key: "analysing",   done: "analysed",   note: "" },
  { key: "queued",      done: "queued",     note: "waiting for a slot" },
  { key: "downloading", done: "downloaded", note: "fetching the master" },
  { key: "encoding",    done: "encoded",    note: "" },
  { key: "uploading",   done: "uploaded",   note: "storing the output" },
] as const;
type StageKey = (typeof STAGES)[number]["key"];

/** Which stage a tracked job is in now. */
export function stageOf(j: Pick<TrackedJob, "status" | "stage">): StageKey {
  switch (j.status) {
    case "uploading": return "upload";
    case "analyzing": case "analyzed": return "analysing";
    case "waiting": case "queued": return "queued";
    case "running":
      if (j.stage === "downloading") return "downloading";
      if (j.stage === "uploading" || j.stage === "done") return "uploading";
      return "encoding";
    default: return "uploading"; // ready/error: the tracker drops the job on the next tick
  }
}

export function jobRows(j: TrackedJob): StageRow[] {
  const id = j.id.replace(/^conv_/, "").slice(0, 8);
  const name = j.out.split(/[\\/]/).pop() ?? j.out;
  const where = `${id} · ${name}`;
  // The upload is the one stage this machine can measure: how far out of how
  // much, and how fast, ahead of the id so they survive a narrow terminal.
  const upload = j.upload ? `${fmtBytes(j.upload.sent)} / ${fmtBytes(j.upload.total)}${j.upload.rate !== null ? ` · ${fmtBytes(j.upload.rate)}/s` : ""} · ` : "";
  const current = stageOf(j);
  const rows: StageRow[] = [];
  for (const s of STAGES) {
    if (s.key === current) {
      rows.push(s.key === "encoding" || s.key === "upload"
        ? { state: "active", label: s.key === "upload" ? "uploading" : s.key, bar: { pct: Math.max(0, Math.min(100, j.progress)) }, suffix: s.key === "upload" ? `${upload}${where}` : where }
        : { state: "active", label: s.key, detail: `${s.key === "analysing" ? `reading the ${j.source ?? "master"}` : s.note} · ${where}` });
      break;
    }
    // "queued" is a wait, not work: once past it there is nothing to tick off.
    if (s.key !== "queued") rows.push({ state: "done", label: s.done });
  }
  return rows;
}
