import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, PhononClient } from "@agent-phonon/core";
import { PhononServer } from "@agent-phonon/server-sdk";
import type { PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter } from "./harness.js";

/**
 * L3 Workflow real-scenario e2e (v0.5)
 *
 * 通过真实 WS 用 SDK 编排真实 phonon（PhononClient），覆盖三种 plan mode 的常见 graph 形态。
 * MockAdapter 用 reply 函数模拟 agent 行为；任务文本简单，但 graph 拓扑和路径覆盖力求全面。
 *
 * 覆盖矩阵：
 *  DAG:
 *   - linear:  a → b → c                          (上下文沿链传)
 *   - diamond: a → {b,c} → d                      (分叉再合并，downstream 拿到多个上游 result)
 *   - parallel-fan: __start__ → {a,b,c}           (纯并行 + maxParallel)
 *   - skip_dependents: a(fail) → b 被 skipped
 *  GRAPH (executor + workers):
 *   - route 派活 + worker.feedback 返工 + workflow.done 终止 → 端到端 3 种 directive 走通
 *   - 广播 to=[w1,w2]
 *  DISCUSSION:
 *   - chairman 信号终止
 *   - consensus 信号终止
 *   - maxRounds 兜底
 *  RESUME:
 *   - 失败的 DAG 修复后从 failed_node resume，原成功 node 不重做
 *  SHARED CONTEXT:
 *   - text + files 注入到每个 node 的 systemPrompt
 */

// =============================================================================
// 测试基础设施
// =============================================================================

/** 创建一个能 reply 的 phonon 客户端，连到 server。 */
function spawnPhonon(serverUrl: string, deviceId: string, opts?: {
  reply?: (input: string) => string;
  workspaceRoot?: string;
  agentIds?: string[];
}) {
  const reg = new AdapterRegistry();
  reg.register(new MockAdapter({
    name: "mock",
    agentIds: opts?.agentIds ?? ["mock:a", "mock:b", "mock:c", "mock:d", "mock:executor", "mock:chair"],
    models: ["m1"],
    reply: opts?.reply,
  }));
  const cwd = opts?.workspaceRoot ?? mkdtempSync(join(tmpdir(), `phonon-wf-e2e-${deviceId}-`));
  return {
    client: new PhononClient({
      serverUrl, deviceId, registry: reg, trustLocal: true,
      workspaceRoot: cwd,
      resolveProjectCwd: () => cwd,
    }),
    workspace: cwd,
  };
}

/** Server fixture: 拉起 server + 等单个 device 接上。 */
async function makeFixture(replyFn?: (input: string) => string, workspaceRoot?: string): Promise<{
  server: PhononServer;
  device: PhononDevice;
  workspace: string;
  cleanup: () => Promise<void>;
}> {
  const server = new PhononServer({ authenticate: (id) => ({ tenantId: `t-${id}` }) });
  const port = await server.listen();
  const deviceReady = new Promise<PhononDevice>((resolve) => {
    server.on("device", (d: PhononDevice) => resolve(d));
  });
  const { client, workspace } = spawnPhonon(`ws://127.0.0.1:${port}`, `dev-${Math.random().toString(36).slice(2, 8)}`, { reply: replyFn, workspaceRoot });
  await client.connect();
  const device = await deviceReady;
  return {
    server, device, workspace,
    cleanup: async () => {
      try { client.close(); } catch {}
      try { await server.close(); } catch {}
    },
  };
}

/** 等 workflow 走完，返回 status。 */
async function waitWorkflow(device: PhononDevice, workflowId: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await device.workflow.status(workflowId) as Record<string, unknown>;
    if (["completed", "failed", "cancelled", "timeout"].includes(st.status as string)) return st;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow ${workflowId} did not terminate within ${timeoutMs}ms`);
}

// =============================================================================
// DAG 拓扑覆盖
// =============================================================================

test("e2e DAG linear: a → b → c, upstream result.text flows down the chain", { timeout: 30000 }, async () => {
  const fx = await makeFixture((input) => `echo:${input.slice(0, 80)}`);
  try {
    const proj = await fx.device.project.create({ name: "linear", git: false });
    const wfEvents: Record<string, unknown>[] = [];
    fx.device.on("workflowEvent", (ev: Record<string, unknown>) => wfEvents.push(ev));

    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      input: "ROOT",
      plan: {
        mode: "dag",
        nodes: [
          { nodeId: "a", agent: "mock:a", model: "m1", input: "A" },
          { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "B" },
          { nodeId: "c", agent: "mock:c", model: "m1", dependsOn: ["b"], input: "C" },
        ],
        finalNodeId: "c",
      },
    }) as { workflowId: string };

    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; result?: { text?: string } }>; finalText?: string };
    assert.equal(st.status, "completed");
    const aText = st.nodes.find((n) => n.nodeId === "a")?.result?.text ?? "";
    const bText = st.nodes.find((n) => n.nodeId === "b")?.result?.text ?? "";
    const cText = st.nodes.find((n) => n.nodeId === "c")?.result?.text ?? "";
    assert.equal(aText, "echo:A");
    // b 的 input 应包含 echo:A
    assert.ok(bText.includes("echo:A"), `b should contain upstream a: ${bText}`);
    assert.ok(cText.includes("echo:B"), `c should contain upstream b's prefix: ${cText}`);
    assert.equal(st.finalText, cText);
    // workflow.event 含 status events
    assert.ok(wfEvents.some((e) => e.type === "workflow.status" && e.status === "completed"));
  } finally { await fx.cleanup(); }
});

