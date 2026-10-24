import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observePiSession, piSessionLocation, verifyPiSession } from "./pi-recovery.js";
import { withPeerFixture } from "../testing/peer-fixture.js";

async function fixture(work: (f: {
  file: string; write: (messages: Record<string, unknown>[]) => void;
  observe: () => ReturnType<typeof observePiSession>;
  user: Record<string, unknown>; failed: Record<string, unknown>; completed: Record<string, unknown>;
}) => Promise<void>) {
  return withPeerFixture("pi-retry-recovery", async scope => {
    const home = join(scope.root, "pi"); mkdirSync(home, { mode: 0o700 });
    const previous = new Map(["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_HOME"].map(key => [key, process.env[key]]));
    scope.defer(() => { for (const [key,value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    process.env.PI_CODING_AGENT_DIR = home; delete process.env.PI_CODING_AGENT_SESSION_DIR; delete process.env.PI_CODING_AGENT_HOME;
    const location = piSessionLocation(scope.root); mkdirSync(location.sessionDir, { recursive: true, mode: 0o700 });
    const sessionId = randomUUID(), timestamp = new Date().toISOString();
    const file = join(location.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    const user = { role: "user", content: [{ type: "text", text: "Original input" }] };
    const failed = { role: "assistant", provider: "fixture", model: "m1", stopReason: "error", content: [], errorMessage: "temporary failure" };
    const completed = { role: "assistant", provider: "fixture", model: "m1", stopReason: "stop", content: [{ type: "text", text: "Original native success" }] };
    const write = (messages: Record<string, unknown>[]) => {
      const rows = [{ type: "session", version: 3, id: sessionId, timestamp, cwd: scope.root },
        ...messages.map((message, index) => ({ type: "message", id: `entry-${index}`, parentId: index === 0 ? null : `entry-${index - 1}`, timestamp, message }))];
      writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    };
    await work({ file, write, observe: () => observePiSession(scope.root, sessionId, timestamp), user, failed, completed });
  });
}

test("Pi settled native retry preserves failed attempt records without rewriting them or changing model authority", { skip: process.platform === "win32" }, () => fixture(async f => {
  f.write([f.user, f.failed, f.failed, f.completed]);
  const before = readFileSync(f.file), observed = f.observe();
  assert.equal(observed.nativeModel, "fixture/m1"); assert.equal(observed.entries, 5);
  assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(verifyPiSession(observed, observed.cwd), observed);
}));

test("Pi error tails, explicit aborts and a new user/model cannot impersonate native retry success", { skip: process.platform === "win32" }, () => fixture(async f => {
  for (const messages of [[f.user, f.failed], [f.user, f.completed, f.failed],
    [f.user, f.failed, f.user, f.completed], [f.user, f.failed, { ...f.completed, model: "foreign" }],
    [f.user, { ...f.failed, stopReason: "aborted" }, f.completed],
    [f.user, { ...f.failed, content: [{ type: "toolCall", id: "unreturned", name: "read", arguments: {} }] }, f.completed]]) {
    f.write(messages); assert.throws(f.observe, (error: any) => error.appCode === "errSessionBusy");
  }
  f.write([f.user,f.failed,f.completed]);
  const rows=readFileSync(f.file,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  rows[3].parentId="model-switch";
  rows.splice(3,0,{type:"model_change",id:"model-switch",parentId:rows[2].id,timestamp:rows[2].timestamp,provider:"fixture",modelId:"m1"});
  writeFileSync(f.file,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
  assert.throws(f.observe,(error:any)=>error.appCode==="errSessionBusy");
}));
