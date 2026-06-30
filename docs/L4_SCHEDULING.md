# L4 Scheduling Protocol（定时任务 / Automation）

Status: **设计获批 + v1 实现已完成（2026-06-30）**。调度内核（cron/webhook/manual 三种 trigger + run=session + consent 三档推送）已落地并通过全部测试。
runKind=workflow 保留接口位，v1 暂拒（明确报 errCapabilityUnsupported，不停半成品语义）。

agent-phonon L4 在 L1 session / L2 tenant / L3 orchestration 之上，提供**设备自治的定时任务调度**。
一个 schedule 到点（或被 webhook / 手动触发）后，会发起一次 **run**；每个 run 本质就是一次普通的
L1 session（或 L3 workflow）执行，因此**复用现有 session 事件流、transcript 快照、proactive 推送通道**，
不另造一套执行与观测体系。

> 本文只定义**通用调度内核**：cron 定时 + webhook 触发 + 手动触发，server 作为控制+观测面。
> **不包含**任何具体第三方平台集成（Slack / 飞书 / Linear 等）——那是上层 server 的业务，留到后续。

---

## 设计原则

1. **调度真相源在 device，不在 server。**
   daemon 本地持有 schedule 表 + 本地时钟触发器。server 只是**镜像视图 + 管理下发面**。
   - 理由：符合 phonon「**设备是授权边界、离线也自治**」的核心哲学。server 断连时，device 的定时
     任务照常按时跑，跑完缓存结果，重连后遵从同意协议补推。
   - 反例（被否决）：把调度真相放 server → server 一挂所有定时任务全停 → 退化成中心化控制，
     丢掉 phonon 相对 OpenHands 等中心化方案的差异化。

2. **不重复发明 run。** 一个 run = 一次 L1 session（或 L3 workflow）。run 的 event stream 直接是
   该 session 的 `stream.event` 流；run 的持久化直接复用 **v0.8.7 的 session JSONL transcript 快照**
   （`~/.agent-phonon/sessions/<sessionId>.jsonl`）。`run.transcriptPath` 指过去即可。

3. **webhook 是 trigger 的一种**，和 `cron`（定时）、`manual`（手动）并列。三者最终都收敛到同一条
   「发起一次 run」的内部路径，只是触发来源（`triggerSource`）不同。

4. **可靠投递不另起一套。** schedule 的镜像同步与 run 结果推送复用现有 outbox/ack 机制
   （`stream.ack` 平行的 `schedule.ack`）。离线期间 run 结果排队，重连后 at-least-once 补推。

5. **默认安全 + 最小授权。** webhook 是「外部能打进来触发本地 agent 执行」的最高风险入口：
   每个 schedule 独立 `webhookToken`、server 侧验签、且 webhook 触发的 run **同样过 device 的
   consent/policy 门**——不因为是 webhook 就绕过设备授权边界。

6. **底层通用 vs 上层业务解耦。** phonon 只提供：schedule 存储/触发、run 生命周期、event stream
   观测、按同意协议推送。具体「推到哪个平台、推成什么格式」由上层 server 实现。

---

## 数据模型

两张表，都存在 **device 本地 sqlite**，并镜像到 server。

### `schedule`（定时任务定义）

```ts
{
  id: string,                  // schedule id（device 生成，全局唯一）
  deviceId: string,
  tenantId: string,            // L2 租户归属
  name: string,
  enabled: boolean,

  trigger:
    | { kind: "cron", expr: string, tz: string }     // 本地时钟，tz 默认设备时区
    | { kind: "webhook", webhookToken: string }      // 外部 POST 触发
    | { kind: "manual" },                             // 仅手动 schedule.trigger

  // 到点后要发起的 run 的「配方」
  target: {
    runKind: "session" | "workflow",     // 复用 L1 或 L3
    adapter: string,                     // session: 用哪个 agent
    project: string,                     // 必须绑 project（与 session.create 一致）
    model?: string,
    prompt?: string,                     // runKind=session 时的任务文本
    plan?: object,                       // runKind=workflow 时的 L3 plan
    agentConfig?: object,
    skills?: string[],
  },

  // 同意协议：run 结束后主动推送的粒度
  consent: {
    push: "full" | "summary" | "status-only",
    // full       = 推完整 event stream（transcript 引用 + 事件）
    // summary    = 推摘要（最终 result.text + status + usage）
    // status-only= 只推 success/failed + 时间，不带内容
  },

  // 执行策略（全部可选，默认安全）
  policy?: {
    timeoutMs?: number,                  // 单次 run 超时
    overlap?: "skip" | "queue" | "allow",// 上次还在跑时如何处理新触发，默认 skip
    maxRetries?: number,                 // 失败重试，默认 0
    catchUp?: boolean,                   // 错过的 cron 点是否补跑，默认 false
  },

  createdAt: number,
  updatedAt: number,
  lastRunAt?: number,
  nextRunAt?: number,                    // cron 下次触发的预计算时间（仅 cron）
}
```

