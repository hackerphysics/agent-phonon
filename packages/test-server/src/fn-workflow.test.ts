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
  assert.match(a.result?.text ?? "", /echo:[\s\S]*# Target Workspace[\s\S]*Ainput/);
  // 下游 B 的 input 应该被注入了上游 A 的 result.text
  assert.match(b.result?.text ?? "", /echo:[\s\S]*Binput[\s\S]*upstream node "a"[\s\S]*echo:[\s\S]*Ainput/);
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
  assert.ok((a.result as { usage?: { durationMs?: number } })?.usage?.durationMs !== undefined, "node result should include runtime duration telemetry");

  const replay = await tc.call("workflow.events.list", { workflowId: run.workflowId, afterSeq: 0, limit: 20 }) as { events: Array<{ seq: number; type: string }> };
  assert.ok(replay.events.length > 0, "workflow.events.list should replay stored workflow events");
  assert.ok(replay.events.every((e) => e.seq > 0));

  const art = await tc.call("workflow.artifact.register", { workflowId: run.workflowId, nodeId: "b", kind: "report", path: "reports/final.md", title: "Final report" }) as { artifact: { artifactId: string; kind: string; path: string } };
  assert.equal(art.artifact.kind, "report");
  const artifacts = await tc.call("workflow.artifacts.list", { workflowId: run.workflowId }) as { artifacts: Array<{ artifactId: string; path: string }> };
  assert.equal(artifacts.artifacts.length, 1);
  assert.equal(artifacts.artifacts[0]!.path, "reports/final.md");
  assert.ok(tc.notifications.some((e) => e.workflowId === run.workflowId && e.type === "artifact.written"));
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
  // executor 第一轮发路由指令；第二轮拿到 worker 输出后 emit workflow.done 终止
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
        "```phonon.workflow.done",
        JSON.stringify({ finalSummary: "Final answer text.", reason: "review complete" }),
        "```",
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

// v0.5 features tests ========================================================

test("workflow.run graph: workflow.done directive ends loop with finalSummary", async () => {
  const tc = makeConn((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      return [
        "Wrapping up immediately.",
        "```phonon.workflow.done",
        JSON.stringify({ finalSummary: "All clear, nothing to do.", reason: "trivial input" }),
        "```",
      ].join("\n");
    }
    return `worker: ${input}`;
  });
  const project = await tc.call("project.create", { name: "wf-done" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "noop",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "worker", agent: "mock:a", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "worker" }], maxIterations: 5 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; finalText?: string };
  assert.equal(status.status, "completed");
  assert.equal(status.finalText, "All clear, nothing to do.");
});

test("workflow.run graph: workflow.feedback directive carries [FEEDBACK / REVISE] tag to worker", async () => {
  const tc = makeConn((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      return [
        "Send feedback to worker:",
        "```phonon.workflow.feedback",
        JSON.stringify({ to: "worker", message: "tighten the prose", reason: "too verbose" }),
        "```",
      ].join("\n");
    }
    if (input.includes("Worker results from previous")) {
      return [
        "Done.",
        "```phonon.workflow.done",
        JSON.stringify({ finalSummary: "Feedback delivered." }),
        "```",
      ].join("\n");
    }
    // worker echoes its input
    return `worker received: ${input}`;
  });
  const project = await tc.call("project.create", { name: "wf-feedback" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "go",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "worker", agent: "mock:a", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "worker" }], maxIterations: 3 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string };
  assert.equal(status.status, "completed");
  // worker node 收到的输入应被打上 FEEDBACK 标记
  const allNodes = (status as unknown as { nodes: Array<{ nodeId: string; result?: { text?: string } }> }).nodes;
  // 修复问题 B 后：worker 节点不再有 #it1 后缀，直接按名查找
  const workerNode = allNodes.find((n) => n.nodeId === "worker");
  assert.match(workerNode?.result?.text ?? "", /\[FEEDBACK \/ REVISE\][\s\S]*tighten the prose/);
  // edge.route 事件携带 kind=workflow.feedback
  const events = tc.notifications.filter((e) => e.workflowId === run.workflowId);
  assert.ok(events.some((e) => e.type === "edge.route" && (e.payload as { kind?: string })?.kind === "workflow.feedback"));
});

