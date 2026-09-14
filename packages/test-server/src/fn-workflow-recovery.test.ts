import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  PhononStore,
  type AdapterSession,
  type AgentAdapter,
} from "@agent-phonon/core";
import type { StreamEvent } from "@agent-phonon/protocol";
import { TestConn } from "./harness.js";

interface Control {
  calls: string[];
  activeParticipants: number;
  maxActiveParticipants: number;
  participantCompleted: number;
  chairmanSawCompleted: number;
  hangInterrupt?: boolean;
  hangTerminate?: boolean;
  reply(input: string, agentId?: string): { text: string; delay?: number; participant?: boolean; chairman?: boolean; dirty?: boolean; failed?: boolean };
}

class ControlledAdapter implements AgentAdapter {
  readonly name = "controlled";
  readonly capabilities = {
    nativeSession: true, nativeCompression: false, contextInjection: false,
    proactiveOutput: false, modelSwitch: false, interrupt: true,
    injectMidTurn: false, skillManagement: false, hooks: [], streaming: true,
  } as never;
  constructor(private control: Control) {}
  async discoverAgents() {
    return ["controlled:a", "controlled:b", "controlled:exec", "controlled:w", "controlled:p1", "controlled:p2", "controlled:p3", "controlled:p4", "controlled:chair"].map((agentId) => ({
      agentId: agentId as never, displayName: agentId, adapter: this.name, available: true,
      models: [{ id: "m1", available: true }], capabilities: this.capabilities,
      scannedAt: new Date().toISOString(),
    }));
  }
  async createSession(params: { sessionId: string; model: string; cwd: string; agentId?: string }): Promise<AdapterSession> {
    const control = this.control;
    return {
      sessionId: params.sessionId,
      model: params.model,
      async send(input, opts) {
        control.calls.push(input);
        const response = control.reply(input, params.agentId);
        if (response.dirty) writeFileSync(join(params.cwd, "uncommitted.txt"), "dirty\n");
        if (response.participant) {
          control.activeParticipants++;
          control.maxActiveParticipants = Math.max(control.maxActiveParticipants, control.activeParticipants);
        }
        if (response.chairman) control.chairmanSawCompleted = control.participantCompleted;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, response.delay ?? 0);
          opts.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (response.participant) {
          control.activeParticipants--;
          if (!opts.signal?.aborted) control.participantCompleted++;
        }
        if (opts.signal?.aborted) {
          // Deliberately late terminal event: WorkflowEngine/SessionEngine must fence it.
          setTimeout(() => opts.emit({ type: "result", sessionId: params.sessionId, turnId: opts.turnId, seq: 99, at: new Date().toISOString(), status: "failed", text: "late", final: true } as StreamEvent), 20);
          return;
        }
        opts.emit({ type: "message", sessionId: params.sessionId, turnId: opts.turnId, seq: 0, at: new Date().toISOString(), role: "assistant", text: response.text, delta: false } as StreamEvent);
        opts.emit({ type: "result", sessionId: params.sessionId, turnId: opts.turnId, seq: 1, at: new Date().toISOString(), status: response.failed ? "failed" : "completed", text: response.text, final: true } as StreamEvent);
      },
      async interrupt() {
        if (control.hangInterrupt) await new Promise<void>(() => {});
      },
      async terminate() {
        if (control.hangTerminate) await new Promise<void>(() => {});
      },
    };
  }
}

function setup(reply: Control["reply"]) {
  const root = mkdtempSync(join(tmpdir(), "phonon-wf-recovery-"));
  const store = new PhononStore(join(root, "state.db"));
  const control: Control = { calls: [], activeParticipants: 0, maxActiveParticipants: 0, participantCompleted: 0, chairmanSawCompleted: 0, reply };
  const conn = () => {
    const registry = new AdapterRegistry();
    registry.register(new ControlledAdapter(control));
    return new TestConn({ registry, store, tenantId: "tenant-recovery", workspaceRoot: root });
  };
  return { root, store, control, conn };
}

async function waitFor(tc: TestConn, workflowId: string, predicate: (status: any) => boolean, timeoutMs = 5000): Promise<any> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await tc.call("workflow.status", { workflowId });
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`workflow ${workflowId} did not reach expected state`);
}

async function project(tc: TestConn, name: string): Promise<string> {
  const result = await tc.call("project.create", { name }) as { project: { projectId: string } };
  return result.project.projectId;
}

async function waitRun(store: PhononStore, runId: string, status: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const row = store.getRun(runId, "tenant-recovery");
    if (row?.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`schedule run ${runId} did not reach ${status}`);
}

