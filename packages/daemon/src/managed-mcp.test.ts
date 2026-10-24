import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { managedConfigTarget, patchManagedMcp } from "./managed-mcp-config.js";
import { ManagedMcpManager,managedMcpSourceFingerprint } from "./managed-mcp.js";
import { defaultConfig, writeConfig } from "./config.js";
import type { AgentDescriptor } from "@agent-phonon/protocol";
import { PhononConnection, AdapterRegistry } from "@agent-phonon/core";
import { runManagedMcpWorker } from "./managed-mcp-worker-client.js";

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "phonon-managed-mcp-")));
  const binding = randomUUID(), server = "https://agents.phonon.work/phonon", configPath = join(home, "daemon.json"), stateDir = join(home, "state");
  const cfg = defaultConfig(); cfg.dbPath = join(home, "phonon.db"); cfg.servers = [{ url: server, deviceKey: "synthetic-device-credential-not-in-mcp-config" }];
  writeConfig(cfg, configPath);
  const manager = new ManagedMcpManager({ server, configPath, stateDir, home, env: {}, command: "/trusted/node", args: ["/trusted/cli.js"],
    inventory: async () => [{ agentId: "codex", adapter: "codex", available: true, version: "1.0.0" }, { agentId: "pi", adapter: "pi", available: true, version: "0.99.0" }] as AgentDescriptor[] });
  const target = (agent = "codex") => managedConfigTarget(agent, binding, "/trusted/node", ["/trusted/cli.js", "mcp", "proxy"], { home, env: {} })!;
  return { home, binding, server, configPath, cfg, manager, target, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

for (const agent of ["codex", "claude-code", "copilot", "opencode", "pi", "hermes:default", "openclaw:main"]) {
  test(`managed MCP adds and removes only its ${agent} native registration`, () => {
    const f = fixture();
    try {
      const target = f.target(agent); mkdirSync(join(target.path, ".."), { recursive: true, mode: 0o700 });
      const original = target.format === "toml" ? '# personal comment\nmodel = "personal-model"\n' : target.format === "yaml" ? '# personal comment\nmodel: personal-model\n' : '{\n  // personal comment\n  "model": "personal-model",\n  "private": "synthetic-existing-secret"\n}\n';
      writeFileSync(target.path, original, { mode: 0o600 });
      const entry = patchManagedMcp(target, true)!;
      const next = readFileSync(target.path, "utf8");
      assert.match(next, /personal comment/); assert.match(next, /personal-model/); assert.match(next, /phonon_managed_/);
      assert.equal(patchManagedMcp(target, true, entry)?.name, target.name);
      assert.equal(readFileSync(target.path, "utf8"), next);
      patchManagedMcp(target, false, entry);
      const removed = readFileSync(target.path, "utf8");
      assert.doesNotMatch(removed, /phonon_managed_/); assert.match(removed, /personal comment/); assert.match(removed, /personal-model/);
      if (target.format === "json") assert.match(removed, /synthetic-existing-secret/);
    } finally { f.cleanup(); }
  });
}

test("personal edits, unrelated registrations and symlinks are not overwritten", () => {
  const f = fixture();
  try {
    const target = f.target("claude-code");
    writeFileSync(target.path, JSON.stringify({ mcpServers: { personal: { command: "personal" } } }), { mode: 0o600 });
    const owned = patchManagedMcp(target, true)!;
    const changed = JSON.parse(readFileSync(target.path, "utf8")); changed.mcpServers[target.name].args.push("--personal-change");
    writeFileSync(target.path, JSON.stringify(changed), { mode: 0o600 });
    const before = readFileSync(target.path, "utf8");
    assert.throws(() => patchManagedMcp(target, false, owned), /mcp_config_conflict/);
    assert.equal(readFileSync(target.path, "utf8"), before);
    rmSync(target.path); const actual = join(f.home, "elsewhere.json"); writeFileSync(actual, "{}", { mode: 0o600 }); symlinkSync(actual, target.path);
    assert.throws(() => patchManagedMcp(target, true), /mcp_config_file_untrusted/);
    assert.equal(readFileSync(actual, "utf8"), "{}");
  } finally { f.cleanup(); }
});

test("an existing unowned alias is a conflict, not an invitation to adopt credentials", () => {
  const f = fixture();
  try {
    const target = f.target("claude-code"); writeFileSync(target.path, JSON.stringify({ mcpServers: { [target.name]: target.entry } }), { mode: 0o600 });
    assert.throws(() => patchManagedMcp(target, true), /mcp_config_conflict/);
  } finally { f.cleanup(); }
});

test("duplicate JSON keys and a locally removed owned entry are preserved as explicit conflicts",()=>{
  const f=fixture();try{
    const target=f.target("claude-code");writeFileSync(target.path,'{"mcpServers":{},"mcpServers":{}}',{mode:0o600});
    assert.throws(()=>patchManagedMcp(target,true),/mcp_config_duplicate_keys/);
    writeFileSync(target.path,"{}",{mode:0o600});const owned=patchManagedMcp(target,true)!;
    writeFileSync(target.path,"{}",{mode:0o600});assert.throws(()=>patchManagedMcp(target,true,owned),/mcp_config_removed_locally/);
    assert.equal(readFileSync(target.path,"utf8"),"{}");
  }finally{f.cleanup();}
});

test("MCP management is locally denied by default; equal-revision consent retry and removal are safe", async () => {
  const f = fixture();
  try {
    const input = { revision: 1, bindings: [{ id: f.binding, agentId: "codex", enabled: true }] };
    assert.equal((await f.manager.configure(input)).bindings[0]?.state, "local_consent_required");
    f.cfg.servers[0]!.managedMcp = { allow: true, agents: ["codex"],sourceFingerprint:managedMcpSourceFingerprint(f.cfg.servers[0]!) }; writeConfig(f.cfg, f.configPath);
    const enabled = await f.manager.configure(input); assert.equal(enabled.allowed, true); assert.equal(enabled.bindings[0]?.state, "configured");
    const content = readFileSync(f.target().path, "utf8"); assert.doesNotMatch(content, /synthetic-device-credential/); assert.match(content, /--binding/);
    assert.deepEqual(await f.manager.configure(input), enabled);
    await assert.rejects(f.manager.configure({ ...input, revision: 0 }), /mcp_revision_conflict/);
    await assert.rejects(f.manager.configure({ ...input, bindings: [{ ...input.bindings[0]!, enabled: false }] }), /mcp_revision_conflict/);
    f.cfg.servers[0]!.managedMcp!.allow = false; writeConfig(f.cfg, f.configPath);
    assert.equal((await f.manager.configure(input)).bindings[0]?.state, "local_consent_required");
    assert.doesNotMatch(readFileSync(f.target().path, "utf8"), /phonon_managed_/);
    assert.equal((await f.manager.configure({ revision: 2, bindings: [{ ...input.bindings[0]!, enabled: false }] })).bindings[0]?.state, "removed");
  } finally { f.cleanup(); }
});

test("local per-agent consent and unsupported profile scope cannot be broadened by a server", async () => {
  const f = fixture();
  try {
    f.cfg.servers[0]!.managedMcp = { allow: true, agents: ["pi"],sourceFingerprint:managedMcpSourceFingerprint(f.cfg.servers[0]!) }; writeConfig(f.cfg, f.configPath);
    const report = await f.manager.configure({ revision: 1, bindings: [{ id: f.binding, agentId: "codex", enabled: true }, { id: randomUUID(), agentId: "pi", enabled: true }] });
    assert.equal(report.bindings[0]?.state, "local_consent_required"); assert.equal(report.bindings[1]?.state, "configured");
    assert.equal(managedConfigTarget("openclaw:another-agent", randomUUID(), "node", [], { home: f.home }), undefined);
    assert.equal(managedConfigTarget("herdr:codex", randomUUID(), "node", [], { home: f.home }), undefined);
  } finally { f.cleanup(); }
});

test("real device RPC dispatch validates managed MCP requests and refuses a missing local handler", async () => {
  const f=fixture(), replies:Array<Record<string,any>>=[];
  const create=(configured:boolean)=>new PhononConnection({tenantId:"synthetic-mcp-tenant",registry:new AdapterRegistry(),workspaceRoot:f.home,
    transport:{send:data=>replies.push(JSON.parse(data)),close:()=>undefined},
    ...(configured?{managedMcp:{configure:raw=>f.manager.configure(raw),status:async()=>f.manager.status()}}:{})});
  const connection=create(true), unsupported=create(false);
  try{
    await connection.handle(JSON.stringify({jsonrpc:"2.0",id:1,method:"mcp.configure",params:{revision:1,bindings:[{id:f.binding,agentId:"codex",enabled:true}]}}));
    assert.equal(replies.at(-1)?.result.bindings[0].state,"local_consent_required");
    await connection.handle(JSON.stringify({jsonrpc:"2.0",id:2,method:"mcp.status",params:{}}));assert.equal(replies.at(-1)?.result.revision,1);
    await connection.handle(JSON.stringify({jsonrpc:"2.0",id:3,method:"mcp.configure",params:{revision:2,bindings:[],command:"not-allowed"}}));
    assert.ok(replies.at(-1)?.error);assert.equal(f.manager.status().revision,1);
    await unsupported.handle(JSON.stringify({jsonrpc:"2.0",id:4,method:"mcp.status",params:{}}));assert.ok(replies.at(-1)?.error);
  }finally{await connection.dispose();await unsupported.dispose();f.cleanup();}
});

test("managed MCP worker preserves consent, revisions and native ownership without blocking the caller", async () => {
  const f = fixture(), options = { server: f.server, configPath: f.configPath, stateDir: join(f.home, "state"), home: f.home, env: {}, command: "/trusted/node", args: ["/trusted/cli.js"] };
  const snapshot = { revision: 1, bindings: [{ id: f.binding, agentId: "codex", enabled: true }] };
  const inventory = [{ agentId: "codex", adapter: "codex", available: true, version: "1.0.0" }] as AgentDescriptor[];
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 5);
  try {
    const denied = await runManagedMcpWorker(options, { operation: "configure", snapshot, inventory });
    assert.equal(denied.bindings[0]?.state, "local_consent_required");
    f.cfg.servers[0]!.managedMcp = { allow: true, agents: ["codex"],sourceFingerprint:managedMcpSourceFingerprint(f.cfg.servers[0]!) }; writeConfig(f.cfg, f.configPath);
    const configured = await runManagedMcpWorker(options, { operation: "configure", snapshot, inventory });
    assert.equal(configured.bindings[0]?.state, "configured");
    assert.match(readFileSync(f.target().path, "utf8"), /phonon_managed_/);
    assert.deepEqual(await runManagedMcpWorker(options, { operation: "status", inventory: [] }), f.manager.status());
    await assert.rejects(runManagedMcpWorker(options, { operation: "configure", snapshot: { ...snapshot, revision: 0 }, inventory }), /mcp_revision_conflict/);
    const removed = await runManagedMcpWorker(options, { operation: "configure", snapshot: { revision: 2, bindings: [] }, inventory });
    assert.deepEqual(removed.bindings, []); assert.doesNotMatch(readFileSync(f.target().path, "utf8"), /phonon_managed_/);
    assert.ok(ticks > 0, "caller timers remain active while the worker owns configuration IO");
  } finally { clearInterval(heartbeat); f.cleanup(); }
});