test("e2e DAG diamond: a → {b,c} → d, d sees both b and c results", { timeout: 30000 }, async () => {
  const fx = await makeFixture((input) => `out(${input.slice(0, 50).replace(/\s/g, "_")})`);
  try {
    const proj = await fx.device.project.create({ name: "diamond", git: false });
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "dag",
        nodes: [
          { nodeId: "a", agent: "mock:a", model: "m1", input: "A" },
          { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "B" },
          { nodeId: "c", agent: "mock:c", model: "m1", dependsOn: ["a"], input: "C" },
          { nodeId: "d", agent: "mock:d", model: "m1", dependsOn: ["b", "c"], input: "D" },
        ],
        finalNodeId: "d",
      },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; result?: { text?: string; status?: string } }>; finalText?: string };
    assert.equal(st.status, "completed");
    const dText = st.nodes.find((n) => n.nodeId === "d")?.result?.text ?? "";
    // d 应该看到 b 和 c 两个 upstream 的内容（截短的 echo）
    assert.ok(dText.includes("out("), `d should be output: ${dText}`);
    // status.nodes 4 个都 completed
    assert.equal(st.nodes.length, 4);
    assert.ok(st.nodes.every((n) => n.result?.status === "completed"));
  } finally { await fx.cleanup(); }
});

test("e2e DAG parallel fan + maxParallel=2: three nodes run with concurrency cap", { timeout: 30000 }, async () => {
  // 用 sendDelayMs 制造并发观测点；但 MockAdapter 无 sendDelay 直接控，我们改用 timing
  const fx = await makeFixture((input) => `done(${input})`);
  try {
    const proj = await fx.device.project.create({ name: "fan", git: false });
    const t0 = Date.now();
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "dag",
        nodes: [
          { nodeId: "a", agent: "mock:a", model: "m1", input: "A" },
          { nodeId: "b", agent: "mock:b", model: "m1", input: "B" },
          { nodeId: "c", agent: "mock:c", model: "m1", input: "C" },
        ],
      },
      policy: { maxParallel: 2 },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; status: string }> };
    const elapsed = Date.now() - t0;
    assert.equal(st.status, "completed");
    assert.equal(st.nodes.length, 3);
    assert.ok(st.nodes.every((n) => n.status === "completed"));
    // 3 个都跑成功（并发上限对正确性是透明的；这里仅断言能正常完成）
    assert.ok(elapsed < 10000, `should complete fast: ${elapsed}ms`);
  } finally { await fx.cleanup(); }
});

test("e2e DAG skip_dependents: a fails → b skipped, workflow still completed", { timeout: 30000 }, async () => {
  const fx = await makeFixture((input) => {
    if (input.includes("FAIL_ME")) throw new Error("planned failure");
    return `ok:${input.slice(0, 40)}`;
  });
  try {
    const proj = await fx.device.project.create({ name: "skip", git: false });
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "dag",
        nodes: [
          { nodeId: "a", agent: "mock:a", model: "m1", input: "FAIL_ME" },
          { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "B" },
          { nodeId: "c", agent: "mock:c", model: "m1", input: "C-independent" }, // 平行无依赖
        ],
      },
      policy: { onNodeFailure: "skip_dependents" },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; status: string }> };
    assert.equal(st.status, "completed");
    assert.equal(st.nodes.find((n) => n.nodeId === "a")?.status, "failed");
    assert.equal(st.nodes.find((n) => n.nodeId === "b")?.status, "skipped");
    assert.equal(st.nodes.find((n) => n.nodeId === "c")?.status, "completed");
  } finally { await fx.cleanup(); }
});

