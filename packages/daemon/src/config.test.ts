import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_TYPES, writeConfig, redactConfig, defaultConfig, configureRescueAgent, loadConfig, type AdapterConfig } from "./config.js";
import { autoDetectAdapters, buildRegistry } from "./commands.js";
import * as core from "@agent-phonon/core";
import { fileURLToPath } from "node:url";
import { PhononDaemon } from "./daemon.js";
import { AdapterRegistry, CopilotAdapter, HermesAdapter } from "@agent-phonon/core";
import { withPeerFixture } from "../../core/dist/testing/peer-fixture.js";
import { hermesProfileFixture } from "./hermes-profile.test-fixture.js";

function configuredHermes(f: ReturnType<typeof hermesProfileFixture>, flag?: boolean) {
  const cfg = defaultConfig(), missing = join(f.root, "not-installed"), path = join(f.root, "daemon.json");
  cfg.dbPath = join(f.root, "state.db"); cfg.workspaceRoot = f.root; cfg.servers = []; cfg.rescueAgent = { enabled: false }; cfg.obs = { enabled: false };
  cfg.adapters = [{ type: "hermes", hermesBinPath: f.entry, hermesModel: "selected-model", hermesManagedProfileNativeTools: flag },
    { type: "opencode", opencodeBinPath: missing }, { type: "copilot", copilotBinPath: missing }, { type: "pi", piBinPath: missing },
    { type: "claude-code", claudeBinPath: missing }, { type: "codex", codexBinPath: missing }];
  writeConfig(cfg, path);
  const daemon = new PhononDaemon(loadConfig(path));
  const adapter = (daemon as unknown as { registry: AdapterRegistry }).registry.resolve("hermes:default");
  assert.ok(adapter instanceof HermesAdapter);
  return { daemon, adapter };
}

test("config: only the owner selects Claude Agent SDK paths and both registry constructors retain them", () => withPeerFixture("claude-sdk-config", async scope => {
  const path = join(scope.root, "config.json"), sdkPath = join(scope.root, "sdk.mjs");
  const cfg = defaultConfig(); cfg.dbPath = join(scope.root, "state.sqlite"); cfg.workspaceRoot = scope.root; cfg.servers = [];
  cfg.rescueAgent = { enabled: false }; cfg.obs = { enabled: false };
  cfg.adapters = [{ type: "claude-code", claudeBinPath: join(scope.root, "not-installed"), claudeSdkPath: sdkPath }];
  writeConfig(cfg, path); const loaded = loadConfig(path), daemon = new PhononDaemon(loaded);
  try {
    for (const registry of [buildRegistry(loaded.adapters, { enabled: false }), (daemon as unknown as { registry: AdapterRegistry }).registry]) {
      const adapter = registry.resolve("claude-code"); assert.ok(adapter instanceof core.ClaudeCodeAdapter);
      assert.equal((adapter as unknown as { env: { sdkPath?: string } }).env.sdkPath, sdkPath);
    }
  } finally { await daemon.stop(); }
  for (const value of ["relative-sdk", true, null, "bad\0path", sdkPath + "\n"]) {
    writeFileSync(path, JSON.stringify({ ...cfg, adapters: [{ ...cfg.adapters[0], claudeSdkPath: value }] }));
    assert.throws(() => loadConfig(path), /claudeSdkPath must be an absolute local runtime path/);
  }
}));

test("config: Copilot peer receive is a strict local default-off option passed unchanged to its adapter", () => withPeerFixture("copilot-peer-config", async scope => {
  const path = join(scope.root, "config.json");
  for (const flag of [undefined, false, true]) {
    const cfg = defaultConfig(); cfg.dbPath = join(scope.root, "state.sqlite"); cfg.workspaceRoot = scope.root; cfg.servers = [];
    cfg.rescueAgent = { enabled: false }; cfg.obs = { enabled: false };
    cfg.adapters = [{ type: "copilot", copilotBinPath: join(scope.root, "not-installed"), ...(flag === undefined ? {} : { copilotPeerContext: flag }) }];
    writeConfig(cfg, path); const loaded = loadConfig(path);
    assert.equal(loaded.adapters[0]?.copilotPeerContext, flag);
    const daemon = new PhononDaemon(loaded);
    try {
      const adapter = (daemon as unknown as { registry: AdapterRegistry }).registry.resolve("copilot");
      assert.ok(adapter instanceof CopilotAdapter);
      assert.equal((adapter as unknown as { env: { peerContext?: boolean } }).env.peerContext, flag);
    } finally { await daemon.stop(); }
  }
  for (const flag of ["true", 1, null, {}]) {
    const cfg = defaultConfig(); cfg.adapters = [{ type: "copilot", copilotPeerContext: flag as boolean }];
    writeConfig(cfg, path); assert.throws(() => loadConfig(path), /copilotPeerContext must be a boolean/);
  }
}));

