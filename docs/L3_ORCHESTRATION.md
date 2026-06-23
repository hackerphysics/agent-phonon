# L3 Orchestration Protocol

Status: **协议 v0.5 已收口（2026-06-23 Foreman 借鉴 review 后）**。3 种 plan mode（DAG/Graph/Discussion）+ 4-kind RoutingDirective + Checkpoint/Resume + SharedContext 全部就位。

agent-phonon L3 是建立在 L1 session 与 L2 tenant 隔离之上的**任务级多 agent 编排**。它不替代 `session.*`：每个 workflow node 实际上是一个普通 L1 session 的 wrapper，由 phonon 自动注入归属字段，让服务端可以从同一条 `stream.event` 流里区分出"哪个 workflow 的哪个 node 在输出"。

## 设计原则

1. **不重复发明 session**。Node 创建出来的 L1 session 的所有 `stream.event` 自动带上 `workflowId / nodeId / role` 字段，服务端按这些字段筛选；workflow.event **不重复承载** session 流，只发工作流级元事件（status / route / decision / round / discussion.terminated）。
2. **节点终态自带产物**。`WorkflowNodeRuntime.result: {text, status, usage}`，DAG 下游节点能拿到上游节点的 `result.text` 作为输入注入。
3. **可靠投递不另起一套**。`workflow.event` 由 `workflow.ack` 配套 ack 清理 outbox，与 `stream.ack` 平行。
4. **Executor 决策协议化**。Graph 模式靠 `RoutingDirective`（agent emit fenced block → phonon 解析 → 升级成内部动作）告诉 phonon 把下一条消息送给哪个 worker。**任何大模型都能用**，不依赖原生 function calling。
5. **执行策略是可选 + 默认安全**。timeout / perNodeTimeout / onNodeFailure / maxParallel 全部 optional，未传走全默认（onNodeFailure=fail_workflow）。
6. **底层通用 vs 上层业务解耦**。phonon 只提供通用底层能力（plan 执行、routing 解析、checkpoint、shared context 注入）；category/wisdom/agent 选型等业务由上层 server 自由实现。
7. **`role` 字段不被 phonon 解析**。它是调用方自由定义的角色名（executor/worker/reviewer/coder/chairman/...），phonon 仅在 stream.event 和 workflow.event 里回显，上层可以拿它做 category 映射 / system prompt 模板 / UI 标签等。

## Plan Modes

### 1. DAG execution

```ts
{
  mode: "dag",
  nodes: [
    { nodeId, agent, model, role?, input?, systemPrompt?, dependsOn?, agentConfig? }
  ],
  edges?: [{ from, to, condition?, label?, metadata? }],
  finalNodeId?: nodeId       // 哪个 node 的 result.text 作为 workflow.finalText
}
```

**语义**：
1. 无依赖的 node 进入 ready，并发上限受 `policy.maxParallel` 控制
2. Ready node 创建独立 L1 session
3. 节点终态 `completed | failed | skipped | cancelled`，含 `result: {text, status, usage}`
4. 下游 ready 时自动把所有上游 succeeded 节点的 `result.text` 注入到下游 input：
   ```
   <本节点 input>

   [upstream node "X" (role=...) result]
   <上游 text>
   ```
5. 失败传播策略：`fail_workflow`（默认）/ `skip_dependents` / `continue`
6. 全部到达终态 → workflow 进 `completed`（除非命中 timeout/cancel/fail）

### 2. Free graph execution with executor

```ts
{
  mode: "graph",
  executor: { nodeId, agent, model, role: "executor"(default), systemPrompt?, agentConfig? },
  workers: [{ nodeId, agent, model, role, ... }],
  communicationGraph: {
    edges: [{ from, to }],
    allowSelfLoop: false,
    maxIterations: 12
  }
}
```

**语义**：
1. phonon 启动 executor session，prompt 里告诉 executor：workers 列表、可达边、所有可用 directive 格式
2. Executor emit `RoutingDirective` fenced block（4 种之一，见下文）
3. phonon 解析 → 校验目标在 `communicationGraph.edges` 内 → 启 worker session 处理消息 → emit `executor.decision` + `edge.route` 事件
4. Worker 终态后，phonon 把 `worker.result.text` 喂回 executor 作为下一轮输入
5. Executor 决定继续路由或 emit `workflow.done` 终止
6. `maxIterations` 兜底防止无限 loop
7. `workflow.finalText` = `workflow.done.finalSummary`（如有）或最后一轮 executor 输出

每轮还会发 `round.started` / `round.completed` 事件，便于服务端追踪迭代进度。

### 3. Discussion mode (v0.5 新增)

> 借鉴 Foreman `_run_discuss_rounds`：N 个 agent 平等参与多轮讨论，没有主从，但有 chairman 控场。