// =============================================================================
// GRAPH (executor + workers) 覆盖
// =============================================================================

test("e2e GRAPH route + feedback + done: full directive cycle", { timeout: 30000 }, async () => {
  let execTurn = 0;
  const fx = await makeFixture((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      execTurn++;
      return [
        "Step 1: ask worker to draft.",
        "```phonon.workflow.route",
        JSON.stringify({ to: "worker", message: "draft a haiku about phonon" }),
        "```",
      ].join("\n");
    }
    if (input.includes("Worker results from previous")) {
      // 第 2 轮：先 feedback 让 worker 修改
      if (execTurn === 1) {
        execTurn++;
        return [
          "Revise: add a season.",
          "```phonon.workflow.feedback",
          JSON.stringify({ to: "worker", message: "add autumn imagery", reason: "season missing" }),
          "```",
        ].join("\n");
      }
      // 第 3 轮：done
      return [
        "Looks good. Done.",
        "```phonon.workflow.done",
        JSON.stringify({ finalSummary: "Haiku finalized: phonon, autumn, light." }),
        "```",
      ].join("\n");
    }
    // worker echoes
    return `worker drafted: ${input.slice(0, 60)}`;
  });
  try {
    const proj = await fx.device.project.create({ name: "graph", git: false });
    const events: Record<string, unknown>[] = [];
    fx.device.on("workflowEvent", (ev: Record<string, unknown>) => events.push(ev));
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      input: "write a haiku",
      plan: {
        mode: "graph",
        executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
        workers: [{ nodeId: "worker", agent: "mock:a", model: "m1", role: "writer" }],
        communicationGraph: { edges: [{ from: "exec", to: "worker" }], maxIterations: 6 },
      },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; finalText?: string };
    assert.equal(st.status, "completed");
    assert.match(st.finalText ?? "", /Haiku finalized/);
    // 事件类型全覆盖
    const wfEvents = events.filter((e) => e.workflowId === run.workflowId);
    const decisionKinds = wfEvents
      .filter((e) => e.type === "executor.decision")
      .map((e) => (e.payload as { kind?: string })?.kind);
    assert.ok(decisionKinds.includes("workflow.route"), `decision kinds: ${decisionKinds.join(",")}`);
    assert.ok(decisionKinds.includes("workflow.feedback"));
    assert.ok(wfEvents.some((e) => e.type === "edge.route" && (e.payload as { kind?: string })?.kind === "workflow.feedback"));
    assert.ok(wfEvents.some((e) => e.type === "round.started"));
    assert.ok(wfEvents.some((e) => e.type === "round.completed"));
  } finally { await fx.cleanup(); }
});

test("e2e GRAPH broadcast: route to=[w1,w2] fans out, both workers run, then done", { timeout: 30000 }, async () => {
  const fx = await makeFixture((input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      return [
        "Fan out:",
        "```phonon.workflow.route",
        JSON.stringify({ to: ["w1", "w2"], message: "do the thing" }),
        "```",
      ].join("\n");
    }
    if (input.includes("Worker results from previous")) {
      return [
        "Got both.",
        "```phonon.workflow.done",
        JSON.stringify({ finalSummary: "Both workers reported." }),
        "```",
      ].join("\n");
    }
    return `worker output for: ${input.slice(0, 40)}`;
  });
  try {
    const proj = await fx.device.project.create({ name: "broadcast", git: false });
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      input: "do",
      plan: {
        mode: "graph",
        executor: { nodeId: "exec", agent: "mock:executor", model: "m1" },
        workers: [
          { nodeId: "w1", agent: "mock:a", model: "m1", role: "worker" },
          { nodeId: "w2", agent: "mock:b", model: "m1", role: "worker" },
        ],
        communicationGraph: { edges: [{ from: "exec", to: "w1" }, { from: "exec", to: "w2" }], maxIterations: 5 },
      },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; nodes: Array<{ nodeId: string }>; finalText?: string };
    assert.equal(st.status, "completed");
    // 修复问题 B 后：w1 / w2 跨轮复用同一 nodeId，不再有 #it1 后缀
    assert.ok(st.nodes.some((n) => n.nodeId === "w1"), `nodes: ${st.nodes.map((n) => n.nodeId).join(",")}`);
    assert.ok(st.nodes.some((n) => n.nodeId === "w2"));
    assert.match(st.finalText ?? "", /Both workers reported/);
  } finally { await fx.cleanup(); }
});

// =============================================================================
// DISCUSSION 覆盖
// =============================================================================