test("DAG auto-recovers after connection crash without rerunning completed nodes", async () => {
  const fx = setup((input) => input === "slow-b" ? { text: "B", delay: 500 } : { text: "A", delay: 10 });
  const first = fx.conn();
  const projectId = await project(first, "dag-recovery");
  const run = await first.call("workflow.run", { project: projectId, plan: { mode: "dag", nodes: [
    { nodeId: "a", agent: "controlled:a", model: "m1", input: "fast-a" },
    { nodeId: "b", agent: "controlled:b", model: "m1", input: "slow-b", dependsOn: ["a"] },
  ] } }) as { workflowId: string };
  await waitFor(first, run.workflowId, (s) => s.nodes.find((n: any) => n.nodeId === "b")?.status === "running");
  await first.conn.dispose("simulated crash");

  const second = fx.conn();
  const done = await waitFor(second, run.workflowId, (s) => s.status === "completed") as { nodes: any[] };
  assert.equal(fx.control.calls.filter((x) => x === "fast-a").length, 1);
  assert.equal(done.nodes.find((n) => n.nodeId === "a").attempts.length, 1);
  assert.equal(done.nodes.find((n) => n.nodeId === "b").attempts.length, 2);
  const history = await second.call("workflow.events.list", { workflowId: run.workflowId, limit: 200 }) as { events: Array<{ seq: number; type: string }> };
  assert.ok(history.events.length > 0, "workflow event history must survive connection replacement");
  assert.deepEqual(history.events.map((event) => event.seq), [...history.events].map((event) => event.seq).sort((a, b) => a - b));
  await second.call("workflow.ack", { workflowId: run.workflowId, lastSeq: 999_999 });
  const acked = fx.store.getWorkflow(run.workflowId, "tenant-recovery")!;
  assert.equal(acked.acked_seq, Number(acked.seq) - 1, "future ACK cannot suppress later workflow events");
  await second.conn.dispose();
  fx.store.close();
});

test("scheduled workflow and its run recover together across connection replacement", async () => {
  const fx = setup((input) => ({ text: `scheduled:${input}`, delay: 400 }));
  const first = fx.conn();
  const projectId = await project(first, "scheduled-recovery");
  const schedule = await first.call("schedule.create", {
    name: "recover workflow", trigger: { kind: "manual" },
    target: { runKind: "workflow", project: projectId, plan: { mode: "dag", finalNodeId: "a", nodes: [
      { nodeId: "a", agent: "controlled:a", model: "m1", input: "scheduled-work" },
    ] } },
    consent: { push: "summary" }, policy: { overlap: "skip", maxRetries: 0, catchUp: false },
  }) as { schedule: { id: string } };
  const triggered = await first.call("schedule.trigger", { scheduleId: schedule.schedule.id, input: "dynamic-work" }) as { runId: string };
  const active = await waitRun(fx.store, triggered.runId, "running");
  assert.ok(active.workflow_id);
  assert.equal(JSON.parse(active.input_json as string), "dynamic-work");
  await first.conn.dispose("scheduled workflow reconnect");
  assert.equal(fx.store.getRun(triggered.runId, "tenant-recovery")?.status, "running");

  const second = fx.conn();
  const finished = await waitRun(fx.store, triggered.runId, "success");
  assert.match(String(finished.result_text), /scheduled:scheduled-work/);
  assert.equal((await second.call("workflow.status", { workflowId: active.workflow_id }) as any).status, "completed");
  await second.conn.dispose();
  fx.store.close();
});

test("run.event payloads persist before send and replay after reconnect until ACK", async () => {
  const fx = setup((input) => ({ text: `event:${input}`, delay: 120 }));
  const first = fx.conn();
  const projectId = await project(first, "run-event-replay");
  const schedule = await first.call("schedule.create", {
    name: "event replay", trigger: { kind: "manual" },
    target: { runKind: "workflow", project: projectId, plan: { mode: "dag", finalNodeId: "a", nodes: [
      { nodeId: "a", agent: "controlled:a", model: "m1", input: "event-work" },
    ] } },
    consent: { push: "full" }, policy: { overlap: "skip", maxRetries: 0, catchUp: false },
  }) as { schedule: { id: string } };
  const triggered = await first.call("schedule.trigger", { scheduleId: schedule.schedule.id }) as { runId: string };
  await first.call("run.events.subscribe", { runId: triggered.runId });
  await waitRun(fx.store, triggered.runId, "success");
  const pending = fx.store.unackedRunEvents("tenant-recovery").filter((event) => event.runId === triggered.runId);
  assert.ok(pending.length > 0);
  await first.conn.dispose();
  const second = fx.conn();
  assert.ok(second.notifications.some((event) => event.__method === "run.event" && event.runId === triggered.runId));
  await second.call("schedule.ack", { runId: triggered.runId, lastSeq: pending.at(-1)!.seq });
  assert.equal(fx.store.unackedRunEvents("tenant-recovery").filter((event) => event.runId === triggered.runId).length, 0);
  await second.conn.dispose();
  fx.store.close();
});

test("same-tenant contender cannot own or overwrite an active scheduled run", async () => {
  const fx = setup((input) => ({ text: `winner:${input}`, delay: 80 }));
  const owner = fx.conn();
  const projectId = await project(owner, "run-owner");
  const schedule = await owner.call("schedule.create", {
    name: "single run owner", trigger: { kind: "manual" },
    target: { runKind: "workflow", project: projectId, plan: { mode: "dag", finalNodeId: "a", nodes: [
      { nodeId: "a", agent: "controlled:a", model: "m1", input: "owner-work" },
    ] } },
    consent: { push: "summary" }, policy: { overlap: "skip", maxRetries: 0, catchUp: false, timeoutMs: 250 },
  }) as { schedule: { id: string } };
  const triggered = await owner.call("schedule.trigger", { scheduleId: schedule.schedule.id }) as { runId: string };
  await waitRun(fx.store, triggered.runId, "running");
  const contender = fx.conn();
  await waitRun(fx.store, triggered.runId, "success");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fx.store.getRun(triggered.runId, "tenant-recovery")?.status, "success");
  await contender.conn.dispose();
  await owner.conn.dispose();
  fx.store.close();
});