test("workflow.run discussion: chairman signal terminates after N rounds, finalText = last chairman", async () => {
  let chairmanRound = 0;
  const tc = makeConn((input) => {
    // chairman 调用的独特提示词包含 "As the chairman, decide whether"
    if (input.includes("As the chairman, decide whether")) {
      chairmanRound++;
      if (chairmanRound >= 2) return `Chairman summary R${chairmanRound}. [DISCUSS_END]`;
      return `Chairman summary R${chairmanRound}. Keep exploring.`;
    }
    // participant：基于输入回话
    return `participant view on: ${input.slice(0, 30)}`;
  });
  const project = await tc.call("project.create", { name: "wf-discuss" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    plan: {
      mode: "discussion",
      topic: "Should we adopt phonon?",
      participants: [
        { nodeId: "alice", agent: "mock:a", model: "m1", role: "supporter" },
        { nodeId: "bob", agent: "mock:b", model: "m1", role: "skeptic" },
        { nodeId: "chair", agent: "mock:executor", model: "m1", role: "chairman" },
      ],
      chairman: "chair",
      termination: { chairmanSignal: "[DISCUSS_END]", maxRounds: 5 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; finalText?: string; nodes: Array<unknown> };
  assert.equal(status.status, "completed");
  assert.match(status.finalText ?? "", /Chairman summary R2/);
  assert.match(status.finalText ?? "", /\[DISCUSS_END\]/);
  const events = tc.notifications.filter((e) => e.workflowId === run.workflowId);
  // round.started / round.completed / discussion.terminated 全有
  assert.ok(events.filter((e) => e.type === "round.started").length >= 2);
  assert.ok(events.some((e) => e.type === "round.completed"));
  assert.ok(events.some((e) => e.type === "discussion.terminated"));
});

test("workflow.run dag: sharedContext.text appended to every node's systemPrompt (via initialContext)", async () => {
  // MockSession 现在与真实 adapter 一致：把 initialContext（含 sharedContext.text + node systemPrompt）
  // 拼进首轮 input。reply 原样回显完整 input，可直接断言 sharedContext.text 被注入。
  const reply = (input: string) => `SEEN::${input}`;
  const tc = makeConn(reply);
  const project = await tc.call("project.create", { name: "wf-shared" }) as { project: { projectId: string; path: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    plan: {
      mode: "dag",
      nodes: [{ nodeId: "a", agent: "mock:a", model: "m1", input: "hello" }],
    },
    sharedContext: { text: "Common rules: be terse.", placement: "append" },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string };
  assert.equal(status.status, "completed");
  const node = (status as unknown as { nodes: Array<{ result?: { text?: string } }> }).nodes[0];
  const text = node?.result?.text ?? "";
  // sharedContext.text 必须到达 adapter input（这正是 initialContext 传递修复验证的核心）
  assert.match(text, /Common rules: be terse\./);
  // node 原始 input 也要在
  assert.match(text, /hello/);
});

test("workflow.run resumeFrom: resume failed workflow re-runs failed node only", async () => {
  // 第一次跑：a 失败 → workflow failed；checkpoint 落盘
  let aShouldFail = true;
  const tc = makeConn((input) => {
    if (input.includes("a-task") && aShouldFail) throw new Error("intentional");
    return `ok: ${input.slice(0, 30)}`;
  });
  const project = await tc.call("project.create", { name: "wf-resume" }) as { project: { projectId: string } };
  const run1 = await tc.call("workflow.run", {
    project: project.project.projectId,
    plan: {
      mode: "dag",
      nodes: [
        { nodeId: "a", agent: "mock:a", model: "m1", input: "a-task" },
        { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "b-task" },
      ],
    },
  }) as { workflowId: string };

  const status1 = await waitWorkflow(tc, run1.workflowId) as { status: string; resumable?: boolean };
  assert.equal(status1.status, "failed");
  assert.equal(status1.resumable, true);

  // 修复 → resume
  aShouldFail = false;
  const run2 = await tc.call("workflow.run", {
    project: project.project.projectId,
    plan: { mode: "dag", nodes: [{ nodeId: "x", agent: "mock:a", model: "m1" }] }, // plan 被 resume 路径忽略
    resumeFrom: { workflowId: run1.workflowId, strategy: "failed_node" },
  }) as { workflowId: string; resumed: boolean };
  assert.equal(run2.resumed, true);
  assert.equal(run2.workflowId, run1.workflowId);

  const status2 = await waitWorkflow(tc, run2.workflowId) as { status: string; nodes: Array<{ nodeId: string; status: string }> };
  assert.equal(status2.status, "completed");
  assert.equal(status2.nodes.find((n) => n.nodeId === "a")?.status, "completed");
  assert.equal(status2.nodes.find((n) => n.nodeId === "b")?.status, "completed");
});

// v0.7: workflow.human_review directive ========================================

test("workflow.run graph: workflow.human_review approved → done with feedback as finalText", async () => {
  const tc = makeConn((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      return [
        "Need human review:",
        "```phonon.workflow.human_review",
        JSON.stringify({ title: "Review my plan", summary: "Should we proceed?", artifacts: [{ path: "report.md", role: "report" }] }),
        "```",
      ].join("\n");
    }
    return "worker output";
  });
  // server 回 approved=true + feedback
  tc.setRequestResponder("interaction.request", () => ({ values: { approved: true, feedback: "Looks great, ship it.", reviewer: "alice" } }));

  const project = await tc.call("project.create", { name: "wf-hr-approve" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "do",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "w", agent: "mock:a", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "w" }], maxIterations: 3 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; finalText?: string };
  assert.equal(status.status, "completed");
  assert.equal(status.finalText, "Looks great, ship it.");
  const events = tc.notifications.filter((e) => e.workflowId === run.workflowId);
  assert.ok(events.some((e) => e.type === "human_review.requested"));
  const resolved = events.find((e) => e.type === "human_review.resolved");
  assert.ok(resolved);
  assert.equal((resolved!.payload as { approved?: boolean }).approved, true);
});

test("workflow.run graph: workflow.human_review rejected → feedback goes back to executor as next-iteration input", async () => {
  let sawRejectedFeedback = false;
  const tc = makeConn((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      return [
        "Need human review:",
        "```phonon.workflow.human_review",
        JSON.stringify({ title: "Plan review", summary: "Plan A" }),
        "```",
      ].join("\n");
    }
    if (input.includes("Worker results from previous iteration")) {
      const wasRejected = input.includes("[HUMAN REVIEW REJECTED]");
      if (wasRejected) {
        sawRejectedFeedback = true;
        return [
          "OK revised:",
          "```phonon.workflow.done",
          JSON.stringify({ finalSummary: "Revised based on reviewer feedback." }),
          "```",
        ].join("\n");
      }
    }
    return "worker output";
  });
  tc.setRequestResponder("interaction.request", () => ({ values: { approved: false, feedback: "Try plan B instead", reviewer: "bob" } }));

  const project = await tc.call("project.create", { name: "wf-hr-reject" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "do",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "w", agent: "mock:a", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "w" }], maxIterations: 5 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; finalText?: string };
  assert.equal(status.status, "completed");
  assert.match(status.finalText ?? "", /Revised based on reviewer feedback/);
  // executor 应该被调过至少 2 次（首轮 emit review + reject 后第二轮 emit done）
  assert.equal(sawRejectedFeedback, true, "executor should have received [HUMAN REVIEW REJECTED] feedback in followup turn");
});

