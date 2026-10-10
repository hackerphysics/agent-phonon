/** Independent strict Node process: a leaked detached rejection must kill this
 * fixture, not be masked by the parent test runner's rejection listeners. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononStore, ObsBus, type ObsEvent } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

const mode = process.argv[2]!;
const root = mkdtempSync(join(tmpdir(), "phonon-delivery-child-"));
const dbPath = join(root, "state.sqlite");
let store = new PhononStore(dbPath);
const bus = new ObsBus();
const notifications: ObsEvent[] = [];
bus.onEvent(e => { if (e.event.startsWith("delivery.")) notifications.push(e); });
store.delivery.configure(undefined, bus);
const registry = new AdapterRegistry();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
class RetryAdapter extends MockAdapter {
  private calls = 0;
  override async createSession(params: Parameters<MockAdapter["createSession"]>[0]) {
    if (++this.calls === 1) throw new Error("first provider launch failed");
    return super.createSession(params);
  }
}
const adapter = mode.includes("retry") || mode.includes("recovery")
  ? new RetryAdapter({ sendDelayMs: 100, proactiveOutput: true })
  : new MockAdapter({ sendDelayMs: mode === "scheduler-timeout" ? 500 : 100, proactiveOutput: true });
registry.register(adapter);
let tc = new TestConn({ registry, store, workspaceRoot: root });
const project = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
const projectId = project.project.projectId;
const db = new DatabaseSync(dbPath);
const privateError = `${root}/private-storage-location private-generated-payload`;
let priorRows = 0;
let runId: string | undefined;
let workflowId: string | undefined;
let triggerName = "";
let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; }); // --strict still terminates on any leaked rejection.

if (mode === "workflow-events") {
  const accepted = await tc.call("workflow.run", { project: projectId, plan: {
    mode: "dag", nodes: [{ nodeId: "n", agent: "mock:default", model: "m1", input: "work" }],
  } }) as { workflowId: string };
  workflowId = accepted.workflowId;
  priorRows = store.unackedWorkflowEvents("tenant-test").length;
  assert.ok(priorRows > 0);
  triggerName = "fail_workflow_events";
  db.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON workflow_events BEGIN SELECT RAISE(ABORT,'${privateError}'); END`);
} else {
  const accepted = await tc.call("schedule.create", {
    name: "failure", trigger: { kind: "manual" },
    target: { runKind: "session", project: projectId, agent: "mock:default", model: "m1", prompt: "work" },
    consent: { push: "full" },
    policy: { overlap: "queue", maxRetries: mode.includes("retry") || mode.includes("recovery") ? 1 : 0,
      ...(mode === "scheduler-timeout" ? { timeoutMs: 30 } : {}) },
  }) as { schedule: { id: string } };
  const first = await tc.call("schedule.trigger", { scheduleId: accepted.schedule.id }) as { runId: string };
  runId = first.runId;
  if (mode === "scheduler-retry" || mode === "scheduler-recovery") {
    assert.equal(store.getRun(runId)?.phase, "retry_wait");
    if (mode === "scheduler-recovery") {
      db.prepare("UPDATE runs SET retry_at=? WHERE id=?").run(Date.now() + 150, runId);
      await tc.conn.dispose(); store.close();
      store = new PhononStore(dbPath); store.delivery.configure(undefined, bus);
      tc = new TestConn({ registry, store, workspaceRoot: root });
    }
  } else {
    await tc.call("run.events.subscribe", { runId });
    adapter.lastSession!.emitUnsolicited("already durable");
    priorRows = store.unackedRunEvents("tenant-test").length;
    assert.ok(priorRows > 0);
    if (mode === "scheduler-queue") {
      const queued = await tc.call("schedule.trigger", { scheduleId: accepted.schedule.id }) as { runId: string };
      runId = queued.runId;
      assert.equal(store.getRun(runId)?.phase, "queued");
    }
  }
  if (mode === "run-events") {
    triggerName = "fail_run_events";
    db.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT,'${privateError}'); END`);
  } else {
    triggerName = "fail_runs";
    db.exec(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON runs WHEN NEW.id='${runId}' BEGIN SELECT RAISE(ABORT,'${privateError}'); END`);
  }
}

await delay(400);
assert.equal(store.delivery.snapshot().persistenceHealthy, false);
assert.throws(() => store.delivery.assertNewWork(), /unhealthy/);
assert.equal(unhandled, 0);
assert.ok(notifications.some(e => e.event === "delivery.persistence_failed"));
const telemetry = JSON.stringify(notifications);
assert.ok(!telemetry.includes(root) && !telemetry.includes("private-generated-payload"));
if (mode !== "run-events") assert.ok(notifications.some(e => e.event === "delivery.background_failed"), "detached write failure has a terminal notification");
if (workflowId) {
  assert.ok(store.getWorkflow(workflowId));
  assert.ok(store.unackedWorkflowEvents("tenant-test").length >= priorRows, "prior durable workflow rows remain replayable");
  assert.ok(!store.unackedWorkflowEvents("tenant-test").some(e => JSON.parse(e.payload).status === "completed"));
} else {
  assert.ok(store.getRun(runId!, "tenant-test"), "accepted run row is never erased on background failure");
  if (mode === "scheduler-queue") assert.equal(store.getRun(runId!)?.phase, "queued");
  if (mode.includes("retry") || mode.includes("recovery")) assert.equal(store.getRun(runId!)?.phase, "retry_wait");
  if (priorRows > 0) assert.ok(store.unackedRunEvents("tenant-test").length >= priorRows);
  if (mode === "run-events" || mode === "scheduler-timeout") {
    assert.ok(!tc.notifications.some(e => e.__method === "run.finished"), "failed persistence never publishes a fake successful terminal receipt");
  }
}
const result = { mode, survived: true, unhandledRejections: unhandled, persistenceHealthy: false,
  workflowPending: store.unackedWorkflowEvents("tenant-test").length, runPending: store.unackedRunEvents("tenant-test").length };
// Remove ONLY the injected test trigger before normal teardown; assertions above
// were made while storage failure remained continuous. No real device data exists.
db.exec(`DROP TRIGGER ${triggerName}`);
await tc.conn.dispose(); db.close(); store.close();
console.log(JSON.stringify(result));
