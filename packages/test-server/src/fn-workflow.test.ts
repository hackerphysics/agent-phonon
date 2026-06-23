import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

function makeConn(): TestConn {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:a", "mock:b", "mock:executor"], models: ["m1"] }));
  return new TestConn({ registry: reg, workspaceRoot: mkdtempSync(join(tmpdir(), "phonon-wf-")) });
}

test("workflow.run DAG executes nodes and emits per-node workflow events", async () => {
  const tc = makeConn();
  const project = await tc.call("project.create", { name: "wf" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "root input",
    plan: {
      mode: "dag",
      nodes: [
        { nodeId: "a", agent: "mock:a", model: "m1", input: "A" },
        { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "B" },
      ],
    },
  }) as { workflowId: string };

  for (let i = 0; i < 40; i++) {
    const st = await tc.call("workflow.status", { workflowId: run.workflowId }) as { status: string };
    if (st.status === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const status = await tc.call("workflow.status", { workflowId: run.workflowId }) as { status: string; nodes: Array<{ nodeId: string; status: string; sessionId?: string }> };
  assert.equal(status.status, "completed");
  assert.deepEqual(status.nodes.map((n) => [n.nodeId, n.status]), [["a", "completed"], ["b", "completed"]]);
  assert.ok(status.nodes.every((n) => n.sessionId));
  const wfEvents = tc.notifications.filter((e) => e.workflowId === run.workflowId);
  assert.ok(wfEvents.some((e) => e.type === "workflow.status" && e.status === "completed"));
  assert.ok(wfEvents.some((e) => e.type === "node.stream" && e.nodeId === "a" && e.sessionId));
  assert.ok(wfEvents.some((e) => e.type === "node.stream" && e.nodeId === "b" && e.sessionId));
});

test("workflow.run graph starts executor node and records executor decision", async () => {
  const tc = makeConn();
  const project = await tc.call("project.create", { name: "wf-graph" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "review this",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "worker", agent: "mock:a", model: "m1", role: "reviewer" }],
      communicationGraph: { edges: [{ from: "exec", to: "worker" }], maxIterations: 2 },
    },
  }) as { workflowId: string };
  for (let i = 0; i < 40; i++) {
    const st = await tc.call("workflow.status", { workflowId: run.workflowId }) as { status: string };
    if (st.status === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const status = await tc.call("workflow.status", { workflowId: run.workflowId }) as { status: string; nodes: Array<{ nodeId: string; status: string }> };
  assert.equal(status.status, "completed");
  assert.equal(status.nodes.find((n) => n.nodeId === "exec")?.status, "completed");
  assert.ok(tc.notifications.some((e) => e.workflowId === run.workflowId && e.type === "executor.decision"));
});