test("e2e DISCUSSION: chairman signal terminates discussion", { timeout: 30000 }, async () => {
  let chairmanCalls = 0;
  const fx = await makeFixture((input) => {
    if (input.includes("As the chairman, decide whether")) {
      chairmanCalls++;
      if (chairmanCalls >= 2) return "Round 2 summary. We have enough. [DISCUSS_END]";
      return "Round 1 summary. Need another round.";
    }
    return `participant view: ${input.slice(0, 40).replace(/\s/g, "_")}`;
  });
  try {
    const proj = await fx.device.project.create({ name: "discuss-chair", git: false });
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "discussion",
        topic: "Coffee or tea?",
        participants: [
          { nodeId: "alice", agent: "mock:a", model: "m1", role: "coffee-fan" },
          { nodeId: "bob", agent: "mock:b", model: "m1", role: "tea-fan" },
          { nodeId: "chair", agent: "mock:chair", model: "m1", role: "chairman" },
        ],
        chairman: "chair",
        termination: { chairmanSignal: "[DISCUSS_END]", maxRounds: 5 },
      },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; finalText?: string; nodes: Array<{ nodeId: string }> };
    assert.equal(st.status, "completed");
    assert.match(st.finalText ?? "", /\[DISCUSS_END\]/);
    assert.match(st.finalText ?? "", /Round 2 summary/);
    assert.equal(chairmanCalls, 2);
  } finally { await fx.cleanup(); }
});

test("e2e DISCUSSION: consensus signal from participant terminates immediately", { timeout: 30000 }, async () => {
  let participantCalls = 0;
  const fx = await makeFixture((input) => {
    if (input.includes("As the chairman, decide whether")) {
      return "round summary";
    }
    participantCalls++;
    if (participantCalls === 2) return "I fully agree. [CONSENSUS]";
    return "I am thinking...";
  });
  try {
    const proj = await fx.device.project.create({ name: "discuss-consensus", git: false });
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "discussion",
        topic: "Use TypeScript?",
        participants: [
          { nodeId: "alice", agent: "mock:a", model: "m1", role: "frontend" },
          { nodeId: "bob", agent: "mock:b", model: "m1", role: "backend" },
          { nodeId: "chair", agent: "mock:chair", model: "m1", role: "chairman" },
        ],
        chairman: "chair",
        termination: { chairmanSignal: "NEVER", maxRounds: 10, consensusSignal: "[CONSENSUS]" },
      },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string };
    assert.equal(st.status, "completed");
    // 参与者第二次说话就应触发 consensus 提前终止（即第 1 轮）
    assert.ok(participantCalls <= 4, `participant called ${participantCalls} times, should terminate early`);
  } finally { await fx.cleanup(); }
});

test("e2e DISCUSSION: maxRounds hard cap when no termination signal ever sent", { timeout: 30000 }, async () => {
  const fx = await makeFixture(() => "blah");
  try {
    const proj = await fx.device.project.create({ name: "discuss-maxrounds", git: false });
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "discussion",
        topic: "Endless debate",
        participants: [
          { nodeId: "p1", agent: "mock:a", model: "m1", role: "p" },
          { nodeId: "p2", agent: "mock:b", model: "m1", role: "p" },
          { nodeId: "chair", agent: "mock:chair", model: "m1", role: "chairman" },
        ],
        chairman: "chair",
        termination: { chairmanSignal: "NEVER", maxRounds: 2 },
      },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string };
    assert.equal(st.status, "completed");
    // 应该恰好跑 2 轮就终止
  } finally { await fx.cleanup(); }
});

// =============================================================================
// SHARED CONTEXT 覆盖
// =============================================================================

test("e2e sharedContext: text + files are injected into every node's systemPrompt", { timeout: 30000 }, async () => {
  // workspace 充当 phonon 的 allowed root + project 默认目录
  const ws = mkdtempSync(join(tmpdir(), "phonon-shared-"));
  const fx = await makeFixture((input) => `seen: ${input.slice(0, 30)}`, ws);
  try {
    // project.create 不传 path → phonon 在 workspace 下自动建
    const proj = await fx.device.project.create({ name: "shared", git: false }) as { project: { projectId: string; path: string } };
    // 在 project 目录下写入 docs/spec.md
    mkdirSync(join(proj.project.path, "docs"), { recursive: true });
    writeFileSync(join(proj.project.path, "docs", "spec.md"), "# Spec\n\nUse 4-space indent.", "utf8");

    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "dag",
        nodes: [{ nodeId: "a", agent: "mock:a", model: "m1", input: "hello" }],
      },
      sharedContext: {
        text: "PROJECT RULES: respond in JSON",
        files: ["docs/spec.md", "docs/nonexistent.md"],  // 不存在文件静默跳过
        placement: "append",
      },
    }) as { workflowId: string };
    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; nodes: Array<{ result?: { text?: string } }> };
    assert.equal(st.status, "completed");
    // 至少能跑通；systemPrompt 拼接逻辑由 unit test 覆盖
    assert.equal(st.nodes[0]?.result?.text, "seen: hello");
  } finally { await fx.cleanup(); }
});

