import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceManager, PolicyEnforcer, applyJsonMergePatch } from "@agent-phonon/core";

test("maintenance JSON merge patch follows RFC 7396 semantics", () => {
  assert.deepEqual(applyJsonMergePatch(
    { a: 1, nested: { keep: true, remove: 2 }, list: [1, 2] },
    { nested: { remove: null, added: "x" }, list: [3] },
  ), { a: 1, nested: { keep: true, added: "x" }, list: [3] });
});

test("maintenance config get redacts secrets, patch is optimistic, backup rollback restores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-maint-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ model: "old", apiKey: "secret", nested: { value: 1 } }, null, 2) + "\n");
  const policy = new PolicyEnforcer({ policy: {
    allowMaintenanceRead: true,
    allowMaintenanceConfigWrite: true,
  }});
  const manager = new MaintenanceManager(policy, {
    backupDir: join(dir, "backups"),
    targets: [{
      targetId: "demo", label: "Demo",
      configs: [{ configId: "main", path: configPath, format: "json", writable: true, allowedRootKeys: ["model", "apiKey", "nested"] }],
    }],
  });

  const before = await manager.configGet("demo", "main");
  assert.equal((before.value as { apiKey: string }).apiKey, "***");
  assert.ok(before.sha256);
  await assert.rejects(() => manager.configPatch({
    targetId: "demo", configId: "main", expectedSha256: before.sha256!,
    patch: { apiKey: "***" },
  }), /redacted secret placeholder/);

  const patched = await manager.configPatch({
    targetId: "demo", configId: "main", expectedSha256: before.sha256!,
    patch: { model: "new", nested: { value: 2 } }, reason: "test",
  });
  assert.equal(patched.changed, true);
  assert.ok(patched.backupId);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { model: "new", apiKey: "secret", nested: { value: 2 } });

  await assert.rejects(() => manager.rollback(patched.backupId!, "stale-current-hash"), /config changed before rollback/);

  await assert.rejects(() => manager.configPatch({
    targetId: "demo", configId: "main", expectedSha256: before.sha256!, patch: { model: "stale" },
  }), /config changed since read/);

  const rolled = await manager.rollback(patched.backupId!, patched.sha256);
  assert.equal(rolled.restored, true);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { model: "old", apiKey: "secret", nested: { value: 1 } });
});

test("maintenance redacts device/access/private keys recursively", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-maint-secrets-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ servers: [{ deviceKey: "dev-secret" }], accessKey: "access-secret", nested: { privateKey: "private-secret" } }, null, 2) + "\n");
  const manager = new MaintenanceManager(new PolicyEnforcer({ policy: { allowMaintenanceRead: true } }), {
    targets: [{ targetId: "self", label: "Self", configs: [{ configId: "main", path: configPath, format: "json", writable: false }] }],
  });
  const value = (await manager.configGet("self", "main")).value as { servers: Array<{ deviceKey: string }>; accessKey: string; nested: { privateKey: string } };
  assert.equal(value.servers[0]!.deviceKey, "***");
  assert.equal(value.accessKey, "***");
  assert.equal(value.nested.privateKey, "***");
});

test("maintenance writable config enforces root-key allowlist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-maint-allow-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ models: {}, policy: { allowExec: false } }, null, 2) + "\n");
  const manager = new MaintenanceManager(new PolicyEnforcer({ policy: { allowMaintenanceRead: true, allowMaintenanceConfigWrite: true } }), {
    targets: [{ targetId: "demo", label: "Demo", configs: [{ configId: "main", path: configPath, format: "json", writable: true, allowedRootKeys: ["models"] }] }],
  });
  const before = await manager.configGet("demo", "main");
  await assert.rejects(() => manager.configPatch({ targetId: "demo", configId: "main", expectedSha256: before.sha256!, patch: { policy: { allowExec: true } } }), /non-allowlisted root keys/);
});

test("maintenance is denied by strict device policy", async () => {
  const manager = new MaintenanceManager(new PolicyEnforcer(), { targets: [] });
  await assert.rejects(() => manager.targets(), /maintenance read disabled/);
});

test("maintenance only exposes locally registered target ids", async () => {
  const manager = new MaintenanceManager(new PolicyEnforcer({ policy: { allowMaintenanceRead: true } }), {
    targets: [{ targetId: "known", label: "Known" }],
  });
  await assert.rejects(() => manager.diagnose("../../etc/passwd"), /unknown maintenance target/);
  const targets = await manager.targets();
  assert.deepEqual(targets.targets.map((t) => t.targetId), ["known"]);
});