### `run`（每次执行记录）

```ts
{
  id: string,                  // run id
  scheduleId: string,
  deviceId: string,
  tenantId: string,

  sessionId?: string,          // runKind=session：对应的 L1 session
  workflowId?: string,         // runKind=workflow：对应的 L3 workflow

  triggerSource: "cron" | "webhook" | "manual",
  status: "pending" | "running" | "success" | "failed" | "timeout" | "cancelled" | "skipped",

  startedAt?: number,
  finishedAt?: number,
  exitReason?: string,         // 终态原因（normal / timeout / interrupted / error...）
  error?: string,

  transcriptPath?: string,     // ← 复用 v0.8.7 session JSONL 快照
  resultText?: string,         // 终态产物文本（summary 推送用）
  usage?: object,              // token / 耗时统计

  pushState?: "pending" | "pushed" | "acked",  // 同意协议推送状态（离线补推追踪）
}
```

**关键衔接**：`status: "running"` 即回答「当前是否在执行」；`run` 历史列表即回答
「执行情况 / 时间 / 次数 / 成功 or 失败」；`transcriptPath` + 实时订阅即回答
「执行过程中可查看 event stream」。

---

## 协议方法（WS/JSON-RPC 2.0，沿用 phonon 命名风格）

### 管理（server → phonon）

| 方法 | 类型 | 干啥 |
|------|------|------|
| `schedule.create` | request | 建定时任务，返回 schedule（含 webhookToken if kind=webhook） |
| `schedule.update` | request | 改定义（trigger/target/consent/policy/enabled） |
| `schedule.delete` | request | 删定时任务 |
| `schedule.list`   | request | 列本设备 schedule（可按 tenant/enabled 筛） |
| `schedule.get`    | request | 单个 schedule 详情，含 nextRunAt/lastRunAt |
| `schedule.enable` / `schedule.disable` | request | 启停（等价 update enabled，给个语义化捷径） |
| `schedule.trigger` | request | **手动触发一次 run**（manual / 测试 cron / 重放 webhook 都走它） |

### 观测（server → phonon）

| 方法 | 类型 | 干啥 |
|------|------|------|
| `schedule.runs.list` | request | 列某 schedule 的 run 历史：时间、次数、status、耗时 |
| `run.get` | request | 单次 run 详情，含 `status:"running"` → 当前是否在执行 |
| `run.events.subscribe` | request | 实时订阅该 run 的 event stream（内部转发对应 session 的 `stream.event`） |
| `run.events.unsubscribe` | request | 取消订阅 |
| `run.cancel` | request | 取消正在跑的 run（内部映射 session.interrupt / workflow cancel） |

### 镜像 & 推送（phonon → server）

| 方法 | 类型 | 干啥 |
|------|------|------|
| `schedule.changed` | notify | device 本地 schedule 变化（含 cron 算出的新 nextRunAt）主动同步给 server |
| `run.started` | notify | run 开始（triggerSource / sessionId） |
| `run.event` | notify | run 过程事件（订阅了才推；本质是带 runId 标记的 session stream.event 转发） |
| `run.finished` | notify | run 终态 + 按 consent.push 决定的 payload（full/summary/status-only） |
| `schedule.ack` | notify | server 确认收到 run.finished，phonon 清推送 outbox |

### webhook 入口（server 侧 HTTP，非 WS）

- server 暴露 `POST /hooks/<webhookToken>`，**验签**（token + 可选 HMAC body 签名）。
- 命中后 server 把它映射成对该 device 的一次内部 `schedule.trigger`（triggerSource=webhook），
  经 WS 下发给 device。device 收到后**照样过本地 consent/policy 门**再执行。
- webhook body 可作为 run 的输入变量注入 target.prompt（模板插值，留待实现细化）。

---

## 触发与执行时序

```
[cron 到点 / webhook 命中转发 / 手动 schedule.trigger]
        │
        ▼ device 本地调度器
  检查 enabled + overlap policy
        │
        ▼ 过 consent / policy 门（webhook 触发也不例外）
  创建 run（status=pending）
        │
        ▼ 按 target.runKind
  session.create + session.send   或   workflow.run
        │  （run.started notify → server）
        ▼
  执行中：stream.event 自动写 JSONL 快照(v0.8.7)
          若 server 订阅了 run.events → 转发为 run.event
        │
        ▼ 终态
  run.status = success/failed/timeout
  按 consent.push 组装 payload → run.finished（主动推送）
        │  离线则入 outbox，重连后补推（at-least-once）
        ▼
  server 回 schedule.ack → 清 outbox
```

---

## 同意协议（push 粒度）

run 结束后，device **不无条件把全部内容推给 server**，而是按 schedule.consent.push 决定：

