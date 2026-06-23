# L3 Orchestration Protocol

Status: **协议 v0.4 已收口（2026-06-23 review 后）**。L1 session 流上自带 workflowId/nodeId/role；workflow.event 只承载工作流级元事件；节点终态自带 result；DAG/Graph 双模 + RoutingDirective + 执行策略全部就位。

agent-phonon L3 是建立在 L1 session 与 L2 tenant 隔离之上的**任务级多 agent 编排**。它不替代 `session.*`：每个 workflow node 实际上是一个普通 L1 session 的 wrapper，由 phonon 自动注入归属字段，让服务端可以从同一条 `stream.event` 流里区分出"哪个 workflow 的哪个 node 在输出"。

## 设计原则（review 2026-06-23）

1. **不重复发明 session**。Node 创建出来的 L1 session 的所有 `stream.event` 自动带上 `workflowId / nodeId / role` 字段，服务端按这些字段筛选；workflow.event **不重复承载** session 流，只发工作流级元事件（status / route / decision）。
2. **节点终态自带产物**。`WorkflowNodeRuntime.result` 提供 `{text, status, usage}`，DAG 下游节点能拿到上游节点的 `result.text` 作为输入注入；executor 模式下决策也基于 worker 的 result 文本。
3. **可靠投递不另起一套**。`workflow.event` 由 `workflow.ack` 配套 ack 清理 outbox，与 `stream.ack` 平行，机制一致。
4. **Executor 决策协议化**。Graph 模式靠 `RoutingDirective`（agent emit fenced block → phonon 解析 → 升级成内部路由动作）告诉 phonon 把下一条消息送给哪个 worker。**任何大模型都能用**，不依赖原生 function calling（D22 原则）。
5. **执行策略是可选 + 默认安全**。timeout / perNodeTimeout / onNodeFailure / maxParallel 全部 optional，未传走全默认（onNodeFailure=fail_workflow）。

## Modes

### 1. DAG execution

`workflow.run` with `plan.mode = "dag"`。

```ts
{
  mode: "dag",
  nodes: [
    { nodeId, agent, model, role?, input?, dependsOn?, systemPrompt?, agentConfig? }
  ],
  edges?: [{ from, to }],   // optional 显式 edges；dependsOn 是紧凑形式
  finalNodeId?: "..."        // 哪个 node 的 result.text 作为 workflow.finalText
}
```

**语义**：
1. 无依赖的 node 进入 ready，并发上限受 policy.maxParallel 控制
2. Ready node 创建独立 L1 session 走 `session.send` 语义
3. 节点终态 `completed | failed | skipped | cancelled`，含 `result: {text, status, usage}`
4. 下游 ready 时，自动把所有上游 succeeded 节点的 `result.text` 注入到下游 input（拼接形式：`<本节点 input>\n\n[upstream node "X" (role=...) result]\n<上游 text>`）
5. 失败传播策略：
   - `fail_workflow`（默认）— 任一节点失败 → 整个 workflow 失败
   - `skip_dependents` — 失败节点的下游标 `skipped`，其他分支继续
   - `continue` — 失败节点不影响下游
6. 全部到达终态 → workflow 进 `completed`（除非命中 timeout/cancel/fail）

### 2. Free graph execution with executor

`workflow.run` with `plan.mode = "graph"`。

```ts
{
  mode: "graph",
  executor: { nodeId, agent, model, role: "executor"(default) },
  workers: [{ nodeId, agent, model, role }],
  communicationGraph: {
    edges: [{ from, to }],         // executor 能合法路由到的目标
    allowSelfLoop: false,
    maxIterations: 12
  }
}
```

**语义**：
1. phonon 启动 executor session，prompt 里告诉 executor：workers 列表、可达边、路由 directive 格式
2. Executor 在输出里 emit `RoutingDirective` fenced block：

   ````markdown
   ```phonon.workflow.route
   {"to":"<workerNodeId>","message":"...","reason":"...","terminate":false}
   ```
   ````

3. phonon 解析 directive，校验目标边是否在 `communicationGraph.edges` 内，校验通过则：
   - emit `executor.decision` 事件（带 from/to/reason/iteration）
   - emit `edge.route` 事件
   - 启动 worker session 处理消息
4. Worker session 终态后，把 worker.result.text 喂回 executor 作为下一轮输入
5. Executor 决定继续路由（emit 新 directive）或终止（`terminate: true`）
6. 最大迭代 `maxIterations` 兜底，防止无限 loop
7. `workflow.finalText` = 最后一轮 executor 的输出文本

支持 `to` 数组（广播）：`{"to":["worker1","worker2"],"message":"..."}`。

## Methods

### `workflow.run` (server→phonon, request)

```ts
{
  project, worktreeId?, plan,
  input?,            // workflow 级初始输入
  policy?: {
    timeoutSeconds?,         // 整 workflow 超时
    perNodeTimeoutSeconds?,  // 每 node 超时
    onNodeFailure?: "fail_workflow" | "skip_dependents" | "continue",
    maxParallel?             // DAG 并行上限
  },
  clientRequestId?,  // 幂等键
  metadata?
}
→ { workflowId, status, createdAt }
```

### `workflow.status` (server→phonon, request)