test("scheduler restores a persisted retry_wait deadline and launches the remaining attempt", async () => {
  const fx = setup((input) => ({ text: `retry-wait:${input}`, delay: 10 }));
  const seed = fx.conn();
  const projectId = await project(seed, "retry-wait-recovery");
  await seed.conn.dispose();
  const now = new Date().toISOString();
  const scheduleId = "sch-retry-wait";
  const runId = "run-retry-wait";
  fx.store.upsertSchedule({
    id: scheduleId, tenantId: "tenant-recovery", name: "retry wait", enabled: true,
    triggerJson: '{"kind":"manual"}',
    targetJson: JSON.stringify({ runKind: "workflow", project: projectId, plan: { mode: "dag", finalNodeId: "a", nodes: [{ nodeId: "a", agent: "controlled:a", model: "m1" }] } }),
    consentJson: '{"push":"summary"}', policyJson: '{"overlap":"skip","maxRetries":1,"catchUp":false}',
    createdAt: now, updatedAt: now,
  });
  fx.store.upsertRun({
    id: runId, scheduleId, tenantId: "tenant-recovery", triggerSource: "manual", status: "pending",
    createdAt: now, startedAt: now, attempt: 1, maxAttempts: 2,
    retryHistoryJson: JSON.stringify([{ attempt: 1, at: now, phase: "runtime", error: "first failed" }]),
    inputJson: JSON.stringify("persisted-input"), phase: "retry_wait", retryAt: Date.now() + 100,
    ownerId: "dead-scheduler", ownerEpoch: 1, leaseUntil: Date.now() - 1,
  });
  const recovered = fx.conn();
  const finished = await waitRun(fx.store, runId, "success");
  assert.equal(finished.attempt, 2);
  assert.match(String(finished.result_text), /retry-wait:persisted-input/);
  await recovered.conn.dispose();
  fx.store.close();
});

test("scheduler re-correlates a durable workflow when crash precedes run.workflowId persistence", async () => {
  const fx = setup((input) => ({ text: `correlated:${input}`, delay: 20 }));
  const seed = fx.conn();
  const projectId = await project(seed, "mapping-crash-window");
  await seed.conn.dispose();
  const now = new Date().toISOString();
  const scheduleId = "sch-mapping-window";
  const runId = "run-mapping-window";
  const workflowId = "wf-mapping-window";
  fx.store.upsertSchedule({
    id: scheduleId, tenantId: "tenant-recovery", name: "mapping", enabled: true,
    triggerJson: '{"kind":"manual"}',
    targetJson: JSON.stringify({ runKind: "workflow", project: projectId, plan: { mode: "dag", finalNodeId: "a", nodes: [{ nodeId: "a", agent: "controlled:a", model: "m1", input: "recover-map" }] } }),
    consentJson: '{"push":"summary"}', policyJson: '{"overlap":"skip","maxRetries":0,"catchUp":false}',
    createdAt: now, updatedAt: now,
  });
  fx.store.upsertRun({
    id: runId, scheduleId, tenantId: "tenant-recovery", triggerSource: "manual", status: "running",
    createdAt: now, startedAt: now, attempt: 1, maxAttempts: 1, retryHistoryJson: "[]",
  });
  fx.store.upsertWorkflow({
    workflowId, tenantId: "tenant-recovery", projectId, mode: "dag",
    planJson: JSON.stringify({ mode: "dag", finalNodeId: "a", nodes: [{ nodeId: "a", agent: "controlled:a", model: "m1", input: "recover-map" }] }),
    policyJson: '{"onNodeFailure":"fail_workflow"}', status: "queued",
    nodesJson: JSON.stringify([{ nodeId: "a", status: "pending", agent: "controlled:a", model: "m1" }]),
    seq: 0, ackedSeq: -1, createdAt: now, updatedAt: now,
    checkpointJson: '{"controlEpoch":0,"persistentSessions":{},"autoWorktrees":{},"mainBranchCheckedOut":{}}',
    ownerId: "dead-owner", ownerEpoch: 1, leaseUntil: Date.now() - 1,
    metadataJson: JSON.stringify({ scheduleId, runId, attempt: 1 }),
  });
  const recovered = fx.conn();
  const finished = await waitRun(fx.store, runId, "success");
  assert.equal(finished.workflow_id, workflowId);
  assert.match(String(finished.result_text), /correlated:recover-map/);
  await recovered.conn.dispose();
  fx.store.close();
});

