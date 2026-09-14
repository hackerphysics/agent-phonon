/** SIMULATED native HTTP only: these fixtures are not real model acceptance. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { RescueAdapter, MaintenanceManager, PolicyEnforcer, validateRescueEndpoint } from "@agent-phonon/core";

type Native = "anthropic" | "gemini";
function response(wireApi: Native, name?: string, args: unknown = {}, finish?: string, id = "native-call-1") {
  return wireApi === "anthropic" ? {
    id: "msg_simulated", type: "message", role: "assistant", model: "mock-native",
    content: name ? [{ type: "tool_use", id, name, input: args }] : [{ type: "text", text: "SIMULATED_FINAL" }],
    stop_reason: finish ?? (name ? "tool_use" : "end_turn"), stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } : {
    candidates: [{ content: { role: "model", parts: name ? [{ functionCall: { id, name, args } }] : [{ text: "SIMULATED_FINAL" }] }, finishReason: finish ?? "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
  };
}
async function harness(wireApi: Native, handler: (body: any, count: number) => { status?: number; body?: unknown; location?: string; hang?: boolean }, run: (context: any) => Promise<void>, auth = false, writeAllowed = false, model = "mock-native") {
  const dir = mkdtempSync(join(tmpdir(), "phonon-native-sim-"));
  const file = join(dir, "fixture.json"); writeFileSync(file, '{"health":"before"}\n');
  const manager = new MaintenanceManager(new PolicyEnforcer({ policy: { allowMaintenanceRead: true, allowMaintenanceConfigWrite: writeAllowed } }), {
    backupDir: join(dir, "backups"), targets: [{ targetId: "fixture", label: "Simulated fixture", configs: [{ configId: "main", path: file, format: "json", writable: true, textVisibility: "public", allowedRootKeys: ["health"] }] }],
  });
  const requests: Array<{ path: string; headers: IncomingHttpHeaders; body: any }> = [];
  const testKey = randomUUID(); const keyFile = join(dir, "key");
  if (auth) writeFileSync(keyFile, testKey, { mode: 0o600 });
  const env = process.env;
  process.env = new Proxy(env, { get(target, key) {
    if (["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "PHONON_RESCUE_API_KEY"].includes(String(key))) throw Error("provider must not read default key env");
    return Reflect.get(target, key);
  } });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, headers: req.headers, body });
    const reply = handler(body, requests.length);
    if (reply.hang) return;
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.location ? { location: reply.location } : {}) });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${port}/${wireApi === "anthropic" ? "custom/v1" : "custom/v1beta"}`;
    const config = { baseUrl, wireApi, defaultModel: model, timeoutMs: 2000, maxSteps: 3, ...(auth ? { apiKeyRef: keyFile } : { authMode: "none" as const }) };
    const events: any[] = [];
    const send = async (overrides = {}) => {
      const adapter = new RescueAdapter({ ...config, ...overrides });
      assert.equal((await adapter.discoverAgents())[0]?.available, true);
      const session = await adapter.createSession({ sessionId: "sim", agentId: "phonon-rescue", model, cwd: dir, runtimeContext: { maintenance: manager } });
      try { await session.send("Simulated fixture", { turnId: "sim-turn", verbosity: "tools", emit: e => events.push(e) }); }
      finally { await session.terminate(); }
    };
    await run({ send, events, requests, manager, file });
    for (const req of requests) {
      assert.equal(req.path, wireApi === "anthropic" ? "/custom/v1/messages" : "/custom/v1beta/models/mock-native:generateContent");
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers[wireApi === "anthropic" ? "x-api-key" : "x-goog-api-key"], auth ? testKey : undefined);
      assert.equal(req.headers[wireApi === "anthropic" ? "x-goog-api-key" : "x-api-key"], undefined);
      if (wireApi === "anthropic") assert.equal(req.headers["anthropic-version"], "2023-06-01");
      if (wireApi === "gemini") {
        const patchTool = req.body.tools[0].functionDeclarations.find((t: any) => t.name === "patch_config");
        assert.equal(patchTool.parameters.properties.patch.type, "string");
        assert.ok(patchTool.parameters.required.includes("expectedSha256"));
        const editTool = req.body.tools[0].functionDeclarations.find((t: any) => t.name === "edit_config");
        assert.equal(editTool.parameters.properties.edits.type, "array");
        assert.equal(editTool.parameters.properties.edits.items.type, "object");
        assert.deepEqual(editTool.parameters.properties.edits.items.required.sort(), ["newText", "oldText"]);
        assert.ok(editTool.parameters.required.includes("expectedSha256"));
      }
    }
  } finally { process.env = env; await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
}

for (const wireApi of ["anthropic", "gemini"] as const) {
  for (const auth of [false, true]) test(`SIMULATED ${wireApi}: ${auth ? "key-ref official header" : "no-auth no-env"}, tool IDs/results/step text`, async () => {
    await harness(wireApi, (_body, n) => ({ body: response(wireApi, n === 1 ? "list_targets" : undefined) }), async ({ send, events, requests }: any) => {
      await send();
      assert.equal(requests.length, 2);
      const calls = events.filter((e: any) => e.type === "tool_call"); const results = events.filter((e: any) => e.type === "tool_result");
      assert.equal(calls.length, 1); assert.equal(results.length, 1);
      assert.equal(calls[0].toolCallId, "native-call-1"); assert.equal(results[0].toolCallId, calls[0].toolCallId); assert.equal(results[0].ok, true);
      const replay = JSON.stringify(requests[1].body);
      assert.ok(replay.includes("native-call-1")); assert.ok(replay.includes(wireApi === "anthropic" ? "tool_result" : "functionResponse")); assert.ok(replay.includes("fixture"));
      assert.equal(events.filter((e: any) => e.type === "message").length, 1);
      assert.equal(events.at(-1).text, "SIMULATED_FINAL"); assert.equal(events.at(-1).status, "completed");
    }, auth);
  });
  for (const failure of ["schema", "policy", "sha"] as const) test(`SIMULATED ${wireApi}: ${failure} rejected locally and real tool-error mapped`, async () => {
    const args = { targetId: "fixture", configId: "main", patch: wireApi === "gemini" ? JSON.stringify({ health: "after" }) : { health: "after" }, ...(failure !== "schema" ? { expectedSha256: "wrong-sha" } : {}) };
    await harness(wireApi, (_body, n) => ({ body: response(wireApi, n === 1 ? "patch_config" : undefined, args) }), async ({ send, events, requests, file }: any) => {
      await send();
      const calls = events.filter((e: any) => e.type === "tool_call"); const results = events.filter((e: any) => e.type === "tool_result");
      assert.equal(calls.length, 1); assert.equal(results.length, 1); assert.equal(results[0].ok, false); assert.equal(results[0].toolCallId, calls[0].toolCallId);
      assert.match(String(results[0].output), failure === "schema" ? /input|schema|validation/i : failure === "policy" ? /policy/i : /changed since read/i);
      assert.equal(readFileSync(file, "utf8"), '{"health":"before"}\n');
      assert.equal(requests.length, 2); assert.ok(JSON.stringify(requests[1].body).includes("native-call-1"));
    }, false, failure === "sha");
  });
  for (const failure of ["http", "redirect", "timeout", "steps", "length", "filtered"] as const) test(`SIMULATED ${wireApi}: ${failure} never completed or switched protocol`, async () => {
    await harness(wireApi, () => failure === "http" ? { status: 400, body: { error: { type: "invalid_request_error", message: "SIMULATED_REJECTION", code: 400, status: "INVALID_ARGUMENT" } } }
      : failure === "redirect" ? { status: 307, location: "/must-not-follow" }
      : failure === "timeout" ? { hang: true }
      : { body: response(wireApi, failure === "steps" ? "list_targets" : undefined, {}, failure === "length" ? (wireApi === "anthropic" ? "max_tokens" : "MAX_TOKENS") : failure === "filtered" ? (wireApi === "anthropic" ? "refusal" : "SAFETY") : undefined) }, async ({ send, events, requests }: any) => {
      await assert.rejects(() => send({ maxSteps: 1, timeoutMs: failure === "timeout" ? 100 : 2000 }));
      assert.equal(requests.length, 1); assert.equal(events.some((e: any) => e.type === "result"), false);
      if (failure === "steps") assert.equal(events.filter((e: any) => e.type === "tool_result").length, 1);
    });
  });
}

test("rescue protocols reject query authentication/fragment before any request", () => {
  for (const wireApi of ["chat", "responses", "anthropic", "gemini"] as const) {
    for (const suffix of ["?key=not-a-real-key", "#fragment"]) assert.throws(() => validateRescueEndpoint({ baseUrl: `http://127.0.0.1:4000/v1${suffix}`, wireApi, authMode: "none" }), /query|fragment/);
    assert.throws(() => validateRescueEndpoint({ baseUrl: "https://example.test/v1", wireApi, authMode: "none" }), /loopback/);
  }
});


test("SIMULATED gemini: resource model prefix is not doubled; missing call ID uses SDK-generated replay ID", async () => {
  await harness("gemini", (_body, n) => {
    const body: any = response("gemini", n === 1 ? "list_targets" : undefined);
    if (n === 1) delete body.candidates[0].content.parts[0].functionCall.id;
    return { body };
  }, async ({ send, events, requests }: any) => {
    await send();
    const call = events.find((e: any) => e.type === "tool_call");
    const result = events.find((e: any) => e.type === "tool_result");
    assert.ok(call.toolCallId); assert.equal(result.toolCallId, call.toolCallId);
    const replay = requests[1].body.contents.flatMap((m: any) => m.parts);
    assert.equal(replay.find((p: any) => p.functionCall)?.functionCall.id, call.toolCallId);
    assert.equal(replay.find((p: any) => p.functionResponse)?.functionResponse.id, call.toolCallId);
  }, false, false, "models/mock-native");
});


for (const value of ["not-json", "[]", "null", "42"]) test(`SIMULATED Gemini merge patch string rejects non-object JSON: ${value}`, async () => {
  await harness("gemini", (_body, n) => ({ body: response("gemini", n === 1 ? "patch_config" : undefined, { targetId: "fixture", configId: "main", expectedSha256: "not-used", patch: value }) }), async ({ send, events, file }: any) => {
    await send();
    const result = events.find((e: any) => e.type === "tool_result");
    assert.equal(result.ok, false);
    assert.equal(readFileSync(file, "utf8"), '{"health":"before"}\n');
  }, false, true);
});

test("SIMULATED Gemini JSON-string merge patch reaches the same SHA/policy-gated manager", async () => {
  const sha = createHash("sha256").update('{"health":"before"}\n').digest("hex");
  await harness("gemini", (_body, n) => ({ body: response("gemini", n === 1 ? "patch_config" : undefined, { targetId: "fixture", configId: "main", expectedSha256: sha, patch: JSON.stringify({ health: "after" }) }) }), async ({ send, events, requests, file }: any) => {
    await send();
    const result = events.find((e: any) => e.type === "tool_result");
    assert.equal(result.ok, true); assert.equal(result.output.changed, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).health, "after");
    assert.equal(typeof events.find((e: any) => e.type === "tool_call").args.patch, "string");
    const replay = requests[1].body.contents.flatMap((m: any) => m.parts).find((p: any) => p.functionCall)?.functionCall;
    assert.equal(typeof replay.args.patch, "string");
  }, false, true);
});

for (const wireApi of ["anthropic", "gemini"] as const) {
  test(`SIMULATED ${wireApi}: exact-edit array schema executes and replays IDs`, async () => {
    const args = { targetId: "fixture", configId: "main", expectedSha256: createHash("sha256").update('{"health":"before"}\n').digest("hex"), edits: [{ oldText: "before", newText: "after" }] };
    await harness(wireApi, (_body, n) => ({ body: response(wireApi, n === 1 ? "edit_config" : undefined, args, undefined, "edit-array-1") }), async ({ send, events, requests, file }: any) => {
      await send();
      assert.equal(readFileSync(file, "utf8"), '{"health":"after"}\n');
      const result = events.find((e: any) => e.type === "tool_result");
      assert.equal(result.ok, true); assert.equal(result.toolCallId, "edit-array-1");
      assert.ok(JSON.stringify(requests[1].body).includes("edit-array-1"));
      assert.ok(JSON.stringify(requests[1].body).includes("backupId"));
    }, false, true);
  });
}