// v0.7 review fix #3: 连续 rejected 撞 maxIterations → workflow failed with terminationReason=max_iterations
test("workflow.run graph: continuous human_review rejected reaches maxIterations → failed", async () => {
  let rejectCount = 0;
  const tc = makeConn((_input) => {
    // executor 每一轮都 emit human_review（永远不 done，模拟卡死场景）
    return [
      "Need human review again:",
      "```phonon.workflow.human_review",
      JSON.stringify({ title: "Plan review", summary: "Plan A" }),
      "```",
    ].join("\n");
  });
  tc.setRequestResponder("interaction.request", () => {
    rejectCount++;
    return { values: { approved: false, feedback: `reject #${rejectCount}: try again`, reviewer: "bob" } };
  });

  const project = await tc.call("project.create", { name: "wf-hr-reject-loop" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "do",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "w", agent: "mock:a", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "w" }], maxIterations: 3 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; error?: string };
  assert.equal(status.status, "failed");
  assert.match(status.error ?? "", /max_iterations|reached maxIterations=3/);
  // 每轮都 reject 一次，应该至少 ≥3 次（maxIterations=3）
  assert.ok(rejectCount >= 3, `expected at least 3 rejects, got ${rejectCount}`);
  const events = tc.notifications.filter((e) => e.workflowId === run.workflowId);
  const failedEv = events.find((e) => e.type === "workflow.status" && (e.payload as { error?: string })?.error?.includes?.("max_iterations"));
  assert.ok(failedEv, "should emit failed status with max_iterations terminationReason");
});

// v0.7 review fix #2: approved=true 但 reviewer 无 feedback → finalText 回退到 executor 最后一轮原文
test("workflow.run graph: human_review approved without feedback → finalText falls back to last executor output", async () => {
  const EXECUTOR_RAW_TEXT = "Plan A: build a foo, then a bar, then a baz. END.";
  const tc = makeConn((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      // executor 输出大段实质内容 + 一个 human_review directive
      return [
        EXECUTOR_RAW_TEXT,
        "",
        "```phonon.workflow.human_review",
        JSON.stringify({ title: "Approve my plan", summary: "Should we ship?" }),
        "```",
      ].join("\n");
    }
    return "worker output";
  });
  // reviewer 点同意，但 feedback 字段缺省
  tc.setRequestResponder("interaction.request", () => ({ values: { approved: true, reviewer: "alice" } }));

  const project = await tc.call("project.create", { name: "wf-hr-approve-no-feedback" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "do",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "w", agent: "mock:a", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "w" }], maxIterations: 3 },
    },
  }) as { workflowId: string };

  const status = await waitWorkflow(tc, run.workflowId) as { status: string; finalText?: string };
  assert.equal(status.status, "completed");
  // 关键：finalText 应该包含 executor 的实际产出，而不是 directive.summary（"Should we ship?"）
  assert.match(status.finalText ?? "", /Plan A: build a foo/);
  assert.doesNotMatch(status.finalText ?? "", /^Should we ship\?$/);
});

