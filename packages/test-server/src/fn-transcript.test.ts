import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononStore } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

function setup() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "phonon-tx-")), "db.sqlite");
  const root = mkdtempSync(join(tmpdir(), "phonon-txw-"));
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"], reply: (i) => `echo:${i}` }));
  const store = new PhononStore(dbPath);
  const tc = new TestConn({ registry: reg, workspaceRoot: root, trustLocal: true, store });
  return { tc, store, dbPath };
}

test("transcript: snapshot file created with meta + input + event lines", async () => {
  const { tc, store } = setup();
  const p = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const s = (await tc.call("session.create", { project: p.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages" })) as { sessionId: string };

  // session.status 应带 transcriptPath
  const st = (await tc.call("session.status", { sessionId: s.sessionId })) as { transcriptPath?: string };
  assert.ok(st.transcriptPath, "session.status should expose transcriptPath");
  assert.ok(existsSync(st.transcriptPath!), "transcript file should exist after create (meta line)");

  // 跑一轮，事件应被 tee 进快照
  const ack = (await tc.call("session.send", { sessionId: s.sessionId, input: "hello" })) as { turnId: string };
  await tc.waitTurnEnd(ack.turnId);

  const lines = readFileSync(st.transcriptPath!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const kinds = lines.map((l) => l.kind);
  assert.ok(kinds.includes("meta"), "has meta header line");
  assert.ok(kinds.includes("input"), "has input line");
  assert.ok(kinds.includes("event"), "has event line(s)");

  // input 行内容完整（不截断）
  const inputLine = lines.find((l) => l.kind === "input") as { input?: string; turnId?: string };
  assert.equal(inputLine.input, "hello");
  assert.ok(inputLine.turnId, "input line carries turnId");

  // 至少有一个 message/result 事件且能看到 echo:hello
  const raw = readFileSync(st.transcriptPath!, "utf8");
  assert.ok(raw.includes("echo:hello"), "event stream contains adapter output");

  store.close();
});

test("transcript: path persisted in sessions table + survives restart", async () => {
  const { tc, store, dbPath } = setup();
  const p = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const s = (await tc.call("session.create", { project: p.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages" })) as { sessionId: string };
  const st = (await tc.call("session.status", { sessionId: s.sessionId })) as { transcriptPath?: string };
  const path = st.transcriptPath!;
  store.close();

  // 模拟重启：新 store，session 恢复后 transcriptPath 仍在
  const reg2 = new AdapterRegistry();
  reg2.register(new MockAdapter({ name: "mock", agentIds: ["mock:default"] }));
  const store2 = new PhononStore(dbPath);
  const tc2 = new TestConn({ registry: reg2, workspaceRoot: mkdtempSync(join(tmpdir(), "phonon-tx2-")), trustLocal: true, store: store2 });
  const st2 = (await tc2.call("session.status", { sessionId: s.sessionId })) as { transcriptPath?: string };
  assert.equal(st2.transcriptPath, path, "transcriptPath survives restart");
  store2.close();
});

test("transcript: 0600 file permission on POSIX", async () => {
  if (process.platform === "win32") return; // Windows 无 chmod
  const { tc, store } = setup();
  const p = (await tc.call("project.create", { name: "p", git: false })) as { project: { projectId: string } };
  const s = (await tc.call("session.create", { project: p.project.projectId, agent: "mock:default", model: "m1", verbosity: "messages" })) as { sessionId: string };
  const ack = (await tc.call("session.send", { sessionId: s.sessionId, input: "x" })) as { turnId: string };
  await tc.waitTurnEnd(ack.turnId);
  const st = (await tc.call("session.status", { sessionId: s.sessionId })) as { transcriptPath?: string };
  const mode = statSync(st.transcriptPath!).mode & 0o777;
  assert.equal(mode, 0o600, "transcript file should be 0600");
  store.close();
});

export {};