```ts
{ workflowId } → {
  workflowId, status, project, mode,
  nodes: [{ nodeId, status, agent, model, role, sessionId, turnId, result?: {text, status, usage}, ... }],
  createdAt, updatedAt, completedAt?, error?,
  finalText?         // DAG: finalNodeId 节点 result.text；Graph: executor 最终 text
}
```

### `workflow.cancel` (server→phonon, request)

取消并 terminate 所有未终态的 session（best-effort）。已终态的 workflow 幂等无副作用。

### `workflow.list` (server→phonon, request)

支持 `status / projectId / since / until / limit / cursor` 过滤。

### `workflow.event` (phonon→server, notification)

工作流级元事件流。事件类型（**已移除 `node.stream`**——session 流走 `stream.event`）：

- `workflow.status` — 工作流整体状态变化
- `node.status` — 节点状态变化（terminal 时带 `result`）
- `edge.route` — executor 实际触发某条边
- `executor.decision` — executor 给出路由决策（解析自 RoutingDirective）

每个事件结构：

```ts
{
  workflowId, seq,
  type,
  nodeId?, sessionId?, turnId?,
  agent?, model?, role?,
  status?,
  result?,           // node.status 终态时含
  payload?,
  timestamp
}
```

### `workflow.ack` (server→phonon, notification)

```ts
{ workflowId, lastSeq }
```

服务端确认已收 seq≤lastSeq；与 `stream.ack` 平行。**TS/Python SDK 在 `workflow.event` 入口自动 ack**，调用方一般无需手动调。

## Session 流的归属字段

L1 session 由 workflow node 创建时，phonon 给该 session 的**所有** `stream.event`（含 unsolicited）自动添加：

```ts
{
  ...原 stream event,
  workflowId,
  nodeId,
  role?
}
```

服务端处理逻辑示例：

```ts
device.on("streamEvent", (ev) => {
  if (ev.workflowId) {
    // workflow node 的输出 — 按 workflowId+nodeId 分类
    renderInWorkflowTimeline(ev.workflowId, ev.nodeId, ev);
  } else {
    // 普通独立 session 的输出
    renderInSessionView(ev.sessionId, ev);
  }
});

device.on("workflowEvent", (ev) => {
  // 仅工作流级元事件：status/decision/route
  renderWorkflowMeta(ev.workflowId, ev);
});
```

## RoutingDirective 解析规则

phonon 在 executor 的 `stream.event{type:"message"}` 累积文本里扫描如下 fenced block：

````markdown
```phonon.workflow.route
{"to":"...","message":"...","terminate":false}
```
````

兼容前缀：`phonon.workflow.route` 或 `workflow.route`。

字段：

```ts
{
  kind?: "workflow.route",  // 可省
  to: nodeId | nodeId[],
  message: string,
  reason?: string,
  terminate?: boolean,       // 默认 false；true 时本轮 executor 输出作为最终结果
  metadata?: any
}
```

非合法 JSON 的块被忽略，下一块继续。

## Capabilities

`AgentCapabilities.workflowRoles?: ("executor" | "worker")[]` 让 server 知道某个 agent 适合什么角色。当前 adapter 默认：

| Agent | workflowRoles |
|---|---|
| OpenClaw / Claude Code / Hermes / Gateway | executor + worker |
| Codex / OpenCode | worker（一次性，更适合执行单步） |

## SDK 用法

### TypeScript

```ts
const device = await server.attach("device-id");

const run = await device.workflow.run({
  project, plan: { mode: "dag", nodes: [...] },
  policy: { onNodeFailure: "skip_dependents", maxParallel: 3 }
});

device.on("workflowEvent", (ev) => {
  if (ev.type === "node.status" && ev.status === "completed") {
    console.log("node done", ev.nodeId, ev.result?.text);
  }
});

device.on("streamEvent", (ev) => {
  if (ev.workflowId === run.workflowId) {
    // workflow 节点的 session 输出
  }
});

// workflow.event 在 SDK 已自动 ack；手动 ack 可调 device.workflow.ack(workflowId, lastSeq)
const status = await device.workflow.status(run.workflowId);
console.log(status.finalText);
```

### Python

```python
device = await server.attach("device-id")

run = await device.workflow_run(
    project=project_id,
    plan={"mode": "dag", "nodes": [...]},
    policy={"onNodeFailure": "skip_dependents"},
)

def on_workflow(ev):
    if ev["type"] == "node.status" and ev.get("status") == "completed":
        print("node done", ev["nodeId"], ev.get("result", {}).get("text"))

device.set_workflow_event_handler(on_workflow)

# 也是自动 ack；手动可 await device.workflow_ack(workflow_id, last_seq)
status = await device.workflow_status(run["workflowId"])
print(status.get("finalText"))
```

## 已知边界 / 后续

- **Graph executor 当前是文本级 RoutingDirective + iteration loop**，无 worker→worker 直连（必须经 executor 中转）。如要 worker mesh，下一轮加 communicationGraph 的非 executor 边支持。
- **persistence**：workflow 状态目前内存为主，重启不恢复；和 sqlite store 集成留给下一阶段。
- **N1 编排 N2 长任务**：BACKLOG 仍计划做 cross-device workflow（多 phonon 联动）、定时/周期 workflow，复用现有 protocol 即可。
- **审计**：`audit_logs` 沉淀仍在 backlog。