test("config: removed and unknown adapters are rejected without migration or config writes", () => withPeerFixture("unsupported-adapter-config", async scope => {
  const path = join(scope.root, "config.json");
  for (const type of ["herdr", "herdr:codex", "unknown-adapter"]) {
    const source = JSON.stringify({ ...defaultConfig(), adapters: [{ type }] });
    writeFileSync(path, source, { mode: 0o600 });
    assert.throws(() => loadConfig(path), /unsupported adapter type/);
    const adapters = [{ type }] as AdapterConfig[];
    assert.throws(() => autoDetectAdapters(adapters), /unsupported adapter type/);
    assert.throws(() => buildRegistry(adapters, { enabled: false }), /unsupported adapter type/);
    assert.equal(readFileSync(path, "utf8"), source);
  }
}));

test("runtime scope: only maintained native adapters are exported and implemented", () => {
  assert.deepEqual([...ADAPTER_TYPES], ["openclaw-gateway", "openclaw-cli", "claude-code", "codex", "hermes", "opencode", "copilot", "pi"]);
  assert.equal("HerdrAdapter" in core, false);
  function check(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) check(path);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.") && !entry.name.endsWith(".d.ts")) {
        assert.doesNotMatch(entry.name, /herdr/i, path);
        assert.doesNotMatch(readFileSync(path, "utf8"), /herdr/i, path);
      }
    }
  }
  check(fileURLToPath(new URL("../../core/src/", import.meta.url)));
  check(fileURLToPath(new URL("../src/", import.meta.url)));
});

