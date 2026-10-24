import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononStore } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

const dispatch = { key: "automation-1", revision: 1, contentHash: "a".repeat(64) };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "phonon-dispatch-"));
  const store = new PhononStore(join(dir, "state.sqlite"));
  const registry = new AdapterRegistry();
  const adapter = new MockAdapter({ name: "mock", agentIds: ["mock:default"], models: ["m1"] });
  let models = 0;
  const create = adapter.createSession.bind(adapter);
  adapter.createSession = async params => { models++; return create(params); };
  registry.register(adapter);
  let tc = new TestConn({ registry, store, trustLocal: true, workspaceRoot: dir });
  const { project } = await tc.call("project.create", { name: "dispatch", git: false }) as { project: { projectId: string } };
  const { schedule } = await tc.call("schedule.create", {
    name: "controller-authorized automation", trigger: { kind: "manual" },
    target: { project: project.projectId, runKind: "dispatch", dispatch },
    policy: { overlap: "queue" }, consent: { push: "full" },
  }) as { schedule: { id: string } };
  return {
    store, registry, schedule, get tc() { return tc; }, get models() { return models; },
    async restart() { await tc.conn.dispose(); tc = new TestConn({ registry, store, trustLocal: true, workspaceRoot: dir }); },
    async close() { await tc.conn.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("L4 controller dispatch freezes identity/input and starts no model", async () => {
  const f = await fixture();
  try {
    const input = { eventID: "evt-1", text: "untrusted observation" };
    const { runId } = await f.tc.call("schedule.trigger", { scheduleId: f.schedule.id, input }) as { runId: string };
    const { run } = await f.tc.call("run.get", { runId }) as { run: Record<string, unknown> };
    assert.equal(f.models, 0);
    assert.equal(run.status, "running");
    assert.equal(run.sessionId, undefined);
    assert.equal(run.workflowId, undefined);
    assert.deepEqual(run.dispatch, dispatch);
    assert.deepEqual(run.input, input);
    const resolution = { runId, dispatch, status: "success", resultText: "actual native result", clientRequestId: "resolve-original" };
    await f.tc.call("run.resolve", resolution);
    assert.equal(f.models, 0);
    const terminal = await f.tc.call("run.get", { runId }) as { run: Record<string, unknown> };
    assert.equal(terminal.run.status, "success");
    assert.equal(terminal.run.resultText, "actual native result");
    assert.deepEqual(terminal.run.dispatch, dispatch);
    assert.deepEqual(terminal.run.input, input);
    await f.tc.call("run.resolve", resolution);
    await assert.rejects(() => f.tc.call("run.resolve", { ...resolution, status: "failed" }));
    await assert.rejects(() => f.tc.call("run.resolve", { runId, dispatch, status: "failed" }));
  } finally { await f.close(); }
});

test("L4 dispatch identity cannot be replaced by a new schedule revision", async () => {
  const f = await fixture();
  try {
    const { runId } = await f.tc.call("schedule.trigger", { scheduleId: f.schedule.id }) as { runId: string };
    await assert.rejects(() => f.tc.call("run.resolve", { runId, dispatch: { ...dispatch, revision: 2 }, status: "success" }));
    const outsider = new TestConn({ registry: f.registry, store: f.store, tenantId: "other", trustLocal: true });
    try { await assert.rejects(() => outsider.call("run.resolve", { runId, dispatch, status: "success" })); }
    finally { await outsider.conn.dispose(); }
    assert.equal((await f.tc.call("run.get", { runId }) as { run: { status: string } }).run.status, "running");
  } finally { await f.close(); }
});

test("L4 dispatch handoff and queued occurrence survive reconnect without new execution", async () => {
  const f = await fixture();
  try {
    const first = await f.tc.call("schedule.trigger", { scheduleId: f.schedule.id, input: "first" }) as { runId: string };
    const second = await f.tc.call("schedule.trigger", { scheduleId: f.schedule.id, input: "second" }) as { runId: string };
    await f.restart();
    assert.equal((await f.tc.call("run.get", { runId: first.runId }) as { run: { status: string } }).run.status, "running");
    assert.equal((await f.tc.call("run.get", { runId: second.runId }) as { run: { status: string } }).run.status, "pending");
    await assert.rejects(() => f.tc.call("run.resolve", { runId: second.runId, dispatch, status: "success" }));
    await f.tc.call("run.resolve", { runId: first.runId, dispatch, status: "success" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.tc.call("run.get", { runId: second.runId }) as { run: { status: string } }).run.status, "running");
    assert.equal(f.models, 0);
  } finally { await f.close(); }
});

test("run.resolve never settles an ordinary model execution", async () => {
  const f = await fixture();
  try {
    const project = (await f.tc.call("schedule.get", { scheduleId: f.schedule.id }) as { schedule: { target: { project: string } } }).schedule.target.project;
    const { schedule } = await f.tc.call("schedule.create", {
      name: "ordinary", trigger: { kind: "manual" }, target: { project, agent: "mock:default", model: "m1", prompt: "hello" },
    }) as { schedule: { id: string } };
    const { runId } = await f.tc.call("schedule.trigger", { scheduleId: schedule.id }) as { runId: string };
    await assert.rejects(() => f.tc.call("run.resolve", { runId, dispatch, status: "success" }));
  } finally { await f.close(); }
});

test("L4 dispatch expires locally and does not inherit indefinite execution authority", async () => {
  const f = await fixture();
  try {
    const { schedule } = await f.tc.call("schedule.get", { scheduleId: f.schedule.id }) as { schedule: { target: Record<string, unknown> } };
    await f.tc.call("schedule.update", { scheduleId: f.schedule.id, target: { ...schedule.target, dispatch: { ...dispatch, expiresAt: new Date(Date.now() - 1000).toISOString() } } });
    await assert.rejects(() => f.tc.call("schedule.trigger", { scheduleId: f.schedule.id }));
    assert.equal((await f.tc.call("schedule.get", { scheduleId: f.schedule.id }) as { schedule: { enabled: boolean } }).schedule.enabled, false);
    assert.equal(f.models, 0);
  } finally { await f.close(); }
});

test("L4 offline dispatch backlog is bounded and terminal ACKs drain oldest records", async () => {
  const f = await fixture();
  try {
    await f.tc.call("schedule.update", { scheduleId: f.schedule.id, policy: { overlap: "allow" } });
    for (let index = 0; index < 75; index++) await f.tc.call("schedule.trigger", { scheduleId: f.schedule.id });
    const { runs } = await f.tc.call("schedule.runs.list", { scheduleId: f.schedule.id, unackedOnly: true, limit: 100 }) as { runs: Array<{ id: string; status: string }> };
    assert.equal(runs.length, 75);
    assert.equal(runs.filter(run => run.status === "running").length, 32);
    assert.equal(runs.filter(run => run.status === "skipped").length, 43);
    for (const run of runs.filter(run => run.status === "skipped")) await f.tc.call("schedule.ack", { runId: run.id, finished: true });
    const remaining = await f.tc.call("schedule.runs.list", { scheduleId: f.schedule.id, unackedOnly: true, limit: 100 }) as { runs: unknown[] };
    assert.equal(remaining.runs.length, 32); assert.equal(f.models, 0);
  } finally { await f.close(); }
});
