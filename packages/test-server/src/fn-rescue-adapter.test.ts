import { test } from "node:test";
import assert from "node:assert/strict";
import { RescueAdapter } from "@agent-phonon/core";

const stubMaintenance = {
  targets: async () => ({ permissions: { read: true, configWrite: false, packageUpdate: false, serviceRestart: false }, targets: [] }),
  diagnose: async () => ({ diagnostics: [], at: new Date().toISOString() }),
  configGet: async () => ({ targetId: "x", configId: "y", exists: false }),
  configEdit: async () => { throw new Error("denied"); },
  configPatch: async () => { throw new Error("denied"); },
  rollback: async () => { throw new Error("denied"); },
  packageUpdate: async () => { throw new Error("denied"); },
  serviceStatus: async () => ({ targetId: "x", serviceId: "s", status: "not_configured" as const }),
  serviceRestart: async () => ({ targetId: "x", serviceId: "s", restarted: false, status: "not_configured" as const }),
};

test("phonon-rescue honestly declares no blocking HITL hooks", () => {
  assert.deepEqual(new RescueAdapter().capabilities.hooks, []);
});

test("phonon-rescue is always discoverable but unavailable without endpoint config", async () => {
  const adapter = new RescueAdapter();
  const [agent] = await adapter.discoverAgents();
  assert.equal(agent?.agentId, "phonon-rescue");
  assert.equal(agent?.available, false);
  assert.match(agent?.unavailableReason ?? "", /baseUrl/);
});

test("phonon-rescue discovery exposes configured model", async () => {
  const adapter = new RescueAdapter({ baseUrl: "https://example.test/v1", apiKey: "secret", defaultModel: "rescue-model" });
  const [agent] = await adapter.discoverAgents();
  assert.equal(agent?.available, true);
  assert.deepEqual(agent?.models.map((m) => m.id), ["rescue-model"]);
});

test("phonon-rescue requires tenant-bound maintenance runtime", async () => {
  const adapter = new RescueAdapter({ baseUrl: "https://example.test/v1", apiKey: "secret", defaultModel: "rescue-model" });
  await assert.rejects(() => adapter.createSession({ sessionId: "s1", agentId: "phonon-rescue", model: "rescue-model", cwd: "." }), /maintenance runtime/);
  await assert.rejects(() => adapter.createSession({
    sessionId: "s-wrong", agentId: "phonon-rescue", model: "server-selected-model", cwd: ".",
    runtimeContext: { maintenance: stubMaintenance },
  }), /only allows the locally configured model/);
  const session = await adapter.createSession({
    sessionId: "s1", agentId: "phonon-rescue", model: "rescue-model", cwd: ".",
    runtimeContext: { maintenance: stubMaintenance },
  });
  assert.equal(session.sessionId, "s1");
});

test("phonon-rescue no-auth discovery is loopback-only and opt-in", async () => {
  const options = { baseUrl: "http://127.0.0.1:4000/v1", defaultModel: "local-model", authMode: "none" as const };
  assert.equal((await new RescueAdapter(options).discoverAgents())[0]?.available, true);
  assert.equal((await new RescueAdapter({ ...options, baseUrl: "https://example.test/v1" }).discoverAgents())[0]?.available, false);
  assert.equal((await new RescueAdapter({ ...options, apiKeyRef: "/not/read/in/no-auth" }).discoverAgents())[0]?.available, false);
  assert.equal((await new RescueAdapter({ ...options, authMode: "invalid" as "none" }).discoverAgents())[0]?.available, false);
});

