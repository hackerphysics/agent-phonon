import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

function makeConn(reply?: (input: string) => string): TestConn {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({ name: "mock", agentIds: ["mock:a", "mock:b", "mock:executor"], models: ["m1"], reply }));
  return new TestConn({ registry: reg, workspaceRoot: mkdtempSync(join(tmpdir(), "phonon-wf-")) });
}

async function waitWorkflow(tc: TestConn, workflowId: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await tc.call("workflow.status", { workflowId }) as Record<string, unknown>;
    if (["completed", "failed", "cancelled", "timeout"].includes(st.status as string)) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`workflow ${workflowId} did not terminate`);
}

test("workflow.run DAG: stream.event carries workflowId/nodeId; node.result populated; downstream sees upstream text", async () => {
  // reply 回显 input，便于下游断言 upstream 文本被注入
  const tc = makeConn((i) => `echo:${i}`);
  const project = await tc.call("project.create", { name: "wf" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "ROOT",
    plan: {
      mode: "dag",
      nodes: [
        { nodeId: "a", agent: "mock:a", model: "m1", input: "Ainput" },
        { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "Binput" },
      ],
      finalNodeId: "b",
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; status: string; sessionId?: string; result?: { text?: string; status: string } }>; finalText?: string };
  assert.equal(status.status, "completed");

  // P0-2: 每个 node 终态都带 result
  const a = status.nodes.find((n) => n.nodeId === "a")!;
  const b = status.nodes.find((n) => n.nodeId === "b")!;
  assert.equal(a.status, "completed");
  assert.equal(b.status, "completed");
  assert.equal(a.result?.status, "completed");
  assert.equal(a.result?.text, "echo:Ainput");
  // 下游 B 的 input 应该被注入了上游 A 的 result.text
  assert.match(b.result?.text ?? "", /echo:Binput[\s\S]*upstream node "a"[\s\S]*echo:Ainput/);
  // finalText = finalNodeId 节点的 result.text
  assert.equal(status.finalText, b.result?.text);

  // P0-1: stream.event 自带 workflowId / nodeId，不再有 node.stream 这种 workflow.event
  const wfEvents = tc.notifications.filter((e) => e.workflowId === run.workflowId);
  assert.equal(wfEvents.some((e) => e.type === "node.stream"), false, "node.stream should be removed; session 流走 stream.event");
  const aStreamEvents = tc.streamEvents.filter((e) => e.workflowId === run.workflowId && e.nodeId === "a");
  assert.ok(aStreamEvents.length > 0, "stream.event for node a should carry workflowId+nodeId");
  assert.ok(aStreamEvents.every((e) => e.workflowId === run.workflowId), "all decorated stream events should share workflowId");
  const bStreamEvents = tc.streamEvents.filter((e) => e.workflowId === run.workflowId && e.nodeId === "b");
  assert.ok(bStreamEvents.length > 0, "node b stream events also decorated");
  // workflow.event 仍含 workflow.status + node.status 元事件
  assert.ok(wfEvents.some((e) => e.type === "workflow.status" && e.status === "completed"));
  assert.ok(wfEvents.some((e) => e.type === "node.status" && e.nodeId === "a" && e.status === "completed"));
});

test("workflow.run DAG: onNodeFailure=skip_dependents skips downstream when upstream fails", async () => {
  // reply 让 nodeId 含 fail 的会失败
  const tc = makeConn((i) => {
    if (i.includes("FAIL")) throw new Error("intentional fail");
    return `ok:${i}`;
  });
  const project = await tc.call("project.create", { name: "wf-skip" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    plan: {
      mode: "dag",
      nodes: [
        { nodeId: "a", agent: "mock:a", model: "m1", input: "FAIL" },
        { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "b" },
      ],
    },
    policy: { onNodeFailure: "skip_dependents" },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; status: string }> };
  // skip_dependents 不让整个 workflow 失败，整体仍然 completed
  assert.equal(status.status, "completed");
  assert.equal(status.nodes.find((n) => n.nodeId === "a")?.status, "failed");
  assert.equal(status.nodes.find((n) => n.nodeId === "b")?.status, "skipped");
});

test("workflow.run graph: executor RoutingDirective drives worker; executor.decision + edge.route emitted", async () => {
  // executor 第一次发指令路由到 worker；第二次（带 worker 回复）声明 terminate
  let executorTurn = 0;
  const tc = makeConn((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      executorTurn++;
      return [
        "First decision:",
        "```phonon.workflow.route",
        JSON.stringify({ to: "worker", message: "do the review", reason: "needs review" }),
        "```",
      ].join("\n");
    }
    if (input.includes("Worker results from previous iteration")) {
      return [
        "Final decision:",
        "```phonon.workflow.route",
        JSON.stringify({ to: "worker", message: "noop", terminate: true }),
        "```",
        "Final answer text.",
      ].join("\n");
    }
    // worker
    return `worker output for: ${input}`;
  });
  const project = await tc.call("project.create", { name: "wf-graph" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "review this",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "worker", agent: "mock:a", model: "m1", role: "reviewer" }],
      communicationGraph: { edges: [{ from: "exec", to: "worker" }], maxIterations: 3 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; status: string }>; finalText?: string };
  assert.equal(status.status, "completed");
  // executor 至少被调用两次（初始 + followup）
  assert.ok(executorTurn >= 1);
  // 工作流事件含 executor.decision 和 edge.route
  const events = tc.notifications.filter((e) => e.workflowId === run.workflowId);
  assert.ok(events.some((e) => e.type === "executor.decision"), "executor.decision event missing");
  assert.ok(events.some((e) => e.type === "edge.route"), "edge.route event missing");
  // finalText 应该是最后一轮 executor 输出（含 Final answer text）
  assert.match(status.finalText ?? "", /Final answer text/);
});
