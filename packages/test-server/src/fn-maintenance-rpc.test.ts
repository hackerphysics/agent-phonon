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
