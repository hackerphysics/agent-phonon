import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenClawGatewayAdapter, type EmployeeProfileTarget } from "@agent-phonon/core";
import { EmployeeProfileApplyParams } from "@agent-phonon/protocol";

const pluginId = "agent-phonon-hitl", agent = "phn-" + "a".repeat(40);
const names = ["phonon_request_interaction", "phonon_acknowledge_interaction", "phonon_conversation_board", "phonon_workflow", "phonon_conversation_message", "phonon_publish_document", "phonon_project_coordination"];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-owned-openclaw-tools-"))), employeeId = randomUUID(), workspace = join(root, employeeId), nonce = randomUUID();
  mkdirSync(workspace, { mode: 0o700 }); writeFileSync(join(workspace, ".phonon-employee"), nonce, { mode: 0o600 });
  const input = EmployeeProfileApplyParams.parse({ employeeId, revision: 1, profileId: randomUUID(), agent: "openclaw:base", model: "x/m1", name: "Owned DE", responsibility: "Test scope", documents: { soul: "Preserve boundaries", agents: "", user: "", tools: "" } });
  const target: EmployeeProfileTarget = { input, runtimeProfile: agent, workspace, nonce };
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://127.0.0.1:1", token: "fixture" } });
  const files = new Map<string, string>(), agents: Array<{ id: string; workspace: string }> = [{ id: "base", workspace: "/daily" }], calls: Array<{ method: string; params: any }> = [];
  let config: any = { meta: { lastTouchedAt: "before", lastTouchedVersion: "2026.9.9", retained: true }, gateway: { auth: { token: "never-in-patch" } }, tools: { profile: "full", deny: ["dangerous_daily_tool"] }, plugins: { allow: [pluginId, "daily-plugin"], entries: { [pluginId]: { enabled: true, config: { nativeInteractions: true, bridgeToken: "do-not-echo" } }, "daily-plugin": { enabled: true } } }, agents: { entries: { base: { workspace: "/daily", tools: { deny: ["daily_deny"] } } } } };
  let hash = "revision-1", epoch = 1, configReads = 0, patchError: Error | undefined;
  let onGet: ((number: number) => void) | undefined, onPatch: (() => void) | undefined;
  const rpc = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "agents.list") return { agents: structuredClone(agents) };
    if (method === "agents.create") {
      agents.push({ id: params.name, workspace: params.workspace }); config.agents.entries[params.name] = { workspace: params.workspace, model: params.model, tools: { alsoAllow: ["read"], deny: ["custom_deny"] } };
      return { agentId: params.name, workspace: params.workspace };
    }
    if (method === "agents.update") return { ok: true };
    if (method === "agents.files.set") { files.set(params.name, params.content); return { ok: true }; }
    if (method === "agents.files.get") return { workspace, file: { missing: !files.has(params.name), content: files.get(params.name) } };
    if (method === "config.get") { configReads++; const snapshot = { valid: true, hash, config: structuredClone(config) }; onGet?.(configReads); return snapshot; }
    if (method === "config.patch") {
      if (patchError) throw patchError;
      assert.equal(params.baseHash, hash); const patch = JSON.parse(params.raw);
      assert.deepEqual(Object.keys(patch), ["agents"]); assert.deepEqual(Object.keys(patch.agents.entries), [agent]);
      assert.ok(!params.raw.includes("never-in-patch") && !params.raw.includes("do-not-echo"));
      const tools = patch.agents.entries[agent].tools;
      assert.equal(Object.keys(tools).length, 1);
      Object.assign(config.agents.entries[agent].tools, tools); hash = "revision-2";
      config.meta.lastTouchedAt = "after"; onPatch?.();
      return { ok: true, hash };
    }
    throw new Error("Unexpected fixture RPC " + method);
  };
  (adapter as any).gw = { connect: async () => {}, close() {}, connectionEpoch: () => epoch, rpc };
  return { adapter, target, files, calls, root, workspace, get config() { return config; }, set config(value) { config = value; },
    onGet(value: typeof onGet) { onGet = value; }, onPatch(value: typeof onPatch) { onPatch = value; },
    setPatchError(value: Error) { patchError = value; }, changeEpoch() { epoch++; }, close() { rmSync(root, { recursive: true, force: true }); } };
}