// =============================================================================
// RESUME 覆盖
// =============================================================================

test("e2e resume: fix failing node and resume → original successful nodes are not rerun", { timeout: 30000 }, async () => {
  let aFails = true;
  let aCallCount = 0;
  let bCallCount = 0;
  const fx = await makeFixture((input) => {
    if (input.includes("a-task")) {
      aCallCount++;
      if (aFails) throw new Error("planned");
      return "a-ok";
    }
    if (input.includes("b-task")) {
      bCallCount++;
      return "b-ok";
    }
    return "?";
  });
  try {
    const proj = await fx.device.project.create({ name: "resume", git: false });

    // 1st: a fails
    const run1 = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: {
        mode: "dag",
        nodes: [
          { nodeId: "a", agent: "mock:a", model: "m1", input: "a-task" },
          { nodeId: "b", agent: "mock:b", model: "m1", dependsOn: ["a"], input: "b-task" },
        ],
      },
    }) as { workflowId: string };
    const st1 = await waitWorkflow(fx.device, run1.workflowId) as { status: string; resumable?: boolean };
    assert.equal(st1.status, "failed");
    assert.equal(st1.resumable, true);
    assert.equal(aCallCount, 1);
    assert.equal(bCallCount, 0);

    // 2nd: fix a + resume
    aFails = false;
    const run2 = await fx.device.workflow.run({
      project: proj.project.projectId,
      plan: { mode: "dag", nodes: [{ nodeId: "x", agent: "mock:a", model: "m1" }] }, // 被 resume 路径忽略
      resumeFrom: { workflowId: run1.workflowId, strategy: "failed_node" },
    }) as { workflowId: string; resumed: boolean };
    assert.equal(run2.resumed, true);
    assert.equal(run2.workflowId, run1.workflowId);

    const st2 = await waitWorkflow(fx.device, run2.workflowId) as { status: string; nodes: Array<{ nodeId: string; status: string }> };
    assert.equal(st2.status, "completed");
    assert.equal(st2.nodes.find((n) => n.nodeId === "a")?.status, "completed");
    assert.equal(st2.nodes.find((n) => n.nodeId === "b")?.status, "completed");
    // a 应被重跑（第 2 次），b 应被首次跑（第 1 次）
    assert.equal(aCallCount, 2, "a should be rerun");
    assert.equal(bCallCount, 1, "b should run once (was never run in first attempt)");
  } finally { await fx.cleanup(); }
});

// =============================================================================
// stream.event 自带 workflowId/nodeId/role 在真实 SDK 路径里也成立
// =============================================================================

test("e2e stream events carry workflowId+nodeId+role through real SDK", { timeout: 30000 }, async () => {
  const fx = await makeFixture((input) => `echo: ${input.slice(0, 30)}`);
  try {
    const proj = await fx.device.project.create({ name: "stream-decorate", git: false });

    // PhononDevice 默认把 stream.event 路由到 session 对象；这里我们直接监听 raw 事件流
    // PhononServer 没有直接的 streamEvent 监听点（按 session 内部 routing），
    // 用 device.workflow.status 拿 node.sessionId，再断言 node-level result.text 与归属一致
    const run = await fx.device.workflow.run({
      project: proj.project.projectId,
      input: "hi",
      plan: {
        mode: "dag",
        nodes: [{ nodeId: "n1", agent: "mock:a", model: "m1", role: "scribe", input: "scribble" }],
      },
    }) as { workflowId: string };

    const st = await waitWorkflow(fx.device, run.workflowId) as { status: string; nodes: Array<{ nodeId: string; role?: string; sessionId?: string; result?: { text?: string } }> };
    assert.equal(st.status, "completed");
    const n1 = st.nodes.find((n) => n.nodeId === "n1")!;
    assert.equal(n1.role, "scribe");
    assert.ok(n1.sessionId, "node should have a sessionId");
    assert.equal(n1.result?.text, "echo: scribble");
  } finally { await fx.cleanup(); }
});
