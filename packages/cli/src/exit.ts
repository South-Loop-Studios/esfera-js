import type { ApiError } from "@esfera/sdk";

/**
 * Exit codes are part of the CLI's contract — half of its use is inside
 * someone else's script. Unchanged from the first release:
 *   0 success · 1 usage · 2 pre-flight refused (nothing uploaded)
 *   3 the API refused, at ANY stage · 4 the conversion failed / stalled / unexpected
 */
export const EXIT = { ok: 0, usage: 1, preflight: 2, refused: 3, failed: 4, interrupted: 130 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An API refusal as one line, `title: detail (request req_…)`: every one-line error path uses this. */
export function apiErrorLine(err: ApiError): string {
  return `${err.title}: ${err.detail}${err.requestId ? ` (request ${err.requestId})` : ""}`;
}

/** Thrown by commands to end with a code and a message; the entry point catches it. */
export class CliExit extends Error {
  constructor(readonly code: ExitCode, message: string) {
    super(message);
    this.name = "CliExit";
  }
}

export function fail(code: ExitCode, message: string): never {
  throw new CliExit(code, message);
}

// The conversion a `convert` is following, for the SIGINT hint: the job keeps
// running server-side after ^C, and the user needs its id to come back to it.
let current: string | null = null;
export function setCurrentJob(id: string | null): void { current = id; }
export function currentJob(): string | null { return current; }