test("new owned OpenClaw DE gains exactly the operator-enabled optional tools via scoped CAS", async () => {
  const f = fixture();
  try {
    const daily = structuredClone(f.config.agents.entries.base), plugins = structuredClone(f.config.plugins), global = structuredClone(f.config.tools);
    const result = await f.adapter.provisionEmployee(f.target);
    assert.equal(result.home, f.workspace);
    assert.deepEqual(f.config.agents.entries[agent].tools, { alsoAllow: ["read", ...names], deny: ["custom_deny"] });
    assert.deepEqual(f.config.agents.entries.base, daily); assert.deepEqual(f.config.plugins, plugins); assert.deepEqual(f.config.tools, global);
    const patches = f.calls.filter(c => c.method === "config.patch"); assert.equal(patches.length, 1); assert.equal(patches[0]!.params.baseHash, "revision-1");
    const manifest = JSON.parse(readFileSync(new URL("../../openclaw-plugin/openclaw.plugin.json", import.meta.url), "utf8"));
    assert.deepEqual(names, manifest.contracts.tools);
    assert.equal(f.calls.some(c => /^(chat\.|plugins\.|config\.apply|gateway\.)/.test(c.method)), false);
  } finally { f.close(); }
});

test("plugin absence or disabled native opt-in never prevents ordinary employee provisioning", async () => {
  for (const variant of ["absent", "disabled", "no-opt-in"]) {
    const f = fixture();
    try {
      if (variant === "absent") delete f.config.plugins.entries[pluginId];
      if (variant === "disabled") f.config.plugins.entries[pluginId].enabled = false;
      if (variant === "no-opt-in") f.config.plugins.entries[pluginId].config.nativeInteractions = false;
      assert.equal((await f.adapter.provisionEmployee(f.target)).home, f.workspace);
      assert.equal(f.calls.some(c => c.method === "config.patch"), false);
    } finally { f.close(); }
  }
});

test("a host without readable config APIs still provisions ordinary profiles without policy mutations", async () => {
  for (const code of ["FORBIDDEN", "METHOD_NOT_FOUND"]) {
    const f = fixture();
    try {
      const original = (f.adapter as any).gw.rpc;
      (f.adapter as any).gw.rpc = async (method: string, params: any) => {
        if (method === "config.get") throw new Error("Config API unavailable", { cause: { code } });
        return original(method, params);
      };
      assert.equal((await f.adapter.provisionEmployee(f.target)).home, f.workspace);
      assert.equal(f.calls.some(c => c.method === "config.patch"), false);
    } finally { f.close(); }
  }
});

test("a new owned explicit allowlist is extended without creating conflicting alsoAllow or removing denies", async () => {
  const f = fixture();
  try {
    const original = (f.adapter as any).gw.rpc;
    (f.adapter as any).gw.rpc = async (method: string, params: any) => {
      const result = await original(method, params);
      if (method === "agents.create") f.config.agents.entries[agent].tools = { allow: ["read"], deny: ["custom_deny"] };
      return result;
    };
    await f.adapter.provisionEmployee(f.target);
    assert.deepEqual(f.config.agents.entries[agent].tools, { allow: ["read", ...names], deny: ["custom_deny"] });
  } finally { f.close(); }
});