```ts
{
  mode: "discussion",
  topic: string,                          // 初始主题
  participants: [
    { nodeId, agent, model, role?, ... }  // 至少 2 个；含 chairman 自己
  ],
  chairman: nodeId,                       // 必须是 participants 之一
  termination: {
    chairmanSignal: "[DISCUSS_END]",      // chairman 输出含此则终止
    maxRounds: 10,                        // 硬上限
    consensusSignal?: string              // 任一 participant 输出含此则终止（可选）
  }
}
```

**每轮语义**：
1. 阶段 A：所有非主席 participant **并行**发言（首轮收到 topic；后续轮收到 topic + 截短的历史 transcript）
2. 阶段 B：chairman 看本轮各方发言，summary + 决定是否继续
3. 终止判定：chairman 输出含 chairmanSignal → 终止；任一 participant 输出含 consensusSignal → 终止；否则继续到 maxRounds
4. `workflow.finalText` = 最后一轮 chairman 的发言

事件：
- `round.started` (payload: `{iteration, mode:"discussion", participants}`)
- `round.completed` (payload: `{iteration, speakers}`)
- `discussion.terminated` (payload: `{rounds, reason}`)

## RoutingDirective (v0.5 升级为 4-kind 判别联合)

Executor agent 在输出里 emit 一段 fenced block，phonon 解析后执行对应动作：

````markdown
```phonon.workflow.route
{"to":"workerNodeId","message":"...","reason":"...","metadata":{}}
```
````

兼容前缀：`phonon.workflow.<kind>` 或 `workflow.<kind>`。

4 种 directive：

| Kind | 字段 | 语义 |
|---|---|---|
| `workflow.route` | `to`, `message`, `reason?`, `metadata?` | 派新任务给 worker（可数组广播） |
| `workflow.feedback` | `to`, `message`, `reason?`, `metadata?` | 让 worker 基于上次输出**返工修订**（phonon 自动在 worker input 前加 `[FEEDBACK / REVISE]` 标记） |
| `workflow.reply` | `to`, `keystroke`, `reason?` | 模拟键盘输入（应答 agent 卡住的 `[Y/n]` 等提示） |
| `workflow.done` | `finalSummary?`, `reason?` | 显式宣告完成；`finalSummary` 作为 workflow.finalText |

非合法 JSON 块被忽略，下一块继续解析。

## Shared Context (v0.5 新增)

> 借鉴 Foreman SSOT 思路，但**不沿用 SSOT 这个名字**（Foreman 那个实现已被弃用）。

```ts
sharedContext?: {
  text?: string,                          // 直接文本
  files?: string[],                       // workspace 相对路径列表
  placement: "prepend" | "append"         // 注入到 systemPrompt 哪一头（默认 append）
}
```

phonon 在**每个 node** 的 `session.create` 时把 sharedContext 拼接到 systemPrompt：
- `text` 段落格式：`# Shared Workflow Context\n\n<text>`
- 每个 file 段落格式：`# Shared File: <relpath>\n\n\`\`\`\n<content>\n\`\`\``
- 文件路径受 workspace 沙箱保护（realpath 必须在 cwd 内），读不到的文件**静默跳过**不阻塞
- 与 node 自己的 `systemPrompt` 合并：`<node systemPrompt>\n\n<shared>` 或 `<shared>\n\n<node systemPrompt>`

适用场景：
- 全局编码规范、项目术语表
- API 文档摘要
- 给所有 node 看的"约束清单"

## Checkpoint + Resume (v0.5 新增)

每次 workflow 状态变化（status / node terminal / emit event）都会自动落 sqlite `workflows` 表。失败/取消/超时的 workflow 可通过 resumeFrom 恢复：

```ts
{
  // workflow.run 入参
  resumeFrom?: {
    workflowId: string,
    strategy: "failed_node"               // 默认：只重跑失败的 node
            | "last_success_dependents"   // 所有非 completed 都重跑
            | "node:<nodeId>",            // 从指定 node 开始
    rerunNodes?: nodeId[]                 // 显式指定要重跑的 node 列表
  }
}
```

返回：
```ts
{ workflowId, status, createdAt, resumed: true }
```

恢复后：
- 已 completed 的 node 不重做（session 不重建）
- 标记为 rerun 的 node 重置为 pending，重新走 DAG ready 检测/Graph executor 循环/Discussion 轮次
- 原 workflowId 沿用，原历史可在 status 里查到

`WorkflowStatusResult.resumable` 字段标识当前 workflow 是否可恢复（store 存在 + status ∈ failed/timeout/cancelled）。

## Methods

| 方法 | 方向 | 类型 | 一句话 |
|---|---|---|---|
| `workflow.run` | server→phonon | request | 提交 DAG/Graph/Discussion plan，或 resumeFrom |
| `workflow.status` | server→phonon | request | 查询 workflow + nodes 状态 |
| `workflow.cancel` | server→phonon | request | 取消运行中的 workflow |
| `workflow.list` | server→phonon | request | 列 workflow（按 status/projectId/时间窗筛） |
| `workflow.event` | phonon→server | notify | 工作流级元事件流 |
| `workflow.ack` | server→phonon | notify | 确认收到 workflow.event seq≤N（SDK 自动 ack） |