test("phonon-rescue SDK sends no Authorization in no-auth mode; rejects transport error", async () => {
  const { createServer } = await import("node:http");
  let authorization: string | undefined;
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    authorization = req.headers.authorization;
    req.resume();
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "test transport rejection, not a model response" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const adapter = new RescueAdapter({ baseUrl: `http://127.0.0.1:${address.port}/v1`, authMode: "none", defaultModel: "local-model", timeoutMs: 5000 });
    const session = await adapter.createSession({ sessionId: "no-auth", agentId: "phonon-rescue", model: "local-model", cwd: ".", runtimeContext: { maintenance: stubMaintenance } });
    const events: Array<{ type: string }> = [];
    await assert.rejects(() => session.send("test", { turnId: "no-auth-turn", verbosity: "tools", emit: (event) => { events.push(event); } }));
    assert.equal(requests, 1);
    assert.equal(authorization, undefined);
    assert.equal(events.some((event) => event.type === "result"), false);
    await session.terminate();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("phonon-rescue rejects invalid transport in discovery", async () => {
  const [agent] = await new RescueAdapter({ baseUrl: "http://127.0.0.1:4000/v1", authMode: "none", defaultModel: "local-model", wireApi: "invalid" as "chat" }).discoverAgents();
  assert.equal(agent?.available, false);
  assert.match(agent?.unavailableReason ?? "", /wireApi/);
});

test("phonon-rescue Responses SDK uses no key factory or redirect following", async () => {
  const { createServer } = await import("node:http");
  const env = process.env;
  process.env = new Proxy(env, { get(target, key) {
    if (key === "OPENAI_API_KEY" || key === "PHONON_RESCUE_API_KEY") throw new Error("no-auth must not read key environment");
    return Reflect.get(target, key);
  } });
  const paths: string[] = [];
  const bodies: Array<{ store?: boolean; parallel_tool_calls?: boolean }> = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    assert.equal(req.headers.authorization, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(307, { location: "/redirected" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const adapter = new RescueAdapter({ baseUrl: `http://127.0.0.1:${port}/v1`, authMode: "none", wireApi: "responses", defaultModel: "local-model", timeoutMs: 5000 });
    const session = await adapter.createSession({ sessionId: "responses-no-auth", agentId: "phonon-rescue", model: "local-model", cwd: ".", runtimeContext: { maintenance: stubMaintenance } });
    const events: Array<{ type: string }> = [];
    await assert.rejects(() => session.send("test", { turnId: "responses-no-auth-turn", verbosity: "tools", emit: (event) => { events.push(event); } }));
    assert.ok(paths.length >= 1);
    assert.ok(paths.every((p) => p === "/v1/responses"));
    assert.ok(bodies.every((b) => b.store === false && b.parallel_tool_calls === false));
    assert.equal(events.some((e) => e.type === "result"), false);
    await session.terminate();
  } finally {
    process.env = env;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("phonon-rescue SDK timeout is not reported as completed in either transport", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req) => { req.resume(); }); // No model response; exercise cancellation only.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    for (const wireApi of ["chat", "responses"] as const) {
      const adapter = new RescueAdapter({ baseUrl: `http://127.0.0.1:${port}/v1`, authMode: "none", wireApi, defaultModel: "local-model", timeoutMs: 100 });
      const session = await adapter.createSession({ sessionId: `timeout-${wireApi}`, agentId: "phonon-rescue", model: "local-model", cwd: ".", runtimeContext: { maintenance: stubMaintenance } });
      const events: Array<{ type: string }> = [];
      await assert.rejects(() => session.send("test", { turnId: `timeout-${wireApi}-turn`, verbosity: "tools", emit: (event) => { events.push(event); } }), /abort|time/i);
      assert.equal(events.some((e) => e.type === "result"), false);
      await session.terminate();
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("SIMULATED Chat and Responses step exhaustion cannot report completed", async () => {
  const { createServer } = await import("node:http");
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; req.resume();
    if (req.url === "/v1/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "sim-response", output: [{ type: "function_call", id: "sim-item", call_id: "sim-call", name: "list_targets", arguments: "{}" }] }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: ' + JSON.stringify({ id: "sim-response", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "sim-call", type: "function", function: { name: "list_targets", arguments: "{}" } }] }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: "sim-response", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + '\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    for (const wireApi of ["chat", "responses"] as const) {
      const session = await new RescueAdapter({ baseUrl: `http://127.0.0.1:${port}/v1`, wireApi, authMode: "none", defaultModel: "mock", maxSteps: 1, timeoutMs: 2000 }).createSession({ sessionId: "sim-limit", agentId: "phonon-rescue", model: "mock", cwd: ".", runtimeContext: { maintenance: stubMaintenance } });
      const events: any[] = [];
      try {
        await assert.rejects(() => session.send("simulated exhaustion", { turnId: "sim-turn", verbosity: "tools", emit: e => events.push(e) }), /step limit/);
        assert.equal(events.filter(e => e.type === "tool_call").length, 1);
        assert.equal(events.filter(e => e.type === "tool_result").length, 1);
        assert.equal(events.find(e => e.type === "tool_result").toolCallId, "sim-call");
        assert.equal(events.some(e => e.type === "result"), false);
      } finally { await session.terminate(); }
    }
    assert.equal(requests, 2);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