test("direct workflow automatic recovery keeps one absolute timeout budget", async () => {
  const fx = setup((input) => ({ text: `late:${input}`, delay: 2_000 }));
  const first = fx.conn();
  const projectId = await project(first, "direct-timeout-recovery");
  const run = await first.call("workflow.run", {
    project: projectId, policy: { timeoutSeconds: 1 },
    plan: { mode: "dag", finalNodeId: "a", nodes: [{ nodeId: "a", agent: "controlled:a", model: "m1", input: "slow-direct" }] },
  }) as { workflowId: string };
  await waitFor(first, run.workflowId, (status) => status.status === "running");
  const deadlineBefore = JSON.parse(fx.store.getWorkflow(run.workflowId, "tenant-recovery")!.checkpoint_json as string).deadlineAt;
  await new Promise((resolve) => setTimeout(resolve, 600));
  await first.conn.dispose("direct timeout reconnect");
  const second = fx.conn();
  const deadlineAfter = JSON.parse(fx.store.getWorkflow(run.workflowId, "tenant-recovery")!.checkpoint_json as string).deadlineAt;
  assert.equal(deadlineAfter, deadlineBefore, "automatic recovery must preserve the absolute deadline");
  await waitFor(second, run.workflowId, (status) => status.status === "timeout", 3_000);
  await second.conn.dispose();
  fx.store.close();
});

test("scheduled workflow recovery keeps the original timeout budget", async () => {
  const fx = setup((input) => ({ text: `late:${input}`, delay: 500 }));
  const first = fx.conn();
  const projectId = await project(first, "scheduled-timeout-recovery");
  const schedule = await first.call("schedule.create", {
    name: "timeout workflow", trigger: { kind: "manual" },
    target: { runKind: "workflow", project: projectId, plan: { mode: "dag", finalNodeId: "a", nodes: [
      { nodeId: "a", agent: "controlled:a", model: "m1", input: "slow" },
    ] } },
    consent: { push: "summary" }, policy: { overlap: "skip", maxRetries: 0, catchUp: false, timeoutMs: 250 },
  }) as { schedule: { id: string } };
  const triggered = await first.call("schedule.trigger", { scheduleId: schedule.schedule.id }) as { runId: string };
  const activeBefore = await waitRun(fx.store, triggered.runId, "running");
  const startedAtBefore = activeBefore.started_at;
  await new Promise((resolve) => setTimeout(resolve, 120));
  await first.conn.dispose("timeout reconnect");
  const second = fx.conn();
  assert.equal(fx.store.getRun(triggered.runId, "tenant-recovery")?.started_at, startedAtBefore);
  await waitRun(fx.store, triggered.runId, "timeout", 2_000);
  await second.conn.dispose();
  fx.store.close();
});

test("scheduled workflow retry after recovery preserves trigger input", async () => {
  let attempt = 0;
  const fx = setup((input) => {
    attempt++;
    if (attempt === 1) return { text: "aborted by reconnect", delay: 300 };
    if (attempt === 2) return { text: "recovered attempt failed", delay: 10, failed: true };
    return { text: `retry:${input}`, delay: 10 };
  });
  const first = fx.conn();
  const projectId = await project(first, "scheduled-retry-input");
  const schedule = await first.call("schedule.create", {
    name: "retry workflow", trigger: { kind: "manual" },
    target: { runKind: "workflow", project: projectId, plan: { mode: "dag", finalNodeId: "a", nodes: [
      { nodeId: "a", agent: "controlled:a", model: "m1" },
    ] } },
    consent: { push: "summary" }, policy: { overlap: "skip", maxRetries: 1, catchUp: false },
  }) as { schedule: { id: string } };
  const triggered = await first.call("schedule.trigger", { scheduleId: schedule.schedule.id, input: "keep-me" }) as { runId: string };
  await waitRun(fx.store, triggered.runId, "running");
  await first.conn.dispose("retry reconnect");
  const second = fx.conn();
  const finished = await waitRun(fx.store, triggered.runId, "success");
  assert.match(String(finished.result_text), /retry:keep-me/);
  assert.equal(fx.control.calls.at(-1), "keep-me");
  await second.conn.dispose();
  fx.store.close();
});

test("workflow owner lease prevents a second connection from executing the same workflow", async () => {
  const fx = setup((input) => ({ text: input, delay: 300 }));
  const owner = fx.conn();
  const projectId = await project(owner, "single-owner");
  const run = await owner.call("workflow.run", { project: projectId, plan: { mode: "dag", nodes: [
    { nodeId: "a", agent: "controlled:a", model: "m1", input: "only-once" },
  ] } }) as { workflowId: string };
  await waitFor(owner, run.workflowId, (s) => s.status === "running");
  const contender = fx.conn();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fx.control.calls.filter((x) => x === "only-once").length, 1);
  await waitFor(owner, run.workflowId, (s) => s.status === "completed");
  await owner.conn.dispose();
  await contender.conn.dispose();
  fx.store.close();
});

