import assert from "node:assert/strict";
import {test} from "node:test";
import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {AgentCoordinationInput} from "@agent-phonon/protocol";
import {nativeMcpInputSchema} from "./native-mcp.js";

// Catalog projection contract tests: the provider-facing projection adds merged root
// properties/required for unions of strict object variants while the authoritative Zod
// schema (which the bridge still validates with) stays untouched. No transport is involved.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === "object" && !Array.isArray(item))
    return Object.keys(item).sort().reduce((sorted: Record<string, unknown>, key) => { sorted[key] = (item as Record<string, unknown>)[key]; return sorted; }, {});
  return item;
});

test("coordination projection exposes the operation discriminator and arguments at the root", () => {
  const projection = nativeMcpInputSchema(AgentCoordinationInput) as Record<string, any>;
  const properties = projection.properties as Record<string, any>;
  assert.ok(properties, "root properties must exist for providers that ignore anyOf");
  const operation = properties.operation as Record<string, any>;
  const values = Array.isArray(operation.enum) ? [...operation.enum].sort() : undefined;
  assert.deepEqual(values, ["acknowledge", "activity", "inbox", "leave", "peers", "presence", "receipt", "send"].sort());
  // Common-required intersection: only the discriminator is required by every variant.
  assert.deepEqual([...(projection.required as string[])], ["operation"]);
  // Shared identical property schemas are kept exactly once, without an anyOf wrapper.
  assert.equal(Array.isArray((properties.requestId as Record<string, any>).anyOf), false);
  assert.match(canonical(properties.requestId), /"format":"uuid"/);
  assert.equal(Array.isArray((properties.after as Record<string, any>).anyOf), false);
  // The nested activity schema is carried over with its own strict object shape intact.
  const activity = properties.activity as Record<string, any>;
  assert.equal(activity.type, "object");
  assert.deepEqual([...Object.keys(activity.properties as Record<string, unknown>)].sort(),
    ["dependencies", "impact", "phase", "summary"]);
  assert.equal(activity.additionalProperties, false);
});

test("the original union is retained verbatim and the authoritative Zod schema is unmodified", () => {
  const raw = zodToJsonSchema(AgentCoordinationInput, {$refStrategy: "none"}) as Record<string, any>;
  const before = canonical(raw);
  const projection = nativeMcpInputSchema(AgentCoordinationInput) as Record<string, any>;
  assert.deepEqual(projection.anyOf, raw.anyOf, "validators keep the exact original anyOf branches");
  for (const variant of projection.anyOf as Array<Record<string, any>>)
    assert.equal(variant.additionalProperties, false, "strict branches never lose additionalProperties:false");
  // No mutation of the original JSON Schema, and a fresh root object is returned.
  assert.equal(canonical(raw), before);
  assert.notEqual(projection, raw);
  // The authoritative validator still rejects malformed input exactly as before.
  assert.equal(AgentCoordinationInput.safeParse({}).success, false);
  assert.equal(AgentCoordinationInput.safeParse({operation: "presence", extra: 1}).success, false);
  assert.equal(AgentCoordinationInput.safeParse({operation: "send", requestId: "not-a-uuid"}).success, false);
});

test("distinct property variants are retained as unique anyOf options and literals become enums", () => {
  const union = z.discriminatedUnion("operation", [
    z.object({operation: z.literal("alpha"), value: z.string().max(10)}).strict(),
    z.object({operation: z.literal("beta"), value: z.number().int()}).strict(),
    z.object({operation: z.literal("gamma"), value: z.string().max(10), note: z.string()}).strict(),
  ]);
  const projection = nativeMcpInputSchema(union) as Record<string, any>;
  const properties = projection.properties as Record<string, any>;
  assert.deepEqual([...properties.operation.enum].sort(), ["alpha", "beta", "gamma"]);
  assert.equal(properties.operation.type, "string");
  const value = properties.value as Record<string, any>;
  assert.ok(Array.isArray(value.anyOf), "conflicting variants must both be retained");
  assert.equal(value.anyOf.length, 2);
  assert.deepEqual(value.anyOf.map((option: Record<string, any>) => option.type).sort(), ["integer", "string"]);
  assert.equal(Array.isArray((properties.note as Record<string, any>).anyOf), false);
  assert.deepEqual([...(projection.required as string[])], ["operation", "value"]);
});

test("an ordinary object schema keeps the previous projection unchanged", () => {
  const schema = z.object({name: z.string(), count: z.number().int().optional()}).strict();
  const expected = {type: "object", ...zodToJsonSchema(schema, {$refStrategy: "none"})};
  assert.deepEqual(nativeMcpInputSchema(schema), expected);
});