// v0.7 review fix #1: server 不回 interaction.request → engine 本地 timeout race 兜底
test("workflow.run graph: human_review interaction never responds → engine local timeout treats as rejected (then maxIterations)", async () => {
  const tc = makeConn((_input) => {
    // executor 每轮都 emit human_review，且 directive 把 timeoutSeconds 设得极小（1 秒）
    return [
      "Need quick review:",
      "```phonon.workflow.human_review",
      JSON.stringify({ title: "x", summary: "y", timeoutSeconds: 1 }),
      "```",
    ].join("\n");
  });
  // 故意不设 setRequestResponder → harness 默认走 { applied: true } 立即回
  // 但我们要模拟 "永不回" → 用一个永远 pending 的 responder
  tc.setRequestResponder("interaction.request", () => new Promise(() => { /* never resolves */ }));

  const project = await tc.call("project.create", { name: "wf-hr-timeout" }) as { project: { projectId: string } };
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "do",
    plan: {
      mode: "graph",
      executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
      workers: [{ nodeId: "w", agent: "mock:a", model: "m1", role: "worker" }],
      communicationGraph: { edges: [{ from: "exec", to: "w" }], maxIterations: 2 },
    },
  }) as { workflowId: string };

  // 每轮 timeout=1s+5s 兜底=6s；maxIterations=2 → 整体应 ~12s 内结束
  const status = await waitWorkflow(tc, run.workflowId, 30000) as { status: string; error?: string };
  // 超时后被当 rejected，executor 又 emit 同一 directive，最终撞 maxIterations
  assert.equal(status.status, "failed");
  assert.match(status.error ?? "", /max_iterations|reached maxIterations/);
  // 应该出现至少 2 次 human_review.resolved（每轮一次）且都带 "timed out locally" feedback
  const events = tc.notifications.filter((e) => e.workflowId === run.workflowId && e.type === "human_review.resolved");
  assert.ok(events.length >= 1, `expected ≥1 human_review.resolved events, got ${events.length}`);
  const hasTimeout = events.some((e) => /timed out locally/.test(((e.payload as { feedback?: string })?.feedback) ?? ""));
  assert.ok(hasTimeout, "at least one human_review.resolved should be marked as local timeout");
});

// 防回归（真实测试暴露的 bug）: workflow node 的 systemPrompt 必须经 initialContext 传到 adapter
// 背景: 6 个 spawn adapter 原本都在 createSession 丢弃了 initialContext，导致 workflow 给
// executor/worker 设的 systemPrompt 根本没传给模型。这里用 MockSession（现已与真实 adapter 一致
// 地消费 initialContext）验证 systemPrompt 真的到达了 node 的 input。
test("workflow: node systemPrompt is delivered to adapter via initialContext (dag)", async () => {
  // reply 原样回显 input，便于断言 systemPrompt 被拼进首轮
  const tc = makeConn((i) => `SEEN_INPUT::${i}`);
  const project = await tc.call("project.create", { name: "wf-sysprompt" }) as { project: { projectId: string } };
  const SENTINEL = "SYSPROMPT_SENTINEL_42 you must obey this role";
  const run = await tc.call("workflow.run", {
    project: project.project.projectId,
    input: "do the task",
    plan: {
      mode: "dag",
      nodes: [
        { nodeId: "a", agent: "mock:a", model: "m1", input: "node A input", systemPrompt: SENTINEL },
      ],
      finalNodeId: "a",
    },
  }) as { workflowId: string };
  const status = await waitWorkflow(tc, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; result?: { text?: string } }> };
  assert.equal(status.status, "completed");
  const nodeA = status.nodes.find((n) => n.nodeId === "a");
  // node 的 result.text 是 reply(effectiveInput)，而 effectiveInput 应该包含被拼进的 systemPrompt sentinel
  const resultText = nodeA?.result?.text ?? "";
  assert.ok(
    resultText.includes(SENTINEL),
    `node systemPrompt should reach adapter input; got: ${resultText.slice(0, 200)}`,
  );
  assert.match(resultText, /# Target Workspace/, "target workspace block should reach adapter input");
  assert.match(resultText, new RegExp(project.project.projectId), "target workspace should include project id");
});