test("pause/resume fences late events and persists node attempts; cancel remains terminal", async () => {
  const fx = setup((input) => ({ text: `done:${input}`, delay: 300 }));
  const tc = fx.conn();
  const projectId = await project(tc, "controls");
  const pausedRun = await tc.call("workflow.run", { project: projectId, plan: { mode: "dag", nodes: [
    { nodeId: "a", agent: "controlled:a", model: "m1", input: "pause-me" },
  ] } }) as { workflowId: string };
  await waitFor(tc, pausedRun.workflowId, (s) => s.status === "running");
  await tc.call("workflow.pause", { workflowId: pausedRun.workflowId, reason: "operator" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await tc.call("workflow.status", { workflowId: pausedRun.workflowId }) as any).status, "paused");
  await assert.rejects(() => tc.call("workflow.resume", { workflowId: pausedRun.workflowId, strategy: "node:missing" }));
  await assert.rejects(() => tc.call("workflow.resume", { workflowId: pausedRun.workflowId, strategy: "continue", rerunNodes: ["missing"] }));
  await tc.call("workflow.resume", { workflowId: pausedRun.workflowId, strategy: "continue" });
  const resumed = await waitFor(tc, pausedRun.workflowId, (s) => s.status === "completed") as { nodes: any[] };
  assert.deepEqual(resumed.nodes[0].attempts.map((a: any) => a.status), ["interrupted", "completed"]);
  await assert.rejects(() => tc.call("workflow.resume", { workflowId: pausedRun.workflowId, strategy: "failed_node" }));

  const cancelRun = await tc.call("workflow.run", { project: projectId, plan: { mode: "dag", nodes: [
    { nodeId: "c", agent: "controlled:a", model: "m1", input: "cancel-me" },
  ] } }) as { workflowId: string };
  await waitFor(tc, cancelRun.workflowId, (s) => s.status === "running");
  await tc.call("workflow.cancel", { workflowId: cancelRun.workflowId });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((await tc.call("workflow.status", { workflowId: cancelRun.workflowId }) as any).status, "cancelled");
  await tc.conn.dispose();
  fx.store.close();
});

test("pause/cancel remain bounded when adapter control methods never settle", async () => {
  const fx = setup((input) => ({ text: `done:${input}`, delay: 10_000 }));
  const tc = fx.conn();
  const projectId = await project(tc, "bounded-controls");

  const pausedRun = await tc.call("workflow.run", { project: projectId, plan: { mode: "dag", nodes: [
    { nodeId: "a", agent: "controlled:a", model: "m1", input: "pause-stuck" },
  ] } }) as { workflowId: string };
  await waitFor(tc, pausedRun.workflowId, (s) => s.status === "running");
  fx.control.hangInterrupt = true;
  const pauseStarted = Date.now();
  await tc.call("workflow.pause", { workflowId: pausedRun.workflowId });
  assert.ok(Date.now() - pauseStarted < 2_500, "pause must not wait forever for adapter.interrupt");
  assert.equal((await tc.call("workflow.status", { workflowId: pausedRun.workflowId }) as any).status, "paused");
  fx.control.hangInterrupt = false;

  const cancelRun = await tc.call("workflow.run", { project: projectId, plan: { mode: "dag", nodes: [
    { nodeId: "b", agent: "controlled:b", model: "m1", input: "cancel-stuck" },
  ] } }) as { workflowId: string };
  await waitFor(tc, cancelRun.workflowId, (s) => s.status === "running");
  fx.control.hangTerminate = true;
  const cancelStarted = Date.now();
  await tc.call("workflow.cancel", { workflowId: cancelRun.workflowId });
  assert.ok(Date.now() - cancelStarted < 2_500, "cancel must not wait forever for adapter.terminate");
  assert.equal((await tc.call("workflow.status", { workflowId: cancelRun.workflowId }) as any).status, "cancelled");
  fx.control.hangTerminate = false;

  await tc.conn.dispose();
  fx.store.close();
});

test("connection session restore and dispose stay tenant-scoped", async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-tenant-session-"));
  const store = new PhononStore(join(root, "state.db"));
  const registry = new AdapterRegistry();
  const control: Control = {
    calls: [], activeParticipants: 0, maxActiveParticipants: 0, participantCompleted: 0, chairmanSawCompleted: 0,
    reply: (input) => ({ text: input }),
  };
  registry.register(new ControlledAdapter(control));
  const tenantA = new TestConn({ registry, store, tenantId: "tenant-a", workspaceRoot: root });
  const projectId = await project(tenantA, "tenant-a-project");
  const session = await tenantA.call("session.create", {
    project: projectId, agent: "controlled:a", model: "m1", verbosity: "messages",
  }) as { sessionId: string };
  const tenantB = new TestConn({ registry, store, tenantId: "tenant-b", workspaceRoot: root });
  await assert.rejects(() => tenantB.call("session.status", { sessionId: session.sessionId }));
  await tenantB.conn.dispose("tenant-b disconnect");
  assert.equal(store.loadSessions("tenant-a").find((row) => row.session_id === session.sessionId)?.status, "idle");
  await tenantA.conn.dispose();
  store.close();
});

