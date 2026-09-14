import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, redactConfig, defaultConfig, configureRescueAgent } from "./config.js";

/** config 安全回归测试（bug-bash#2 B4：chmod 600 + 脱敏）。 */

test("config: writeConfig sets 0600 permissions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "phonon-cfg-")), "config.json");
  const cfg = defaultConfig();
  cfg.adapters = [{ type: "openclaw-gateway", gatewayToken: "secret-gw-token" }];
  writeConfig(cfg, path);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("config: rescue API key is redacted and file/env references remain usable", () => {
  const cfg = configureRescueAgent(defaultConfig(), {
    baseUrl: "https://example.test/v1/", model: "rescue-model", apiKey: "rescue-secret-1234",
  });
  assert.equal(cfg.rescueAgent?.baseUrl, "https://example.test/v1");
  assert.equal(cfg.rescueAgent?.model, "rescue-model");
  const redacted = redactConfig(cfg);
  assert.equal(redacted.rescueAgent?.apiKey, "***1234");
});

test("config: redactConfig masks all secrets but keeps last4", () => {
  const cfg = defaultConfig();
  cfg.adapters = [
    { type: "openclaw-gateway", gatewayToken: "gw-secret-1234" },
    { type: "claude-code", claudeAuthToken: "claude-secret-5678" },
    { type: "codex", codexApiKey: "codex-secret-9012" },
  ];
  cfg.rescueAgent = { enabled: true, baseUrl: "https://example.test/v1", model: "rescue", apiKey: "rescue-secret-6789" };
  cfg.servers = [{ url: "ws://x", deviceKey: "dev-secret-3456" }];
  cfg.hookBridge = { token: "hook-secret-7890" };
  cfg.obs = { token: "obs-secret-2345" };
  const json = JSON.stringify(redactConfig(cfg));
  for (const s of ["gw-secret-1234", "claude-secret-5678", "codex-secret-9012", "rescue-secret-6789", "dev-secret-3456", "hook-secret-7890", "obs-secret-2345"]) {
    assert.equal(json.includes(s), false, `secret leaked: ${s}`);
  }
  assert.ok(json.includes("1234"), "should keep last4 for identification");
});

test("config: explicit loopback no-auth is opt-in and rejects remote/mixed credentials", async () => {
  for (const baseUrl of ["http://127.0.0.1:4000/v1", "http://localhost:4000/v1", "http://[::1]:4000/v1"]) {
    const cfg = configureRescueAgent(defaultConfig(), { baseUrl, model: "local-model", authMode: "none" });
    assert.equal(cfg.rescueAgent?.authMode, "none");
    assert.equal(cfg.rescueAgent?.apiKey, undefined);
  }
  assert.throws(() => configureRescueAgent(defaultConfig(), { baseUrl: "https://example.test/v1", model: "m", authMode: "none" }), /loopback/);
  assert.throws(() => configureRescueAgent(defaultConfig(), { baseUrl: "http://127.0.0.1:4000/v1", model: "m" }), /API key/);
  assert.throws(() => configureRescueAgent(defaultConfig(), { baseUrl: "http://127.0.0.1:4000/v1", model: "m", authMode: "none", apiKeyEnv: "UNUSED_TEST_REFERENCE" }), /cannot be combined/);
  const { probeRescueEndpoint } = await import("./config.js");
  const denied = await probeRescueEndpoint({ baseUrl: "https://example.test/v1", model: "m", authMode: "none" });
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /loopback/);
});