### `workflow.run` 完整入参

```ts
{
  project: ProjectId,
  worktreeId?: string,
  plan: WorkflowDagPlan | WorkflowGraphPlan | WorkflowDiscussionPlan,
  input?: string,
  policy?: {
    timeoutSeconds?, perNodeTimeoutSeconds?,
    onNodeFailure?: "fail_workflow" | "skip_dependents" | "continue",  // 默认 fail_workflow
    maxParallel?
  },
  sharedContext?: { text?, files?, placement: "prepend"|"append" },
  resumeFrom?: { workflowId, strategy, rerunNodes? },
  clientRequestId?: string,                  // 幂等键
  metadata?: object
}
→ { workflowId, status, createdAt, resumed: boolean }
```

## 事件类型一览

`workflow.event` 共 7 种 type：

| type | 触发时机 | 关键 payload |
|---|---|---|
| `workflow.status` | 整体状态变化 | `{reason?, error?, finalText?, resumed?}` |
| `node.status` | 单 node 状态变化 | 终态时含 `result` 字段 |
| `edge.route` | executor 实际触发某条边 | `{from, to, kind, iteration}` |
| `executor.decision` | executor emit RoutingDirective 后 | `{kind, to, reason, iteration}` |
| `round.started` | Graph 一轮 / Discussion 一轮 开始 | `{iteration, mode, participants?}` |
| `round.completed` | 一轮所有 worker/participant 完成 | `{iteration, workerCount/speakers}` |
| `discussion.terminated` | Discussion 终止 | `{rounds, reason}` |

每个事件都带 `workflowId / seq / timestamp`，可选 `nodeId / sessionId / turnId / agent / model / role / status / result`。

## Session 流的归属字段

L1 session 由 workflow node 创建时，phonon 给该 session 的**所有** `stream.event`（含 unsolicited）自动添加：

```ts
{
  ...原 stream event,
  workflowId,
  nodeId,
  role?     // 调用方定义的角色（如 "chairman" / "reviewer" / "executor"）
}
```

服务端处理示例：

```ts
device.on("streamEvent", (ev) => {
  if (ev.workflowId) {
    renderInWorkflowTimeline(ev.workflowId, ev.nodeId, ev.role, ev);
  } else {
    renderInSessionView(ev.sessionId, ev);
  }
});

device.on("workflowEvent", (ev) => {
  renderWorkflowMeta(ev.workflowId, ev);
});
```

## SDK 用法

### TypeScript

```ts
const device = await server.attach("device-id");

// DAG
const run = await device.workflow.run({
  project,
  plan: { mode: "dag", nodes: [...] },
  policy: { onNodeFailure: "skip_dependents", maxParallel: 3 },
  sharedContext: { text: "Coding style: ...", placement: "append" },
});

// Discussion
const discuss = await device.workflow.run({
  project,
  plan: {
    mode: "discussion",
    topic: "Pick a database",
    participants: [
      { nodeId: "alice", agent: "claude-code:default", model: "...", role: "supporter" },
      { nodeId: "bob",   agent: "openclaw:main",       model: "...", role: "skeptic" },
      { nodeId: "chair", agent: "claude-code:default", model: "...", role: "chairman" },
    ],
    chairman: "chair",
    termination: { chairmanSignal: "[DISCUSS_END]", maxRounds: 6 },
  },
});

// Resume
const resumed = await device.workflow.run({
  project,
  plan: {} as any,  // resumeFrom 路径忽略 plan
  resumeFrom: { workflowId: failedWfId, strategy: "failed_node" },
});
console.log(resumed.resumed); // true

device.on("workflowEvent", (ev) => {
  if (ev.type === "discussion.terminated") {
    console.log("discussion ended:", ev.payload?.reason);
  }
});

device.on("streamEvent", (ev) => {
  if (ev.workflowId === run.workflowId) {
    // 该 workflow 的节点输出
  }
});
```

### Python

```python
device = await server.attach("device-id")

run = await device.workflow_run(
    project=project_id,
    plan={"mode": "discussion", "topic": "...", "participants": [...], "chairman": "chair"},
)

def on_workflow(ev):
    if ev["type"] == "round.started":
        print(f"round {ev['payload']['iteration']} started")
    elif ev["type"] == "discussion.terminated":
        print(f"discussion ended: {ev['payload']['reason']}")

device.set_workflow_event_handler(on_workflow)

status = await device.workflow_status(run["workflowId"])
print(status.get("finalText"))
```

## 已知边界 / 后续

- **persistence**：workflow 状态已落 sqlite（v0.5），重启可 resume。但**正在运行**的 workflow 进程崩溃恢复仍需手动 resume；自动恢复需要 daemon 启动钩子（留下一阶段）
- **N1 N2 BACKLOG**：cross-device workflow（多 phonon 联动）、定时/周期 workflow，协议无需大改
- **审计**：`audit_logs` 沉淀仍在 BACKLOG