test("session/schedule/run upserts cannot overwrite another tenant on id collision", () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-tenant-id-fence-"));
  const store = new PhononStore(join(root, "state.db"));
  const now = new Date().toISOString();
  store.upsertSession({ sessionId: "s-collision", tenantId: "tenant-a", projectId: "p", agent: "a", model: "m-a", status: "idle", verbosity: "messages", createdAt: now });
  store.upsertSession({ sessionId: "s-collision", tenantId: "tenant-b", projectId: "p", agent: "b", model: "m-b", status: "terminated", verbosity: "messages", createdAt: now });
  assert.equal(store.listAllSessions().find((row) => row.session_id === "s-collision")?.model, "m-a");
  store.upsertSchedule({ id: "sch-collision", tenantId: "tenant-a", name: "A", enabled: true, triggerJson: '{"kind":"manual"}', targetJson: '{}', consentJson: '{"push":"summary"}', createdAt: now, updatedAt: now });
  store.upsertSchedule({ id: "sch-collision", tenantId: "tenant-b", name: "B", enabled: false, triggerJson: '{"kind":"manual"}', targetJson: '{}', consentJson: '{"push":"full"}', createdAt: now, updatedAt: now });
  assert.equal(store.getSchedule("sch-collision")?.name, "A");
  store.upsertRun({ id: "run-collision", scheduleId: "sch-collision", tenantId: "tenant-a", triggerSource: "manual", status: "running", createdAt: now });
  store.upsertRun({ id: "run-collision", scheduleId: "sch-collision", tenantId: "tenant-b", triggerSource: "manual", status: "failed", createdAt: now });
  assert.equal(store.getRun("run-collision")?.status, "running");
  store.close();
});

test("schedule ACK is bounded, monotonic, and only finished=true acknowledges terminal push", () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-run-ack-"));
  const store = new PhononStore(join(root, "state.db"));
  const now = new Date().toISOString();
  store.upsertRun({
    id: "run-ack", scheduleId: "sch-ack", tenantId: "tenant-ack", triggerSource: "manual", status: "running",
    createdAt: now, pushState: "pending", ackedSeq: -1, eventSeq: 3,
    ownerId: "owner", ownerEpoch: 0, leaseUntil: Date.now() + 5_000,
  });
  assert.equal(store.ackRun("run-ack", "tenant-ack", { lastSeq: 999 }), true);
  let row = store.getRun("run-ack", "tenant-ack")!;
  assert.equal(row.acked_seq, 2);
  assert.equal(row.push_state, "pending");
  store.ackRun("run-ack", "tenant-ack", { lastSeq: 0 });
  assert.equal(store.getRun("run-ack", "tenant-ack")?.acked_seq, 2);
  store.ackRun("run-ack", "tenant-ack", { finished: true });
  row = store.getRun("run-ack", "tenant-ack")!;
  assert.equal(row.push_state, "acked");
  store.close();
});

test("released workflow owner cannot write a stale checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-wf-owner-fence-"));
  const store = new PhononStore(join(root, "state.db"));
  const base = {
    workflowId: "wf-owner-fence", tenantId: "tenant-fence", projectId: "project-fence",
    mode: "dag", planJson: JSON.stringify({ mode: "dag", nodes: [] }), policyJson: JSON.stringify({ onNodeFailure: "fail_workflow" }),
    status: "running", nodesJson: "[]", seq: 0, ackedSeq: -1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    checkpointJson: JSON.stringify({ controlEpoch: 0, persistentSessions: {}, autoWorktrees: {}, mainBranchCheckedOut: {} }),
    ownerId: "owner-a", ownerEpoch: 0, leaseUntil: Date.now() + 5_000,
  };
  store.upsertWorkflow(base);
  assert.equal(store.releaseWorkflow(base.workflowId, base.tenantId, "owner-a", 0), true);
  store.upsertWorkflow({ ...base, status: "failed", error: "stale owner write", updatedAt: new Date().toISOString() });
  assert.equal(store.getWorkflow(base.workflowId, base.tenantId)?.status, "running");
  const epoch = store.claimWorkflow(base.workflowId, base.tenantId, "owner-b", 5_000);
  assert.equal(typeof epoch, "number");
  store.upsertWorkflow({ ...base, status: "completed", ownerId: "owner-b", ownerEpoch: epoch, completedAt: new Date().toISOString(), sharedJson: JSON.stringify({ text: "resume feedback" }) });
  const completed = store.getWorkflow(base.workflowId, base.tenantId);
  assert.equal(completed?.status, "completed");
  assert.equal(JSON.parse(completed?.shared_json as string).text, "resume feedback");
  store.close();
});

