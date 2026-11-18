// How a master is cut into storage multipart parts. Mirrors the web app's
// lib/multipartPlan.ts exactly — the two clients must agree.
//
// Storage rules: parts >= 5 MiB except the last, at most 10,000 parts. Ours:
// 8 MiB parts, four in flight, eight from 1 GiB.

const MIB = 1024 * 1024;

/** Above this a file goes as parallel parts; at or below, one presigned PUT. */
export const MULTIPART_THRESHOLD = 16 * MIB;
const BASE_PART_SIZE = 8 * MIB;
const MAX_PARTS = 10_000;
const WIDE_PIPE_BYTES = 1024 * MIB;

export function shouldUseMultipart(size: number): boolean {
  return size > MULTIPART_THRESHOLD;
}

export interface MultipartPlan {
  partSize: number;
  partCount: number;
  concurrency: number;
}

export function planMultipart(size: number): MultipartPlan {
  let partSize = BASE_PART_SIZE;
  if (size / partSize > MAX_PARTS) {
    // Grow the part to stay under the cap, rounded up to a whole MiB.
    partSize = Math.ceil(size / MAX_PARTS / MIB) * MIB;
  }
  const partCount = Math.max(1, Math.ceil(size / partSize));
  const concurrency = size >= WIDE_PIPE_BYTES ? 8 : 4;
  return { partSize, partCount, concurrency };
}