test("config: no-auth probe sends no Authorization and preserves HTTP failure", async () => {
  const { createServer } = await import("node:http");
  const { probeRescueEndpoint } = await import("./config.js");
  let authorization: string | undefined;
  let requestedPath: string | undefined;
  const server = createServer((req, res) => {
    authorization = req.headers.authorization;
    requestedPath = req.url;
    req.resume();
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "test transport rejection, not a model response" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const result = await probeRescueEndpoint({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "m", authMode: "none" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(requestedPath, "/v1/chat/completions");
    assert.equal(authorization, undefined);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("config: transport is explicit, validated and preserved with no-auth", () => {
  const cfg = configureRescueAgent(defaultConfig(), { baseUrl: "http://127.0.0.1:4000/v1", model: "m", authMode: "none", wireApi: "responses" });
  assert.equal(cfg.rescueAgent?.wireApi, "responses");
  assert.equal(configureRescueAgent(cfg, { baseUrl: "http://127.0.0.1:4000/v1", model: "m", authMode: "none" }).rescueAgent?.wireApi, "chat");
  assert.throws(() => configureRescueAgent(cfg, { baseUrl: "http://127.0.0.1:4000/v1", model: "m", authMode: "none", wireApi: "invalid" as "chat" }), /wireApi/);
});

test("config: Responses probe ignores key environment and never follows redirect", async () => {
  const { createServer } = await import("node:http");
  const { probeRescueEndpoint } = await import("./config.js");
  const env = process.env;
  const paths: string[] = [];
  process.env = new Proxy(env, { get(target, key) {
    if (key === "OPENAI_API_KEY" || key === "PHONON_RESCUE_API_KEY") throw new Error("no-auth must not read key environment");
    return Reflect.get(target, key);
  } });
  const server = createServer((req, res) => {
    paths.push(req.url!);
    assert.equal(req.headers.authorization, undefined);
    req.resume();
    res.writeHead(307, { location: "/redirected" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const result = await probeRescueEndpoint({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", authMode: "none", wireApi: "responses" });
    assert.equal(result.ok, false);
    assert.deepEqual(paths, ["/v1/responses"]);
  } finally {
    process.env = env;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("config: all four explicit protocols survive persistence without selecting by model", async () => {
  const { loadConfig } = await import("./config.js");
  const { readFileSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "phonon-native-config-")), "config.json");
  for (const wireApi of ["chat", "responses", "anthropic", "gemini"] as const) {
    const cfg = configureRescueAgent(defaultConfig(), { baseUrl: "http://127.0.0.1:4000/custom/", model: "same-model-independent-of-protocol", authMode: "none", wireApi });
    writeConfig(cfg, path);
    assert.equal(loadConfig(path).rescueAgent?.wireApi, wireApi);
    assert.equal(loadConfig(path).rescueAgent?.baseUrl, "http://127.0.0.1:4000/custom");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).rescueAgent.model, "same-model-independent-of-protocol");
  }
});

test("config: SIMULATED native provider probes validate real wire tools with no auth", async () => {
  const { createServer } = await import("node:http");
  const { probeRescueEndpoint } = await import("./config.js");
  const env = process.env;
  process.env = new Proxy(env, { get(target, key) {
    if (["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "PHONON_RESCUE_API_KEY"].includes(String(key))) throw Error("unexpected key env read");
    return Reflect.get(target, key);
  } });
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) assert.equal(req.headers[name], undefined);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/messages") {
      assert.equal(body.tool_choice.type, "auto");
      res.end(JSON.stringify({ id: "sim-probe", type: "message", role: "assistant", model: "m", content: [{ type: "tool_use", id: "sim-call", name: "phonon_probe", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }));
    } else {
      assert.equal(body.toolConfig?.functionCallingConfig?.mode ?? "AUTO", "AUTO");
      res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "phonon_probe", args: {} } }] }, finishReason: "STOP" }] }));
    }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    for (const wireApi of ["anthropic", "gemini"] as const) {
      const result = await probeRescueEndpoint({ baseUrl: `http://127.0.0.1:${port}/${wireApi === "anthropic" ? "v1" : "v1beta"}`, model: "m", wireApi, authMode: "none" });
      assert.deepEqual(result, { ok: true });
    }
    assert.deepEqual(paths, ["/v1/messages", "/v1beta/models/m:generateContent"]);
  } finally { process.env = env; await new Promise<void>(r => server.close(() => r())); }
});

test("maintenance defaults register Hermes YAML and Codex TOML read-only", () => {
  const targets = defaultConfig().maintenance!.targets;
  for (const [id, format] of [["hermes", "yaml"], ["codex", "toml"]]) {
    const c = targets.find(t => t.targetId === id)!.configs![0]!;
    assert.equal(c.format, format); assert.equal(c.writable, false); assert.equal(c.textVisibility, undefined);
  }
});


test("config: discovery defaults, owner cadence merge and strict safe bounds", async () => {
  const { loadConfig } = await import("./config.js");
  const { writeFileSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "phonon-discovery-cfg-")), "config.json");
  writeFileSync(path, "{}");
  assert.deepEqual(loadConfig(path).discovery, { pollIntervalMs: 30000, scanTimeoutMs: 20000 });
  writeFileSync(path, JSON.stringify({ discovery: { pollIntervalMs: 100 } }));
  assert.deepEqual(loadConfig(path).discovery, { pollIntervalMs: 100, scanTimeoutMs: 20000 });
  for (const discovery of [{ pollIntervalMs: 0 }, { pollIntervalMs: "100" }, { pollIntervalMs: 3600001 }, { scanTimeoutMs: 49 }, { scanTimeoutMs: 120001 }]) {
    writeFileSync(path, JSON.stringify({ discovery }));
    assert.throws(() => loadConfig(path), /discovery\./);
  }
});

test("daemon: stop during initial pending inventory cannot reopen listeners or clients", async () => {
  const { PhononDaemon } = await import("./daemon.js");
  let release!: () => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const pending = new Promise<void>(r => { release = r; });
  const adapter = {
    name: "pending", capabilities: {} as never,
    async discoverAgents(s?: AbortSignal) { calls++; signal = s; await pending; return []; },
    async createSession() { throw new Error("unused"); },
  };
  const daemon = new PhononDaemon({ deviceId: "dev-stop-scan", dbPath: ":memory:", workspaceRoot: tmpdir(),
    hookBridge: { port: 0 }, obs: { enabled: false }, rescueAgent: { enabled: false }, adapters: [], servers: [],
  }, { adapters: [adapter] });
  const starting = daemon.start();
  await new Promise<void>(r => setImmediate(r));
  const stop = daemon.stop();
  assert.equal(daemon.stop(), stop, "stop is idempotent");
  await stop; await starting;
  assert.equal(signal?.aborted, true);
  release(); await new Promise<void>(r => setImmediate(r));
  assert.equal(daemon.obsPort, 0);
  assert.equal(calls, 1);
  await assert.rejects(daemon.start(), /daemon stopped/);
});
