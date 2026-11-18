import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONVERSION_FIELDS, SOURCE_FIELDS, OUTPUT_FIELDS, OUTPUT_ELEMENT_FIELDS, MIX_PRESENTATION_FIELDS, WEBHOOK_FIELDS, WEBHOOK_DELIVERY_FIELDS, USAGE_FIELDS, PROFILE_FIELDS, PRESET_FIELDS, PROBLEM_FIELDS,
  MULTIPART_INIT_REQUEST_FIELDS, MULTIPART_INIT_FIELDS, MULTIPART_PART_URL_FIELDS, MULTIPART_COMPLETE_REQUEST_FIELDS, MULTIPART_PART_FIELDS, MULTIPART_SIGN_REQUEST_FIELDS,
  CONVERSION_STATUSES, PRESETS, PROFILE_IDS, WEBHOOK_EVENT_TYPES, EVENT_TYPES, LEGACY_WEBHOOK_EVENT_TYPES,
  EVENT_FIELDS, LIST_FIELDS, WEBHOOK_CREATED_FIELDS, WEBHOOK_UPDATE_FIELDS, WEBHOOK_CREATE_FIELDS, WEBHOOK_LIST_FIELDS, WEBHOOK_DELIVERY_PAGE_FIELDS, CONVERSION_PAGE_FIELDS,
} from "../src/types.js";
import { Esfera } from "../src/index.js";

// The SDK's types against the committed OpenAPI snapshot (openapi/v1.json) —
// which `pnpm openapi:check` keeps equal to what the Esfera API serves.
const doc = JSON.parse(readFileSync(new URL("../../../openapi/v1.json", import.meta.url), "utf8"));
const schema = (name: string) => doc.components.schemas[name];
const keys = (name: string) => Object.keys(schema(name).properties).sort();
const list = (l: readonly string[]) => [...l].sort();

describe("types ↔ openapi snapshot", () => {
  it.each([
    ["Conversion", CONVERSION_FIELDS], ["Source", SOURCE_FIELDS], ["Output", OUTPUT_FIELDS], ["OutputElement", OUTPUT_ELEMENT_FIELDS], ["MixPresentation", MIX_PRESENTATION_FIELDS], ["Webhook", WEBHOOK_FIELDS], ["WebhookDelivery", WEBHOOK_DELIVERY_FIELDS],
    ["Usage", USAGE_FIELDS], ["Profile", PROFILE_FIELDS], ["Preset", PRESET_FIELDS], ["Problem", PROBLEM_FIELDS],
    ["MultipartInitRequest", MULTIPART_INIT_REQUEST_FIELDS], ["MultipartInitResponse", MULTIPART_INIT_FIELDS], ["MultipartPartUrl", MULTIPART_PART_URL_FIELDS],
    ["MultipartCompleteRequest", MULTIPART_COMPLETE_REQUEST_FIELDS], ["MultipartPart", MULTIPART_PART_FIELDS], ["MultipartSignRequest", MULTIPART_SIGN_REQUEST_FIELDS],
    ["Event", EVENT_FIELDS], ["EventList", LIST_FIELDS], ["ListEnvelope", LIST_FIELDS], ["WebhookCreateResponse", WEBHOOK_CREATED_FIELDS],
    ["UpdateWebhookRequest", WEBHOOK_UPDATE_FIELDS], ["CreateWebhookRequest", WEBHOOK_CREATE_FIELDS], ["WebhookList", WEBHOOK_LIST_FIELDS], ["WebhookDeliveryPage", WEBHOOK_DELIVERY_PAGE_FIELDS], ["ConversionPage", CONVERSION_PAGE_FIELDS],
  ] as const)("%s has exactly the schema's keys", (name, fields) => {
    expect(list(fields)).toEqual(keys(name));
  });

  it("enumerations match", () => {
    expect([...CONVERSION_STATUSES]).toEqual(schema("Conversion").properties.status.enum);
    expect([...PRESETS]).toEqual(schema("CreateConversionRequest").properties.preset.enum);
    expect([...PROFILE_IDS]).toEqual(schema("Profile").properties.id.enum);
    expect([...WEBHOOK_EVENT_TYPES]).toEqual(schema("WebhookDelivery").properties.event.enum);
    expect([...EVENT_TYPES]).toEqual(schema("Event").properties.type.enum);
    expect([...EVENT_TYPES]).toEqual(schema("Webhook").properties.events.items.enum);
    expect(Object.keys(doc.webhooks).sort()).toEqual([...EVENT_TYPES].sort());
    // The four an endpoint registered before events existed keeps (named in createWebhook's description).
    for (const t of LEGACY_WEBHOOK_EVENT_TYPES) expect(doc.paths["/v1/webhooks"].post.description).toContain(`\`${t}\``);
  });

  it("rotate-secret takes exactly { expireOldNow } and returns the endpoint plus secret", () => {
    expect(Object.keys(schema("RotateWebhookSecretRequest").properties)).toEqual(["expireOldNow"]);
    const parts = schema("WebhookRotateResponse").allOf;
    expect(parts[0].$ref).toBe("#/components/schemas/Webhook");
    expect(Object.keys(parts[1].properties)).toEqual(["secret"]);
  });

  it("every list takes starting_after and limit", () => {
    for (const p of ["/v1/conversions", "/v1/webhooks", "/v1/webhooks/{id}/deliveries", "/v1/events"]) {
      const names = doc.paths[p].get.parameters.map((x: { name: string }) => x.name);
      expect(names).toEqual(expect.arrayContaining(["starting_after", "limit"]));
    }
  });

  it("every x-esfera-sdk call names a method the SDK has", () => {
    const esfera = new Esfera({ apiKey: "k", fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    for (const ops of Object.values(doc.paths as Record<string, Record<string, { "x-esfera-sdk"?: string | null }>>)) {
      for (const op of Object.values(ops)) {
        const sample = op["x-esfera-sdk"];
        if (!sample) continue;
        for (const m of sample.matchAll(/esfera\.([a-z]+(?:\.[a-zA-Z]+)+)\(/g)) {
          let target: unknown = esfera;
          for (const part of m[1].split(".")) target = (target as Record<string, unknown>)?.[part];
          expect(typeof target, `esfera.${m[1]}`).toBe("function");
        }
      }
    }
  });

  it("the document is the one the SDK targets", () => {
    expect(doc.openapi).toBe("3.1.0");
    const operations = Object.values(doc.paths as Record<string, object>).reduce((n, ops) => n + Object.keys(ops).length, 0);
    expect(Object.keys(doc.paths)).toHaveLength(19);
    expect(operations).toBe(23);
    expect(doc.servers.map((s: { url: string }) => s.url)).toEqual(["https://api.esfera.audio", "https://staging-api.esfera.audio"]);
  });
});