test("config: employee file runtime assets are an optional absolute local setting",()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-profile-assets-")),path=join(root,"config.json");
  try{
    const cfg=defaultConfig();cfg.employeeProfileFileBrokerRoot=join(root,"native-fs");writeConfig(cfg,path);
    assert.equal(loadConfig(path).employeeProfileFileBrokerRoot,cfg.employeeProfileFileBrokerRoot);
    for(const value of ["relative-assets",true,null,"bad\0path"]){
      writeFileSync(path,JSON.stringify({...cfg,employeeProfileFileBrokerRoot:value}));assert.throws(()=>loadConfig(path),/absolute local runtime path/);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

for (const flag of [undefined, false, true]) test(`configured daemon provisions fresh native 0.16 CLI tool selection with Hermes opt-in=${flag}`, { skip: process.platform === "win32" }, async () => {
  const f = hermesProfileFixture(), { daemon, adapter } = configuredHermes(f, flag);
  try {
    const before = readFileSync(join(f.native, "config.yaml"));
    await adapter.provisionEmployee(f.target);
    const config = f.profileConfig(), selected = f.select();
    assert.deepEqual(config.platform_toolsets.cli, ["hermes-cli", ...(flag ? ["mcp-phonon_current_turn"] : [])]);
    assert.deepEqual(config.platform_toolsets.telegram, ["hermes-telegram"]);
    assert.equal(selected.ready, flag === true);
    assert.equal(selected.selected.includes("mcp-phonon_current_turn"), flag === true);
    assert.equal(selected.names.length, flag ? 2 : 0);
    assert.equal(selected.exactNativeDefinitions, !!process.env.PHONON_TEST_HERMES_016_SELECTION_SOURCE);
    assert.deepEqual(readFileSync(join(f.native, "config.yaml")), before);
    assert.equal(existsSync(join(f.home, "auth.json")), false);
    assert.equal(existsSync(join(f.home, "memories/MEMORY.md")), false);
    assert.match(readFileSync(join(f.home, ".env"), "utf8"), /approved-inference-fixture/);
    assert.doesNotMatch(readFileSync(join(f.home, ".env"), "utf8"), /HERMES_SAFE_MODE/);
    if (flag) {
      config.platform_toolsets.cli = ["hermes-cli"];
      writeFileSync(join(f.home, "config.yaml"), JSON.stringify(config), { mode: 0o600 });
      const unchanged = readFileSync(join(f.home, "config.yaml"));
      await assert.rejects(adapter.provisionEmployee(f.target), /Hermes profile operation refused/);
      assert.deepEqual(readFileSync(join(f.home, "config.yaml")), unchanged, "retry verifies but never migrates an existing profile");
    }
  } finally { await daemon.stop(); f.close(); }
});

for (const kind of ["explicit-deny", "no-mcp", "empty-cli", "alias-conflict", "dotenv-safe-mode"]) test(`configured Hermes daemon opt-in cannot override ${kind}`, { skip: process.platform === "win32" }, async () => {
  const f = hermesProfileFixture(config => {
    if (kind === "explicit-deny") config.agent.disabled_toolsets = ["mcp-phonon_current_turn"];
    if (kind === "no-mcp") config.platform_toolsets.cli.push("no_mcp");
    if (kind === "empty-cli") config.platform_toolsets.cli = [];
    if (kind === "alias-conflict") config.mcp_servers = { phonon_current_turn: { enabled: false } };
  }, kind === "dotenv-safe-mode" ? "HERMES_SAFE_MODE=1\n" : "");
  const { daemon, adapter } = configuredHermes(f, true), before = readFileSync(join(f.native, "config.yaml"));
  try {
    await assert.rejects(adapter.provisionEmployee(f.target), (error: any) => /^employee_profile_native_tools_/.test(error.appCode));
    assert.equal(existsSync(f.home), false);
    assert.deepEqual(readFileSync(join(f.native, "config.yaml")), before);
  } finally { await daemon.stop(); f.close(); }
});

test("config: managed Hermes native tools are a strict local default-off opt-in",()=>{
  const path=join(mkdtempSync(join(tmpdir(),"phonon-hermes-opt-in-")),"config.json");
  for(const flag of [undefined,false,true]){
    const cfg=defaultConfig();cfg.adapters=[{type:"hermes",...(flag===undefined?{}:{hermesManagedProfileNativeTools:flag})}];
    writeConfig(cfg,path);assert.equal(loadConfig(path).adapters[0]?.hermesManagedProfileNativeTools,flag);
  }
  for(const flag of ["true",1,null,{}]){
    const cfg=defaultConfig();cfg.adapters=[{type:"hermes",hermesManagedProfileNativeTools:flag as boolean}];
    writeConfig(cfg,path);assert.throws(()=>loadConfig(path),/hermesManagedProfileNativeTools must be a boolean/);
  }
});

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

test("config: delivery capacity defaults to 1 GiB and rejects coercion or invalid limits", async () => {
  const { loadConfig } = await import("./config.js");
  const path = join(mkdtempSync(join(tmpdir(), "phonon-delivery-cfg-")), "config.json");
  const cfg = defaultConfig();
  assert.equal(cfg.delivery?.maxPendingBytes, 1073741824);
  cfg.delivery = undefined;
  writeConfig(cfg, path);
  assert.equal(loadConfig(path).delivery?.maxPendingBytes, 1073741824);
  cfg.delivery = { maxPendingBytes: 1234 };
  writeConfig(cfg, path);
  assert.equal(loadConfig(path).delivery?.maxPendingBytes, 1234);
  for (const value of [0, -1, 1.5, "100", null, Number.MAX_SAFE_INTEGER + 1]) {
    cfg.delivery = { maxPendingBytes: value } as never;
    writeConfig(cfg, path);
    assert.throws(() => loadConfig(path), /delivery.maxPendingBytes/);
  }
  for (const value of [null, [], "100"]) {
    cfg.delivery = value as never;
    writeConfig(cfg, path);
    assert.throws(() => loadConfig(path), /delivery must be an object/);
  }
});

test("daemon: health and metrics expose device-wide disconnected backlog before any connection", async () => {
  const { PhononDaemon } = await import("./daemon.js");
  const cfg = defaultConfig(); cfg.dbPath = join(mkdtempSync(join(tmpdir(), "phonon-delivery-health-")), "state.sqlite");
  cfg.servers = []; cfg.adapters = []; cfg.rescueAgent = { enabled: false }; cfg.delivery = { maxPendingBytes: 3 }; cfg.logLevel = "error";
  const daemon = new PhononDaemon(cfg);
  const access = daemon as unknown as { store: import("@agent-phonon/core").PhononStore; health: () => { ok: boolean; delivery: { pendingBytes: number; admissionBlocked: boolean } }; metrics: import("@agent-phonon/core").Metrics };
  access.store.outboxAdd("disconnected", "s", 0, "汉", new Date(0).toISOString());
  assert.equal(access.health().ok, true, "byte pressure alone does not stop the daemon or new work");
  assert.equal(access.health().delivery.pendingBytes, 3);
  assert.equal(access.health().delivery.admissionBlocked, false);
  assert.match(access.metrics.prometheus(), /phonon_delivery_pending_bytes 3/);
  access.store.outboxAck("disconnected", "s", 0);
  assert.equal(access.health().ok, true);
  access.store.close();
  const restarted = new PhononDaemon(cfg);
  const access2 = restarted as unknown as typeof access;
  assert.equal(access2.health().delivery.pendingBytes, 0);
  access2.store.close();
});

test("obs: accounting read failures return sanitized 503s on all three HTTP endpoints and keep daemon controls alive", { timeout: 20000 }, async () => {
  const { PhononDaemon } = await import("./daemon.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { MockAdapter, PhononTestServer } = await import("@agent-phonon/test-server");
  const server = new PhononTestServer({ assignTenant: () => "obs-read-tenant" });
  const port = await server.listen();
  const root = mkdtempSync(join(tmpdir(), "phonon-obs-read-failure-"));
  const dbPath = join(root, "state.sqlite");
  const daemon = new PhononDaemon({
    deviceId: "obs-read-failure", dbPath, workspaceRoot: root,
    adapters: [], servers: [{ url: `ws://127.0.0.1:${port}`, trustLocal: true }],
    rescueAgent: { enabled: false }, hookBridge: { port: 0 }, obs: { enabled: true, port: 0 }, logLevel: "error",
  }, { adapters: [new MockAdapter()] });
  const access = daemon as unknown as {
    store: import("@agent-phonon/core").PhononStore;
    clients: Array<{ connection?: import("@agent-phonon/core").PhononConnection }>;
    health: () => Record<string, unknown>;
  };
  let db: InstanceType<typeof DatabaseSync> | undefined;
  const reads = access.store.delivery as unknown as { readPending: () => unknown };
  const originalRead = reads.readPending;
  const internalPath = join(root, "private-location-must-not-leak");
  const sensitivePayload = "private-generated-payload-must-not-leak";
  const fetchEndpoint = (endpoint: string) => fetch(`http://127.0.0.1:${daemon.obsPort}${endpoint}`, { signal: AbortSignal.timeout(2000) });
  const restoreCounter = () => db!.exec(`
    CREATE TABLE IF NOT EXISTS delivery_totals (channel TEXT PRIMARY KEY,pending_count INTEGER NOT NULL,pending_bytes INTEGER NOT NULL);
    INSERT OR REPLACE INTO delivery_totals SELECT channel,COUNT(*),SUM(bytes) FROM delivery_pending GROUP BY channel;
    INSERT OR IGNORE INTO delivery_totals VALUES ('stream',0,0),('workflow',0,0),('run',0,0);
  `);
  try {
    await daemon.start();
    const device = await server.firstDevice(3000);
    const project = await device.peer.requestRaw("project.create", { name: "p", git: false }) as { project: { projectId: string } };
    const session = await device.peer.requestRaw("session.create", { project: project.project.projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
    access.store.outboxAdd("offline", "pending", 0, sensitivePayload, new Date(0).toISOString());
    const actualBytes = Buffer.byteLength(sensitivePayload);
    access.store.delivery.configure({ maxPendingBytes: actualBytes });
    const pressure = await fetchEndpoint("/health");
    assert.equal(pressure.status, 200);
    const known = await pressure.json() as { ok: boolean; degraded: boolean; delivery: { state: string; pendingBytes: number; pressureCritical: boolean; admissionBlocked: boolean } };
    assert.equal(known.delivery.state, "critical", "ordinary pressure is not a failed measurement");
    assert.equal(known.delivery.pendingBytes, actualBytes);
    assert.equal(known.ok, true); assert.equal(known.degraded, true);
    assert.equal(known.delivery.pressureCritical, true); assert.equal(known.delivery.admissionBlocked, false);
    assert.equal((await fetchEndpoint("/metrics")).status, 200);
    assert.equal((await fetchEndpoint("/metrics.json")).status, 200);
    db = new DatabaseSync(dbPath);
    for (const injection of ["throw", "drop-table"]) {
      if (injection === "throw") reads.readPending = () => { throw new Error(`${internalPath}: ${sensitivePayload}`); };
      else db.exec("DROP TABLE delivery_totals");
      const direct = access.health() as { ok: boolean; delivery: Record<string, unknown> };
      assert.equal(direct.ok, false);
      assert.equal(direct.delivery.state, "unavailable");
      for (const endpoint of ["/health", "/metrics", "/metrics.json"]) {
        const response = await fetchEndpoint(endpoint);
        assert.equal(response.status, 503, `${injection}: ${endpoint}`);
        const body = await response.text();
        assert.ok(!body.includes(root) && !body.includes(internalPath) && !body.includes(sensitivePayload));
        assert.ok(!body.includes("delivery_totals") && !body.includes("Error:") && !body.includes("stack"));
        const status = JSON.parse(body) as { ok: boolean; delivery: Record<string, unknown> };
        assert.equal(status.ok, false);
        assert.equal(status.delivery.state, "unavailable");
        assert.equal(status.delivery.measurementAvailable, false);
        assert.equal(status.delivery.persistenceHealthy, false);
        assert.equal(status.delivery.admissionBlocked, true);
        assert.equal("pendingBytes" in status.delivery, false, "unknown is not fabricated zero bytes");
        assert.equal("pendingCount" in status.delivery, false);
        assert.equal("channels" in status.delivery, false);
      }
      for (const endpoint of ["/", "/sessions", "/events"]) assert.equal((await fetchEndpoint(endpoint)).status, 200);
      // Actual WebSocket SDK calls still complete while HTTP measurement is unavailable.
      await device.peer.requestRaw("session.status", { sessionId: session.sessionId });
      await device.peer.requestRaw("session.interrupt", { sessionId: session.sessionId });
      assert.doesNotThrow(() => access.clients[0]!.connection!.replayPending());
      assert.throws(() => access.store.delivery.assertNewWork(), injection === "throw" ? /private-location/ : /delivery_totals/, "Core admission still fails closed on read errors");
      reads.readPending = originalRead;
      if (injection === "drop-table") restoreCounter();
      assert.equal(access.store.delivery.snapshot().pendingBytes, actualBytes);
      assert.equal(access.store.delivery.snapshot().persistenceHealthy, false, "HTTP fallback never clears the sticky failure latch");
      const recoveredRead = await fetchEndpoint("/metrics.json");
      assert.equal(recoveredRead.status, 200);
      const metrics = await recoveredRead.json() as { gauges: Record<string, number> };
      assert.equal(metrics.gauges.delivery_pending_bytes, actualBytes);
      assert.equal(metrics.gauges.delivery_persistence_healthy, 0);
      const after = await (await fetchEndpoint("/health")).json() as { delivery: { state: string } };
      assert.equal(after.delivery.state, "critical", "read restored: no longer the unavailable-measurement state");
    }
    // ACK remains usable once storage reads are restored despite the sticky failed latch.
    access.store.outboxAck("offline", "pending", 0);
    assert.equal(access.store.delivery.snapshot().pendingBytes, 0);
    assert.throws(() => access.store.delivery.assertNewWork(), /unhealthy/);
  } finally {
    reads.readPending = originalRead;
    if (db) { restoreCounter(); db.close(); }
    await daemon.stop();
    await server.close();
  }
});

test("obs: independent health provider read exception is contained by the HTTP boundary", async () => {
  const { ObsServer } = await import("./obs-server.js");
  const { ObsBus, Metrics, PhononStore } = await import("@agent-phonon/core");
  const store = new PhononStore(":memory:");
  const obs = new ObsServer({ bus: new ObsBus(), metrics: new Metrics(), store,
    health: () => { throw new Error("private-health-provider-path-and-payload"); }, sessions: () => [],
  });
  try {
    const port = await obs.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes("private-health-provider"));
    assert.equal(JSON.parse(body).delivery.measurementAvailable, false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/sessions`)).status, 200);
  } finally { await obs.close(); store.close(); }
});
