import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../openapi-lib.mjs";
import { runCheck } from "../openapi-check.mjs";

const doc = { openapi: "3.1.0", paths: { "/v1/a": { get: {} }, "/v1/b": { get: {} } } };

test("normalize is stable, 2-space indented and newline-terminated", () => {
  const a = normalize(doc);
  assert.ok(a.endsWith("\n"));
  assert.equal(normalize(JSON.parse(a)), a);
  assert.ok(a.includes('\n  "paths": {'));
});

test("check passes when the served document equals the committed one", async () => {
  const r = await runCheck({ committed: normalize(doc), fetchDocument: async () => doc });
  assert.equal(r.code, 0);
  assert.match(r.message, /matches .*\(2 paths\)/);
});

test("check fails and names the path count when the served document differs", async () => {
  const served = { ...doc, paths: { ...doc.paths, "/v1/c": { get: {} } } };
  const r = await runCheck({ committed: normalize(doc), fetchDocument: async () => served });
  assert.equal(r.code, 1);
  assert.match(r.message, /differs/);
  assert.match(r.message, /3 paths/);
});

test("check fails loudly on a fetch error — a stale snapshot can't hide behind an outage", async () => {
  const r = await runCheck({ committed: normalize(doc), fetchDocument: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(r.code, 1);
  assert.match(r.message, /could not fetch/);
});
