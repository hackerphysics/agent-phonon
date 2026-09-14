import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "@agent-phonon/core";
import { TestConn } from "./harness.js";

function setup(policy: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "phonon-maint-rpc-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ model: "old", token: "secret" }, null, 2) + "\n");
  const tc = new TestConn({
    registry: new AdapterRegistry(),
    trustLocal: false,
    policy,
    maintenance: {
      backupDir: join(dir, "backups"),
      targets: [{ targetId: "demo", label: "Demo", configs: [{ configId: "main", path: configPath, format: "json", writable: true, allowedRootKeys: ["model"] }] }],
    },
  });
  return { tc };
}

test("maintenance RPC works without any registered external agent", async () => {
  const { tc } = setup({ allowMaintenanceRead: true, allowMaintenanceConfigWrite: true });
  const targets = await tc.call("maintenance.targets", {}) as { targets: Array<{ targetId: string }> };
  assert.deepEqual(targets.targets.map((t) => t.targetId), ["demo"]);
  const before = await tc.call("maintenance.config.get", { targetId: "demo", configId: "main" }) as { sha256: string; value: { token: string } };
  assert.equal(before.value.token, "***");
  const patched = await tc.call("maintenance.config.patch", {
    targetId: "demo", configId: "main", expectedSha256: before.sha256, patch: { model: "new" }, clientRequestId: "maint-1",
  }) as { backupId: string; changed: boolean };
  assert.equal(patched.changed, true);
  assert.ok(patched.backupId);
  // idempotency: same request id returns original result instead of patching twice.
  const duplicate = await tc.call("maintenance.config.patch", {
    targetId: "demo", configId: "main", expectedSha256: before.sha256, patch: { model: "new" }, clientRequestId: "maint-1",
  });
  assert.deepEqual(duplicate, patched);
});

test("maintenance mutation requires its independent device policy flag", async () => {
  const { tc } = setup({ allowMaintenanceRead: true, allowMaintenanceConfigWrite: false });
  const before = await tc.call("maintenance.config.get", { targetId: "demo", configId: "main" }) as { sha256: string };
  await assert.rejects(() => tc.call("maintenance.config.patch", {
    targetId: "demo", configId: "main", expectedSha256: before.sha256, patch: { model: "new" },
  }), (err: unknown) => {
    const rpc = err as { message?: string; data?: { appCode?: string } };
    return rpc.data?.appCode === "errPolicyDenied" && rpc.message === "maintenance config write disabled by policy";
  });
});

test("D05: maintenance inherits only required user-bus context and still strips code-loading env", async () => {
  const keys = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let tc: TestConn | undefined;
  try {
    process.env.XDG_RUNTIME_DIR = "/tmp/phonon-unit-runtime";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/phonon-unit-runtime/bus";
    process.env.NODE_OPTIONS = "--invalid-phonon-test-option";
    process.env.LD_PRELOAD = "/nonexistent-phonon-test.so";
    process.env.PYTHONPATH = "/nonexistent-phonon-test";
    tc = new TestConn({ registry: new AdapterRegistry(), policy: { allowMaintenanceRead: true }, maintenance: { targets: [{
      targetId: "env-probe", label: "Harmless env-presence probe", command: process.execPath,
      versionArgs: ["-e", "console.log(JSON.stringify({runtime:process.env.XDG_RUNTIME_DIR,bus:process.env.DBUS_SESSION_BUS_ADDRESS,unsafe:['NODE_OPTIONS','LD_PRELOAD','PYTHONPATH'].filter(k=>process.env[k])}))"],
    }] } });
    const response = await tc.call("maintenance.diagnose", { targetId: "env-probe" }) as any;
    const probe = JSON.parse(response.diagnostics[0].version);
    assert.equal(probe.runtime, process.env.XDG_RUNTIME_DIR);
    assert.equal(probe.bus, process.env.DBUS_SESSION_BUS_ADDRESS);
    assert.deepEqual(probe.unsafe, []);
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    await tc?.conn.dispose();
  }
});

test("maintenance edit RPC root denial, idempotency and TS SDK wrapper", async () => {
  const { PhononDevice } = await import("@agent-phonon/server-sdk");
  const dir = mkdtempSync(join(tmpdir(), "phonon-edit-rpc-"));
  const path = join(dir, "fixture.toml"); writeFileSync(path, '# public\nmodel = "before"\nlocked = 1\n');
  const tc = new TestConn({ registry: new AdapterRegistry(), trustLocal: false,
    policy: { allowMaintenanceRead: true, allowMaintenanceConfigWrite: true },
    maintenance: { backupDir: join(dir, "backups"), targets: [{ targetId: "fixture", label: "Fixture", configs: [{ configId: "main", path, format: "toml", writable: true, textVisibility: "public", allowedRootKeys: ["model"] }] }] } });
  try {
    const device = new PhononDevice("device", "tenant", { request: (method: string, params: unknown) => tc.call(method, params) } as any);
    const b: any = await device.maintenance.configGet("fixture", "main");
    const p = { targetId: "fixture", configId: "main", expectedSha256: b.sha256, edits: [{ oldText: "before", newText: "after" }], clientRequestId: "edit-idem" };
    const r: any = await device.maintenance.configEdit(p); assert.equal(r.changed, true);
    assert.deepEqual(await device.maintenance.configEdit(p), r);
    await assert.rejects(() => device.maintenance.configEdit({ ...p, expectedSha256: r.sha256, clientRequestId: "root-deny", edits: [{ oldText: "locked = 1", newText: "locked = 2" }] }));
    await device.maintenance.rollback(r.backupId, r.sha256); assert.equal((await device.maintenance.configGet("fixture", "main") as any).sha256, b.sha256);
  } finally { await tc.conn.dispose(); const { rmSync } = await import("node:fs"); rmSync(dir, { recursive: true, force: true }); }
});
