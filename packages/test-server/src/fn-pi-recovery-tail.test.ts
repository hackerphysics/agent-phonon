import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observePiSession, rescuePiSession } from "@agent-phonon/core";
import { withPeerFixture } from "../../core/dist/testing/peer-fixture.js";

/** A daemon-side timeout SIGTERMs Pi mid-tool; the transcript keeps an unpaired
 * toolCall. Recovery must roll back to the last settled entry instead of failing
 * forever with errSessionBusy. */
function fixture(root: string) {
  const home = join(root, "pi"), work = join(root, "work"), sessions = join(home, "sessions");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 }); mkdirSync(sessions, { mode: 0o700 });
  const sessionDir = join(sessions, "--work--");
  mkdirSync(sessionDir, { mode: 0o700 });
  chmodSync(work, 0o700);
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  const id = "s-tail-fixture", timestamp = "2026-10-24T01:00:00.000Z";
  const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  let parent: string | null = null, seq = 0;
  const row = (type: string, extra: Record<string, unknown>) => {
    const entry = { type, id: `e${++seq}`, parentId: parent, timestamp, ...extra };
    parent = entry.id;
    return entry;
  };
  const base = { type: "session", version: 3, id, timestamp, cwd: work };
  const model = row("model_change", { provider: "local-gateway", modelId: "m1" });
  const user = row("message", { message: { role: "user", content: [{ type: "text", text: "go" }] } });
  const settled = row("message", { message: { role: "assistant", provider: "local-gateway", model: "m1", stopReason: "stop", content: [{ type: "text", text: "ok" }] } });
  const next = row("message", { message: { role: "user", content: [{ type: "text", text: "long task" }] } });
  const killed = row("message", { message: { role: "assistant", provider: "local-gateway", model: "m1", stopReason: "toolUse", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }] } });
  writeFileSync(path, [base, model, user, settled, next, killed].map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  return { work, id, timestamp, path };
}

test("rescue rolls an interrupted native turn back to its last settled entry", () => withPeerFixture("pi-recovery-tail", async scope => {
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"].map(key => [key, process.env[key]]));
  scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const f = fixture(scope.root);
  assert.throws(() => observePiSession(f.work, f.id, f.timestamp, f.path));
  const rescued = rescuePiSession(f.work, f.id, f.path);
  assert.equal(rescued.entries, 4);
  assert.equal(observePiSession(f.work, f.id, f.timestamp, f.path).entries, 4);
  const lines = readFileSync(f.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.equal(lines.at(-1).message.role, "assistant");
  assert.equal(lines.at(-1).message.stopReason, "stop");
  // Idempotent: an already settled file is only re-observed.
  assert.equal(rescuePiSession(f.work, f.id, f.path, rescued).entries, 4);
  // A stale expectation never rewrites the file.
  assert.throws(() => rescuePiSession(f.work, f.id, f.path, { ...rescued, sha256: "0".repeat(64) }));
}));