test("Graph cursor recovery does not repeat a completed route and duplicate directives are idempotent", async () => {
  const fx = setup((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) return { text: [
      "```phonon.workflow.route", JSON.stringify({ to: "w", message: "worker-job" }), "```",
      "```phonon.workflow.route", JSON.stringify({ to: "w", message: "worker-job" }), "```",
    ].join("\n") };
    if (input.includes("Worker results from previous iteration")) return { text: [
      "```phonon.workflow.done", JSON.stringify({ finalSummary: "graph-done" }), "```",
    ].join("\n"), delay: 500 };
    return { text: "worker-result", delay: 10 };
  });
  const first = fx.conn();
  const projectId = await project(first, "graph-recovery");
  const run = await first.call("workflow.run", { project: projectId, plan: {
    mode: "graph", executor: { nodeId: "exec", agent: "controlled:exec", model: "m1" },
    workers: [{ nodeId: "w", agent: "controlled:w", model: "m1" }],
    communicationGraph: { edges: [{ from: "exec", to: "w" }], maxIterations: 2 },
  } }) as { workflowId: string };
  await waitFor(first, run.workflowId, (s) => s.nodes.find((n: any) => n.nodeId === "exec")?.attempts?.length >= 2);
  await first.conn.dispose("graph crash");
  const second = fx.conn();
  const done = await waitFor(second, run.workflowId, (s) => s.status === "completed");
  assert.equal(done.finalText, "graph-done");
  assert.equal(fx.control.calls.filter((x) => x === "worker-job").length, 1);

  await assert.rejects(() => second.call("workflow.run", { project: projectId, plan: {
    mode: "graph", executor: { nodeId: "e", agent: "controlled:exec", model: "m1" },
    workers: [{ nodeId: "w", agent: "controlled:w", model: "m1" }],
    communicationGraph: { edges: [{ from: "w", to: "e" }], maxIterations: 1 },
  } }));
  await second.conn.dispose();
  fx.store.close();
});

test("Discussion checkpoint enforces participant barrier/maxParallel and recovery does not repeat speeches", async () => {
  const fx = setup((input) => {
    if (input.includes("As the chairman")) return { text: "final [END]", delay: 400, chairman: true };
    return { text: "participant", delay: 60, participant: true };
  });
  const first = fx.conn();
  const projectId = await project(first, "discussion-recovery");
  const participants = ["p1", "p2", "p3", "p4"].map((nodeId) => ({ nodeId, agent: `controlled:${nodeId}`, model: "m1" }));
  const run = await first.call("workflow.run", { project: projectId, policy: { maxParallel: 2 }, plan: {
    mode: "discussion", topic: "topic", participants: [...participants, { nodeId: "chair", agent: "controlled:chair", model: "m1" }],
    chairman: "chair", termination: { chairmanSignal: "[END]", maxRounds: 2 },
  } }) as { workflowId: string };
  await waitFor(first, run.workflowId, (s) => s.nodes.find((n: any) => n.nodeId === "chair")?.status === "running");
  assert.equal(fx.control.chairmanSawCompleted, 4, "chairman must start only after all participants finished");
  await first.conn.dispose("discussion crash");
  const second = fx.conn();
  const done = await waitFor(second, run.workflowId, (s) => s.status === "completed");
  assert.match(done.finalText, /\[END\]/);
  assert.ok(fx.control.maxActiveParticipants <= 2, `participant concurrency was ${fx.control.maxActiveParticipants}`);
  for (const id of ["p1", "p2", "p3", "p4"]) {
    const node = done.nodes.find((n: any) => n.nodeId === id);
    assert.equal(node.attempts.length, 1, `${id} must not speak twice after recovery`);
  }
  await second.conn.dispose();
  fx.store.close();
});

test("Discussion checkpoints each completed speaker before its parallel batch finishes", async () => {
  const fx = setup((input, agentId) => {
    if (input.includes("As the chairman")) return { text: "final [END]", delay: 10, chairman: true };
    return { text: `speech:${agentId}`, delay: agentId === "controlled:p1" ? 10 : 500, participant: true };
  });
  const first = fx.conn();
  const projectId = await project(first, "discussion-speaker-checkpoint");
  const run = await first.call("workflow.run", { project: projectId, policy: { maxParallel: 2 }, plan: {
    mode: "discussion", topic: "topic",
    participants: [
      { nodeId: "p1", agent: "controlled:p1", model: "m1" },
      { nodeId: "p2", agent: "controlled:p2", model: "m1" },
      { nodeId: "chair", agent: "controlled:chair", model: "m1" },
    ],
    chairman: "chair", termination: { chairmanSignal: "[END]", maxRounds: 1 },
  } }) as { workflowId: string };
  await waitFor(first, run.workflowId, (s) =>
    s.nodes.find((n: any) => n.nodeId === "p1")?.status === "completed" &&
    s.nodes.find((n: any) => n.nodeId === "p2")?.status === "running");
  await first.conn.dispose("mid-batch crash");
  const second = fx.conn();
  const done = await waitFor(second, run.workflowId, (s) => s.status === "completed") as { nodes: any[] };
  assert.equal(done.nodes.find((n) => n.nodeId === "p1").attempts.length, 1);
  assert.equal(done.nodes.find((n) => n.nodeId === "p2").attempts.length, 2);
  await second.conn.dispose();
  fx.store.close();
});