- `full`：推完整事件（transcript 引用 + 关键事件），server 可完整回放。
- `summary`：只推 `resultText` + `status` + `usage`。
- `status-only`：只推 `status` + 起止时间，零内容外泄。

这让「定时任务自动跑」与「设备隐私边界」并存：高敏任务可设 status-only，跑归跑，内容不出设备。

---

## 与现有层的关系

| L4 概念 | 复用的现有能力 |
|---|---|
| run 执行 | L1 `session.create/send` 或 L3 `workflow.run` |
| run event stream | 现有 `stream.event` + 订阅机制 |
| run 持久化 | **v0.8.7 session JSONL transcript 快照** |
| run 主动推送 | 现有 proactive/unsolicited output 通道 + outbox/ack |
| consent 门 | 现有 HITL / policy / consent 模型 |
| run.cancel | `session.interrupt` / workflow cancel |

L4 几乎不新增执行原语，主要新增的是**调度器（device 本地 cron + webhook 触发）+ schedule/run 两张表
+ 上面那组 schedule.*/run.* 方法**。

---

## 安全要点（必须守住）

1. **webhook = 最高风险入口。** 每 schedule 独立 token、server 验签、device 侧二次过 consent/policy。
   不能因为「是 webhook」就跳过设备授权边界。这正是 phonon 相对「agent 拥有完整文件系统权限」类
   方案的反向卖点。
2. **webhookToken 是密钥**，`schedule.get`/`list` 默认脱敏（与 phonon secrets redaction 一致），
   仅创建时返回一次 / 显式 reveal 才给。
3. **overlap=allow 要谨慎**：高频 webhook + allow 可能并发拉起大量 session，policy 应能限流
   （maxConcurrentRuns，留待实现）。
4. **catchUp 补跑**默认关：避免设备离线一夜后重连瞬间补跑几十个 run 风暴。

---

## 已知边界 / 留待实现细化

- webhook body → target.prompt 的模板插值语法（变量白名单、防注入）。
- cron 表达式库选型（需支持 tz、秒级可选）。
- `maxConcurrentRuns` 设备级限流。
- run 历史的本地保留策略（复用 sessions prune 思路：older-than / keep-n）。
- cross-device schedule（一个逻辑任务跨多设备）——明确**不在本期**，N2 BACKLOG。
- 具体平台集成（Slack/飞书/...）——明确**不在本期**，上层 server 业务。

---

## v1 实现落点（2026-06-30）

协议（`@agent-phonon/protocol`）
- `packages/protocol/src/schemas/schedule.ts`：Schedule/Run/trigger/consent/policy + 全部方法 params/result。
- `methods.ts` 注册 18 个 L4 方法（13 个 s2p request + 1 个 s2p notify `schedule.ack` + 4 个 p2s notify）。协议方法总数 63 → 81。

Device 核心（`@agent-phonon/core`）
- `scheduler-engine.ts`：SchedulerEngine —— schedule CRUD、三态 trigger 收敛到 `launchRun`、run=session、
  按 `onStreamEvent` 判定终态、consent 三档裁剪推送、cron 本地时钟（timer `.unref()` 不阻塞进程）、
  webhook token 生成/脱敏、overlap=skip、超时、离线补推（`replayUnacked`）。
- `cron.ts`：零依赖 5 段 cron 解析 + tz wall-clock `nextCronAfter`（Intl 时区，dom∪dow 经典语义）。
- `store.ts`：新增 `schedules` + `runs` 两表 + CRUD（webhookToken 索引、未 ack 终态 run 查询）。
- `index.ts`：PhononConnection 实例化 SchedulerEngine、stream.event 路由进调度器、dispatch 14 个 case、
  MUTATING_METHODS 纳入幂等。

双 SDK
- TS：`device.schedule.*` / `device.run.*` wrapper + `runStarted/runEvent/runFinished/scheduleChanged` 事件 + 自动 ack。
- Python：对等 `schedule_*` / `run_*` 方法 + p2s handler。consistency parity 全过。

测试
- `fn-cron.test.ts`（9）：cron 解析/范围/步进/tz/dom∪dow/非法输入。
- `fn-scheduler.test.ts`（8）：CRUD、manual trigger→run 终态、consent 三档、webhook 脱敏、持久化、workflow 拒绝。
- `e2e-scheduler.test.ts`（3）：真实 WS+SDK 跑通 create/trigger/run + p2s 推送 + full consent transcriptPath。
- 全量回归：functional 125、e2e 29、protocol 50 全绿。

留待下一阶段
- runKind=workflow（接 L3 WorkflowEngine）。
- webhook server 端 HTTP 入口 `POST /hooks/<token>`（core 已有 `triggerByWebhook`，差 server SDK 暴露 HTTP）。
- daemon 级 SchedulerEngine 生命周期（当前随 PhononConnection 建/销；跨 0 连接存活需提到 daemon 持有）。
- webhook body → prompt 模板插值、`maxConcurrentRuns` 限流、run 历史保留策略。
```
