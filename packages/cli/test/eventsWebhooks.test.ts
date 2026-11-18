import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvents } from "../src/commands/events.js";
import { runWebhooks } from "../src/commands/webhooks.js";
import { runConversions } from "../src/commands/conversions.js";
import { saveCredentials } from "../src/credentials.js";
import { EXIT } from "../src/exit.js";
import { NotFoundError, InvalidRequestError } from "@esfera/sdk";

const KEY = "esf_sk_test_v1_7fQ2mR8xKp_s3cr3ts3cr3ts3cr3ts3cr3ts3cr3t";
const conv = { id: "3f2b8c1e-5a47-4d0e-9c1a-7b6e2d8f4a10", name: "master.wav", status: "ready", stage: "done" };
const event = (id: string, type = "conversion.completed") => ({
  id, object: "event", type, mode: "sandbox", created: 1762596000, request_id: null,
  data: { object: conv, conversion: conv }, event: type, createdAt: "2025-11-08T10:00:00.000Z",
});
const hook = { id: "6c1e0f6a-2d34-4c55-8a09-1f7d3b9e2a41", object: "webhook_endpoint", mode: "sandbox", url: "https://example.com/esfera", events: ["conversion.completed"], description: "production", createdAt: "t", revokedAt: null };

function deps(opts: { confirm?: (q: string) => Promise<boolean | null>; sdk?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "esfera-ev-"));
  saveCredentials(dir, { apiKey: KEY, apiUrl: "https://api.esfera.audio" });
  const out: string[] = [], err: string[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, ret: (...a: unknown[]) => unknown) => async (...args: unknown[]) => { calls.push({ method, args }); return ret(...args); };
  const sdk = {
    events: {
      list: rec("events.list", () => ({ object: "list", data: [event("evt_2"), event("evt_1", "conversion.started")], has_more: true, next_cursor: "evt_1" })),
      get: rec("events.get", (id) => { if (id === "evt_gone") throw new NotFoundError({ status: 404, type: "https://esfera.audio/errors/not-found", title: "Not found", detail: "No such event", requestId: "req_5U4Psco0sEHr2sJaa7bGhia0" }); return event(id as string); }),
    },
    webhooks: {
      update: rec("webhooks.update", (_id, patch) => ({ ...hook, ...(patch as object) })),
      rotateSecret: rec("webhooks.rotateSecret", () => ({ ...hook, secret: "whsec_esf_new" })),
    },
    conversions: {
      list: rec("conversions.list", () => { throw new InvalidRequestError({ status: 400, type: "https://esfera.audio/errors/invalid-request", title: "Invalid request", detail: "limit must be an integer from 1 to 100", requestId: "req_AAAAAAAAAAAAAAAAAAAAAAAA" }); }),
    },
    ...opts.sdk,
  };
  const d = {
    env: {}, configDir: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s),
    terminal: { colour: "none" as const, width: 110, interactive: false }, now: () => new Date("2025-11-08T10:05:00Z"),
    sdk: () => sdk as never,
    ...(opts.confirm ? { confirm: opts.confirm } : {}),
  };
  return { d, out, err, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("esfera events", () => {
  let f: ReturnType<typeof deps>;
  afterEach(() => f?.cleanup());
  it("list maps flags to the SDK options and shows the next cursor", async () => {
    f = deps();
    expect(await runEvents(["list", "--type", "conversion.completed", "--since", "1762500000", "--until", "1762600000", "--limit", "2", "--starting-after", "evt_9"], f.d)).toBe(EXIT.ok);
    expect(f.calls[0].args[0]).toEqual({ type: "conversion.completed", createdGte: 1762500000, createdLt: 1762600000, limit: 2, startingAfter: "evt_9" });
    const t = f.out.join("");
    expect(t).toContain("evt_2");
    expect(t).toContain("conversion.started");
    expect(t).toContain("--starting-after evt_1");
  });
  it("list --json prints the data array; bad flags are usage errors", async () => {
    f = deps();
    expect(await runEvents(["list", "--json"], f.d)).toBe(EXIT.ok);
    expect(JSON.parse(f.out.join("")).map((e: { id: string }) => e.id)).toEqual(["evt_2", "evt_1"]);
    expect(await runEvents(["list", "--type", "conversion.exploded"], f.d)).toBe(EXIT.usage);
    expect(await runEvents(["list", "--limit", "101"], f.d)).toBe(EXIT.usage);
    expect(await runEvents(["list", "--since", "yesterday"], f.d)).toBe(EXIT.usage);
  });
  it("get prints the event; a refusal prints its Request-Id and exits 3", async () => {
    f = deps();
    expect(await runEvents(["get", "evt_7"], f.d)).toBe(EXIT.ok);
    expect(f.out.join("")).toContain("evt_7");
    expect(await runEvents(["get", "evt_gone"], f.d)).toBe(EXIT.refused);
    expect(f.err.join("")).toContain("req_5U4Psco0sEHr2sJaa7bGhia0");
  });
});

describe("Request-Id on every API error", () => {
  let f: ReturnType<typeof deps>;
  afterEach(() => f?.cleanup());
  it("conversions list shows it too", async () => {
    f = deps();
    expect(await runConversions(["list"], f.d)).toBe(EXIT.refused);
    expect(f.err.join("")).toContain("request  req_AAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("esfera webhooks update", () => {
  let f: ReturnType<typeof deps>;
  afterEach(() => f?.cleanup());
  it("sends only the fields given", async () => {
    f = deps();
    expect(await runWebhooks(["update", hook.id, "--events", "conversion.completed,conversion.failed", "--description", "prod"], f.d)).toBe(EXIT.ok);
    expect(f.calls[0].args).toEqual([hook.id, { events: ["conversion.completed", "conversion.failed"], description: "prod" }]);
    expect(f.out.join("")).toContain("W E B H O O K   U P D A T E D");
  });
  it("--clear-description sends null; nothing to change is a usage error; unknown types refused", async () => {
    f = deps();
    expect(await runWebhooks(["update", hook.id, "--clear-description", "--json"], f.d)).toBe(EXIT.ok);
    expect(f.calls[0].args[1]).toEqual({ description: null });
    expect(JSON.parse(f.out.join("")).id).toBe(hook.id);
    expect(await runWebhooks(["update", hook.id], f.d)).toBe(EXIT.usage);
    expect(await runWebhooks(["update", hook.id, "--events", "conversion.exploded"], f.d)).toBe(EXIT.usage);
    expect(f.calls).toHaveLength(1);
  });
});

describe("esfera webhooks rotate-secret", () => {
  let f: ReturnType<typeof deps>;
  afterEach(() => f?.cleanup());
  it("warns about the two v1 parts and asks before rotating", async () => {
    const asked: string[] = [];
    f = deps({ confirm: async (q) => { asked.push(q); return true; } });
    expect(await runWebhooks(["rotate-secret", hook.id], f.d)).toBe(EXIT.ok);
    expect(f.err.join("")).toContain("v1=<new>,v1=<old>");
    expect(asked).toHaveLength(1);
    expect(f.calls[0].args).toEqual([hook.id, {}]);
    expect(f.out.join("")).toContain("whsec_esf_new");
  });
  it("--expire-old-now warns differently and passes expireOldNow", async () => {
    f = deps({ confirm: async () => true });
    expect(await runWebhooks(["rotate-secret", hook.id, "--expire-old-now"], f.d)).toBe(EXIT.ok);
    expect(f.err.join("")).toContain("stops signing immediately");
    expect(f.calls[0].args).toEqual([hook.id, { expireOldNow: true }]);
  });
  it("answering no rotates nothing", async () => {
    f = deps({ confirm: async () => false });
    expect(await runWebhooks(["rotate-secret", hook.id], f.d)).toBe(EXIT.ok);
    expect(f.calls).toHaveLength(0);
    expect(f.err.join("")).toContain("Not rotated");
  });
  it("without a terminal it needs --yes", async () => {
    f = deps({ confirm: async () => null });
    expect(await runWebhooks(["rotate-secret", hook.id], f.d)).toBe(EXIT.usage);
    expect(f.calls).toHaveLength(0);
    expect(await runWebhooks(["rotate-secret", hook.id, "--yes", "--json"], f.d)).toBe(EXIT.ok);
    expect(JSON.parse(f.out.join("")).secret).toBe("whsec_esf_new");
  });
});
