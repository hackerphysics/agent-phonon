import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PhononStore, SecretBox } from "@agent-phonon/core";

test("env values are encrypted at rest in the sqlite db", () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-envcrypt-"));
  const dbPath = join(dir, "phonon.db");
  const store = new PhononStore(dbPath);
  store.envSet({ scope: "global", name: "API_KEY", value: "super-secret-PLAINTEXT", updatedAt: new Date().toISOString() });

  // 1) round-trips back to plaintext through the store
  const listed = store.envList({ scope: "global" });
  assert.equal(listed.find((x) => x.name === "API_KEY")?.value, "super-secret-PLAINTEXT");
  store.close();

  // 2) the raw column is ciphertext, NOT the plaintext
  const raw = new DatabaseSync(dbPath);
  const row = raw.prepare("SELECT value FROM env_vars WHERE name=?").get("API_KEY") as { value: string };
  raw.close();
  assert.ok(row.value.startsWith("enc:v1:"), "stored value must carry enc prefix");
  assert.equal(row.value.includes("super-secret-PLAINTEXT"), false, "plaintext must not appear on disk");

  // 3) device key file exists and is 0600 (POSIX)
  const keyPath = join(dir, "device.key");
  assert.ok(existsSync(keyPath));
  if (platform() !== "win32") {
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  }
});

test("env decryption survives store reopen (persistent device key)", () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-envcrypt2-"));
  const dbPath = join(dir, "phonon.db");
  const s1 = new PhononStore(dbPath);
  s1.envSet({ scope: "global", name: "TOK", value: "persisted-value", updatedAt: new Date().toISOString() });
  s1.close();
  // reopen: must load the same device.key and decrypt
  const s2 = new PhononStore(dbPath);
  assert.equal(s2.envList({ scope: "global" }).find((x) => x.name === "TOK")?.value, "persisted-value");
  s2.close();
});

test("legacy plaintext env values remain readable (migration-safe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-envcrypt3-"));
  const dbPath = join(dir, "phonon.db");
  const store = new PhononStore(dbPath);
  // simulate a pre-encryption row written directly without prefix
  store.envSet({ scope: "global", name: "NEW", value: "encrypted-now", updatedAt: new Date().toISOString() });
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO env_vars(scope,project_id,agent_id,skill_name,name,value,secret,updated_at) VALUES('global',NULL,NULL,NULL,'OLD','legacy-plaintext',1,?)").run(new Date().toISOString());
  raw.close();
  const listed = store.envList({ scope: "global" });
  assert.equal(listed.find((x) => x.name === "OLD")?.value, "legacy-plaintext"); // returned as-is
  assert.equal(listed.find((x) => x.name === "NEW")?.value, "encrypted-now");
  store.close();
});

test("SecretBox: GCM round-trip + tamper detection", () => {
  const box = SecretBox.fromKeyFile(undefined); // random in-process key
  const ct = box.encrypt("hello world");
  assert.ok(SecretBox.isEncrypted(ct));
  assert.equal(box.decrypt(ct), "hello world");
  // tamper the ciphertext -> auth tag must reject
  const broken = ct.slice(0, -4) + (ct.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => box.decrypt(broken));
  // non-prefixed passes through unchanged
  assert.equal(box.decrypt("just-plain"), "just-plain");
});