test("global, agent and provider denials remain authoritative, without any policy patch", async () => {
  for (const variant of ["global", "agent", "provider-deny", "provider-allow", "global-allow", "reload-off", "reload-restart"]) {
    const f = fixture();
    try {
      f.onGet(() => {});
      if (variant === "global") f.config.tools.deny.push("phonon_*");
      if (variant === "provider-deny") f.config.tools.byProvider = { x: { deny: [pluginId] } };
      if (variant === "provider-allow") f.config.tools.byProvider = { x: { allow: ["read"] } };
      if (variant === "global-allow") f.config.tools.allow = ["read"];
      if (variant === "reload-off") f.config.gateway.reload = { mode: "off" };
      if (variant === "reload-restart") f.config.gateway.reload = { mode: "restart" };
      if (variant === "agent") {
        const original = (f.adapter as any).gw.rpc;
        (f.adapter as any).gw.rpc = async (method: string, params: any) => { const result = await original(method, params); if (method === "agents.create") f.config.agents.entries[agent].tools.deny.push(pluginId); return result; };
      }
      await assert.rejects(f.adapter.provisionEmployee(f.target), error => (error as any).appCode === "errPolicyDenied", variant);
      assert.equal(f.calls.some(c => c.method === "config.patch"), false, variant);
    } finally { f.close(); }
  }
});

test("foreign workspace/nonce and transport/adapter changes cannot acquire native optional tools", async () => {
  for (const variant of ["workspace", "nonce", "identity", "epoch", "closed"]) {
    const f = fixture();
    try {
      f.onGet(number => {
        if (number !== 1) return;
        if (variant === "workspace") f.config.agents.entries[agent].workspace = "/foreign";
        if (variant === "nonce") writeFileSync(join(f.workspace, ".phonon-employee"), randomUUID());
        if (variant === "identity") f.files.set("IDENTITY.md", "Foreign identity");
        if (variant === "epoch") f.changeEpoch();
        if (variant === "closed") f.adapter.close();
      });
      // Changing native config after a snapshot is caught by the CAS itself.
      if (variant === "workspace") f.setPatchError(new Error("config changed"));
      await assert.rejects(f.adapter.provisionEmployee(f.target), variant);
      if (variant !== "workspace") assert.equal(f.calls.some(c => c.method === "config.patch"), false, variant);
    } finally { f.close(); }
  }
});

test("CAS conflict, uncertain acceptance and unrelated readback changes are never replayed or called ready", async () => {
  for (const variant of ["cas", "timeout", "scope", "ownership"]) {
    const f = fixture();
    try {
      if (variant === "cas" || variant === "timeout") f.setPatchError(new Error(variant === "cas" ? "config changed" : "RPC timeout"));
      if (variant === "scope") f.onPatch(() => { f.config.agents.entries.base.tools.deny = []; });
      if (variant === "ownership") f.onPatch(() => writeFileSync(join(f.workspace, ".phonon-employee"), randomUUID()));
      await assert.rejects(f.adapter.provisionEmployee(f.target));
      assert.equal(f.calls.filter(c => c.method === "config.patch").length, 1, variant);
      assert.equal(f.calls.some(c => c.method.startsWith("chat.")), false);
    } finally { f.close(); }
  }
});

test("first-provision retry verifies the same owned policy without duplicating the agent or config mutation", async () => {
  const f = fixture();
  try {
    await f.adapter.provisionEmployee(f.target);
    await f.adapter.provisionEmployee(f.target);
    assert.equal(f.calls.filter(c => c.method === "agents.create").length, 1);
    assert.equal(f.calls.filter(c => c.method === "config.patch").length, 1);
  } finally { f.close(); }
});

test("existing provisioned DEs are not silently migrated on later profile edits", async () => {
  const f = fixture();
  try {
    delete f.config.plugins.entries[pluginId]; const first = await f.adapter.provisionEmployee(f.target);
    f.config.plugins.entries[pluginId] = { enabled: true, config: { nativeInteractions: true } };
    const previousGets = f.calls.filter(c => c.method === "config.get").length;
    await f.adapter.provisionEmployee({ ...f.target, previousHashes: first.documentHashes });
    assert.equal(f.calls.filter(c => c.method === "config.get").length, previousGets);
    assert.equal(f.calls.some(c => c.method === "config.patch"), false);
  } finally { f.close(); }
});