test("cancelled workflow resume retains and reuses a dirty auto-worktree mapping", async () => {
  let calls = 0;
  const fx = setup((input) => {
    calls++;
    return calls === 1 ? { text: "dirty first", dirty: true, delay: 500 } : { text: `resumed:${input}`, delay: 10 };
  });
  const tc = fx.conn();
  const created = await tc.call("project.create", { name: "dirty-resume", git: true }) as { project: { projectId: string; path: string } };
  writeFileSync(join(created.project.path, "README.md"), "init\n");
  execSync(`git -C ${created.project.path} add . && git -C ${created.project.path} -c user.email=x@y -c user.name=x commit -m init`);
  const run = await tc.call("workflow.run", {
    project: created.project.projectId, worktreeId: "dirty-resume-key",
    plan: { mode: "dag", nodes: [{ nodeId: "a", agent: "controlled:a", model: "m1", input: "make-dirty" }] },
  }) as { workflowId: string };
  await waitFor(tc, run.workflowId, (status) => status.status === "running");
  const untilDirty = Date.now() + 2_000;
  while (Date.now() < untilDirty) {
    const row = fx.store.getWorkflow(run.workflowId, "tenant-recovery")!;
    const mappings = Object.values(JSON.parse(row.checkpoint_json as string).autoWorktrees) as Array<{ worktreeId: string }>;
    const worktree = mappings[0] && fx.store.loadWorktrees().find((item) => item.worktreeId === mappings[0]!.worktreeId);
    if (worktree && existsSync(join(worktree.path, "uncommitted.txt"))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await tc.call("workflow.cancel", { workflowId: run.workflowId });
  const checkpoint = fx.store.getWorkflow(run.workflowId, "tenant-recovery")!;
  assert.ok(Object.keys(JSON.parse(checkpoint.checkpoint_json as string).autoWorktrees).length > 0);
  await tc.call("workflow.resume", { workflowId: run.workflowId, strategy: "continue" });
  await waitFor(tc, run.workflowId, (status) => status.status === "completed");
  assert.equal(calls, 2);
  await tc.conn.dispose();
  fx.store.close();
});

test("automatic worktree cleanup preserves dirty worktrees", async () => {
  const fx = setup((input) => ({ text: "changed", dirty: input === "make-dirty" }));
  const tc = fx.conn();
  const created = await tc.call("project.create", { name: "dirty-worktree", git: true }) as { project: { projectId: string; path: string } };
  writeFileSync(join(created.project.path, "README.md"), "init\n");
  execSync(`git -C ${created.project.path} add . && git -C ${created.project.path} -c user.email=x@y -c user.name=x commit -m init`);
  const run = await tc.call("workflow.run", {
    project: created.project.projectId,
    worktreeId: "dirty-key",
    plan: { mode: "dag", nodes: [{ nodeId: "a", agent: "controlled:a", model: "m1", input: "make-dirty" }] },
  }) as { workflowId: string };
  await waitFor(tc, run.workflowId, (s) => s.status === "completed");
  const worktrees = execSync(`git -C ${created.project.path} worktree list --porcelain`).toString();
  assert.match(worktrees, /phonon-wf-/, "dirty workflow worktree must be retained");
  await tc.conn.dispose();
  fx.store.close();
});

test("periodic recovery claims a hard-crash checkpoint after stale owner lease expires", async () => {
  const fx = setup((input) => ({ text: `recovered:${input}` }));
  const bootstrap = fx.conn();
  const projectId = await project(bootstrap, "hard-crash-fixture");
  await bootstrap.conn.dispose();
  const now = new Date().toISOString();
  const workflowId = "wf-hard-crash-fixture";
  fx.store.upsertWorkflow({
    workflowId, tenantId: "tenant-recovery", projectId, mode: "dag",
    planJson: JSON.stringify({ mode: "dag", nodes: [{ nodeId: "a", agent: "controlled:a", model: "m1", input: "after-lease" }] }),
    policyJson: JSON.stringify({ onNodeFailure: "fail_workflow" }),
    status: "running", nodesJson: JSON.stringify([{ nodeId: "a", status: "running", agent: "controlled:a", model: "m1" }]),
    seq: 0, ackedSeq: -1, createdAt: now, updatedAt: now,
    checkpointJson: JSON.stringify({ controlEpoch: 0, persistentSessions: {}, autoWorktrees: {}, mainBranchCheckedOut: {} }),
    ownerId: "dead-process", ownerEpoch: 1, leaseUntil: Date.now() + 100,
  });
  const successor = fx.conn();
  const done = await waitFor(successor, workflowId, (s) => s.status === "completed", 4000);
  assert.match(done.nodes[0].result.text, /recovered:after-lease/);
  await successor.conn.dispose();
  fx.store.close();
});

test("D01: continue runs dependents after failed upstream without spinning", async () => {
  const fx = setup((input) => input === "fail-a" ? { text: "EXPECTED_FAILURE", failed: true } : { text: "DEPENDENT_OK" });
  const tc = fx.conn();
  try {
    const projectId = await project(tc, "continue-failure");
    const run = await tc.call("workflow.run", { project: projectId, policy: { onNodeFailure: "continue", maxParallel: 1, timeoutSeconds: 5 }, plan: { mode: "dag", nodes: [
      { nodeId: "a", agent: "controlled:a", model: "m1", input: "fail-a" },
      { nodeId: "b", agent: "controlled:b", model: "m1", input: "dependent", dependsOn: ["a"] },
    ] } }) as { workflowId: string };
    const done = await waitFor(tc, run.workflowId, (s) => s.status === "completed");
    assert.equal(done.nodes[0].status, "failed");
    assert.equal(done.nodes[1].status, "completed");
    assert.equal(fx.control.calls.filter((input) => input === "dependent").length, 1);
  } finally { await tc.conn.dispose(); fx.store.close(); }
});
