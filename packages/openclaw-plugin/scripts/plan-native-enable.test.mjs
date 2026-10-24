import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPlan, NATIVE_TOOLS, planNativeEnable, PLUGIN_ID } from "./plan-native-enable.mjs";

const employeeId = "13455311-6320-41e6-9201-cad0688d0080", agentId = "phn-a420815c3aef58afb413202044f51416d299363a";
const scope = { employeeId, agentId, workspace: "/home/haipw/employees/" + employeeId };
const config = () => ({ tools: { profile: "full" }, agents: { entries: { main: { model: "daily" }, [agentId]: { workspace: scope.workspace, model: "x/gpt-6.1-sol", tools: { alsoAllow: ["read"] } } } }, plugins: { allow: [PLUGIN_ID, "memory-core"], load: { paths: ["/daily-plugin"] }, entries: { "memory-core": { enabled: true }, [PLUGIN_ID]: { enabled: true, config: { bridgeToken: "fixture-do-not-print", interceptTools: ["write"] } } } } });

test("plan adds only owned DE tools and native flag while preserving legacy and daily settings", () => {
  const c = config(), before = JSON.stringify(c), plan = planNativeEnable(c, scope);
  assert.deepEqual(plan.mergePatch.agents.entries[agentId].tools.alsoAllow, ["read", ...NATIVE_TOOLS]);
  assert.deepEqual(plan.mergePatch.plugins.entries[PLUGIN_ID], { config: { nativeInteractions: true } });
  assert.equal(JSON.stringify(c), before); assert.deepEqual(plan.preserved.otherAgentIds, ["main"]);
  assert.equal(JSON.stringify(plan).includes("fixture-do-not-print"), false);
  assert.equal(plan.authorizationRequired, true); assert.equal(plan.mode, "plan-only");
  c.agents.entries[agentId].tools = { allow: ["read"] };
  const explicit = planNativeEnable(c, scope).mergePatch.agents.entries[agentId].tools;
  assert.deepEqual(explicit.allow, ["read", ...NATIVE_TOOLS]); assert.equal(explicit.alsoAllow, undefined);
});

test("plan rejects foreign bindings, broad exposure and denied tools without weakening policy", () => {
  for (const change of [
    c => { c.agents.entries[agentId].workspace = "/wrong"; },
    c => { c.tools.alsoAllow = ["*"]; },
    c => { c.agents.entries.main.tools = { alsoAllow: [PLUGIN_ID] }; },
    c => { c.tools.deny = ["phonon_*"]; },
    c => { c.agents.entries[agentId].tools.deny = [PLUGIN_ID]; },
    c => { c.plugins.entries[PLUGIN_ID].enabled = false; },
    c => { c.tools.allow = ["read"]; },
  ]) { const c = config(); change(c); assert.throws(() => planNativeEnable(c, scope)); }
});

test("CLI inspection is read-only, verifies marker and digest, and has no apply mode", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-openclaw-plan-"))), workspace = join(root, employeeId), file = join(root, "openclaw.json");
  mkdirSync(workspace, { mode: 0o700 }); writeFileSync(join(workspace, "IDENTITY.md"), `<!-- phonon-employee:${employeeId}:${"a".repeat(32)} -->`, { mode: 0o600 });
  writeFileSync(join(workspace, ".phonon-employee"), "a".repeat(32), { mode: 0o600 });
  const c = config(); c.agents.entries[agentId].workspace = workspace;
  writeFileSync(file, JSON.stringify(c), { mode: 0o600 }); const before = readFileSync(file);
  const args = ["--config", file, "--agent", agentId, "--employee", employeeId, "--workspace", workspace];
  try {
    const plan = inspectPlan(args); assert.equal(plan.employeeMarkerVerified, true);
    assert.deepEqual(readFileSync(file), before); assert.equal(JSON.stringify(plan).includes("fixture-do-not-print"), false);
    assert.throws(() => inspectPlan([...args, "--expected-config-sha256", "0".repeat(64)]), /changed/);
    assert.throws(() => inspectPlan([...args, "--apply", "true"]), /Planning-only/);
    writeFileSync(file, '{"secret":"fixture-do-not-print",');
    assert.throws(() => inspectPlan(args), error => error.message === "Configuration is invalid JSON; no plan produced");
    writeFileSync(file, before);
    writeFileSync(join(workspace, "IDENTITY.md"), "No owned marker"); assert.throws(() => inspectPlan(args), /marker/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
