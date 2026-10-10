# UnACKed delivery warning threshold / 未 ACK 投递警戒阈值

## English

### Configuration: pressure is a warning, not rejected input

Add to `~/.agent-phonon/config.json` and restart to load it:

```json
{ "delivery": { "maxPendingBytes": 1073741824 } }
```

Default: **1 GiB (1,073,741,824 bytes)**. Despite the compatibility field name, `maxPendingBytes` is a **warning/critical threshold**, not an admission limit, maximum event size, hard write cap, disk quota or eviction policy. It must be a positive JavaScript safe integer; strings, fractions, null, NaN and infinity are rejected without coercion. Omitted configuration uses the default.

- At 80% (rounded up), state becomes `warning`; at 100%, `critical`.
- **Byte pressure alone never rejects or defers NEW tasks, sessions, input messages, workflows, explicit resume, or manual/webhook/automatic scheduled execution.** It never cancels, overwrites or deletes work/messages. Existing policy and lifecycle checks still apply.
- All generated stream/workflow/run events, results and terminal/cancel events continue to persist above the threshold, including a single huge output. Duplicate sequence insertion remains idempotent. No unACKed event is silently evicted; legacy `Outbox.maxEvents` remains ignored.
- Critical clears below 100%; warning clears below 80%, with no hysteresis. Logs occur on state crossings, not each token or request. Admission does not depend on these byte states.
- ACK, replay, status, cancel and existing authorized controls keep their existing semantics. Actual ACK drains the measured pending ranges; no background retention policy is introduced.

**There is no new end-to-end durable inbound task/input queue.** Do not describe a rejected request as saved or queued. Session input queuing and the generic session acceptance-to-idempotency-cache crash window retain their existing limits. The warning threshold prevents rejection *because of pending bytes*, not every form of loss under process/storage failure. Actual local persistence/read failure still fails new work closed and explicitly marks unhealthy; it is not disguised as successful acceptance or solved by inventing another queue/service.

Cron runs normally at warning/critical pressure: no capacity deferral timer, marker, disabling, or fake skipped run. Existing `catchUp`, overlap and local consent/policy behavior remain. A cron run receipt and its next cursor commit in one SQLite transaction before any provider call; failure cannot advance the cursor without a durable receipt. True storage failure is surfaced, not converted into a fake accepted execution. Existing nonrecoverable connection-scoped session runs/queued launches can be explicitly audited failed/cancelled on restart; this is not exactly-once provider/process recovery. Deleting a schedule removes its definition but **retains run receipts/history** for `run.get`, ACK and reconnect replay.

### Exact measurement and ACK durability

Measurement covers every tenant in the shared device SQLite store, including disconnected tenants:

- stream `outbox_events` above the tenant/session finalized ACK watermark;
- `workflow_events` with `seq > workflows.acked_seq`;
- `run_events` with `seq > runs.acked_seq`.

Count the **UTF-8 bytes of stored serialized payloads**, including JSON structure. A payload durably copied into two channels counts twice. Duplicate sequences count once; partial ACK drains only that range. ACKed workflow/run historical event rows remain retained but do not count pending. `schedule.ack {finished:true}` acknowledges the terminal run receipt, not event sequences; `lastSeq` drains `run_events`. Run summaries/checkpoints stored as columns are not serialized event payloads in this measure. Legacy orphan events without a parent watermark are conservatively counted unACKed, never discarded; an owner may need to inspect them if normal replay cannot reach them.

SQLite triggers maintain a payload-free pending-entry ledger and three channel counters in the same transaction as source inserts, deletes and ACK changes. Store open reconciles from existing durable records without trimming them. Steady-state token/health reads use those three rows, not repeated `SUM(payload)` scans. ACK costs scale with its acknowledged entry range, not payload rereads. Stream ACK commits watermark plus deletion atomically. Stream/workflow/scheduler in-memory watermarks advance **only after persistence succeeds**, so a failed ACK cannot forget an existing durable replay promise.

### Idempotency and background failure reporting

Identical accepted-request retries return their original cached identity/result; changed payload with the same new-execution key fails. Generic request fingerprints are stored in a **separate nullable `idempotency.request_hash` column**, never synthetic request-key rows: legal NUL-containing request IDs remain independent in either acceptance order and after reopening. Old result/ambiguous sidecar rows are preserved without guessing hashes; unverifiable legacy new-execution retries are rejected rather than expanded.

`workflow.run({resumeFrom, clientRequestId:newKey, ...})` stores an independent tenant-scoped resume key/hash/receipt binding to the original workflow identity. The original `_phononDispatch` key is not overwritten. Queued checkpoint, queued event and resume receipt commit together before execution; immediate and reopened identical retries return that receipt without repeating restore/execution, even at critical pressure. Changed payload is rejected.

Detached workflow execution, scheduled queue/retry/recovery launches and timeout callbacks have terminal **no-throw, payload-free** failure reporting. If error finalization itself cannot persist, `delivery.background_failed` names only the component, latches unhealthy and does not make another SQLite write. Previously durable unACKed rows remain replayable; no fake successful completion/finished receipt is emitted. Actual first-write failure cannot be guaranteed recovered. A later successful write/ACK does not prove a generated-but-unpersisted event has been recovered; the failure latch is cleared only by reopening after owner storage diagnosis.

### Observability

Core: `store.delivery.snapshot()` or `connection.deliveryStatus()`. Direct connection/client callers can pass `delivery`; standalone stores use `new PhononStore(path,{delivery})`. An injected shared store keeps its limit unless explicitly overridden.

`/health.delivery` contains `channels.{stream,workflow,run}.{count,bytes}`, `pendingCount`, `pendingBytes`, `maxPendingBytes`, `warningBytes`, `state` (`normal`/`warning`/`critical`), `pressureCritical`, `persistenceHealthy`, and `admissionBlocked`. **Pressure and admission are independent:** a healthy critical backlog has `pressureCritical=true`, `admissionBlocked=false`; health remains HTTP 200/`ok=true` unless another health condition fails, with `degraded=true`. Actual persistence-unhealthy makes `admissionBlocked=true` and health HTTP 503.

`/metrics` and `/metrics.json` expose `phonon_delivery_pending_bytes/events`, per-channel gauges, `phonon_delivery_max_pending_bytes` (configured warning threshold), `phonon_delivery_pressure_critical`, `phonon_delivery_admission_blocked` and `phonon_delivery_persistence_healthy`. Capacity/background telemetry contains counts/state/component only, not event payloads or credentials.

If accounting reads themselves fail, all three endpoints return sanitized JSON **503** with `delivery.state="unavailable"`, `measurementAvailable=false`, `persistenceHealthy=false`, `admissionBlocked=true`, and a fixed error label. Unknown counts/bytes/channels are **omitted, not fabricated zero**. Raw SQLite errors, stacks, internal paths and payloads are not returned. HTTP stays running; unrelated endpoints and authorized status/replay/control calls remain available subject to their own storage requirements. Core new-work admission still throws/fails closed on a read error. Restored reads allow actual metrics again, but do not clear the sticky failed latch. Ordinary known critical pressure is not an unavailable measurement.

### Not a disk or RAM guarantee

Payload bytes exclude SQLite pages/indexes/ledger/WAL, checkpoints, ACKed histories, Session JSONL/archives and filesystem overhead. ACK need not immediately shrink the database file. The existing Outbox still mirrors all pending stream payloads in memory; replay materializes workflow/run rows. A 1 GiB threshold **does not bound RAM, pending growth or disk usage**. Monitor disk/RAM and maintain real headroom. Full/broken storage can prevent first persistence; explicit unhealthy is not a guarantee against that failure.

All Session JSONL and old archives remain retained by default. Delivery ACK never truncates, rotates or expires session history. No production dependency, new service, queue/database replacement or automatic retention policy is introduced.

## 中文

### 配置：容量压力告警，不拒绝新输入

在 `~/.agent-phonon/config.json` 配置并重启后生效：

```json
{ "delivery": { "maxPendingBytes": 1073741824 } }
```

默认 **1 GiB（1,073,741,824 字节）**。兼容字段名 `maxPendingBytes` 表示**warning/critical 警戒阈值**，不是准入上限、单事件大小限制、硬写入上限、磁盘配额或淘汰策略。必须是正安全整数，字符串、小数、null、NaN、Infinity 不转换、不接受；缺省用默认值。

- 80%（向上取整）为 `warning`，100% 为 `critical`。
- **只因字节超阈值，绝不拒绝或延期新任务、新 Session、输入消息、workflow、显式恢复、手动/webhook/自动调度执行；不自动取消、覆盖、删除任务或消息。** 原有权限和生命周期检查照常。
- 超限时事件、结果、取消/终态仍写入并重放，包括单次巨大输出；重复序列只计一次。未 ACK 事件不静默淘汰，旧 `Outbox.maxEvents` 继续忽略。
- 低于 100% 解除 critical，低于 80% 解除 warning；无滞回。只在状态跨越时记录容量告警，不每 token/请求刷日志；字节状态不影响准入。
- ACK、重放、状态、取消及原有授权控制不按容量封锁。ACK 真实扣减确认区间，不引入自动保留策略。

**本轮没有实现端到端持久入站任务/输入队列。** 不能把被拒绝请求称作“已保存/已排队”。Session 输入队列及通用 Session 接受→幂等缓存写入的既有崩溃窗口仍存在。警戒阈值只避免因待确认字节而拒绝，不保证所有进程/存储故障下的新输入永不丢失。真实存储/计数读取失败仍明确 fail-closed，停新工作准入并标 unhealthy，不能假成功接受，也不另造队列/服务掩盖问题。

cron 在 warning/critical 下正常触发，没有容量延期 timer/marker、没有禁用或虚构 skipped run。既有 `catchUp`、overlap、授权/policy 语义不变；cron run 回执与下次游标在调用 provider 前同事务提交，不能只推进游标而没有持久回执。真实写失败明确上报，不假接受。既有无法恢复的 connection-scoped session run/排队启动，重启时仍可明确审计为 failed/cancelled，不承诺 provider/进程 exactly-once。删除调度仅移除定义，**保留 run 回执/历史**供读取、ACK、重连补推。

### 精确计量与 ACK

从设备共享 SQLite 的**全部租户**（含离线租户）计量：stream 高于最终 ACK 水位的 `outbox_events`、`workflow_events.seq > workflows.acked_seq`、`run_events.seq > runs.acked_seq`。

按库内序列化 payload 的 **UTF-8 字节**计量，含 JSON 结构；复制到不同通道分别计数，重复序列不重复计，部分 ACK 只扣对应区间。已 ACK 的 workflow/run 历史仍保留但不计待确认。`schedule.ack {finished:true}` 只确认终态回执，必须 `lastSeq` 才扣 run 事件；列式摘要/checkpoint 不属于这里的序列化事件字节。缺父记录的旧孤儿事件保守计为未 ACK，不删除；正常重放不可达时由所有者检查。

SQLite 触发器事务内维护无 payload 账本与三个通道计数器；启动从已有记录核对重建，不删历史。正常 token/健康查询只读三个计数行，不重复扫描 `SUM(payload)`。ACK 按确认区间处理账本，不重读 payload；stream ACK 水位与删除原子提交，三通道内存水位都在持久化成功后才推进，失败 ACK 不遗忘已有重放承诺。

### 幂等与后台失败

已接受请求的相同重试返回原身份/结果，同新执行 key 改内容报错。哈希存入独立可空 **`idempotency.request_hash` 列**，不占合成请求 key；合法含 NUL 的 ID 两种接受顺序及重开库后均独立。旧结果和有歧义的旧 sidecar 行原样保留，不猜哈希；无法验证的旧新执行重试明确拒绝，不扩展执行。

`workflow.run({resumeFrom,clientRequestId:newKey,...})` 独立保存租户级恢复 key/哈希/回执，绑定原 workflow，不覆盖原 `_phononDispatch` key。queued checkpoint、queued 事件和回执在执行前同事务提交；立即或重开库后相同请求先返回原回执，不重复恢复/执行，critical 下同样如此；改 payload 拒绝。

后台 workflow 执行、调度排队/重试/恢复启动、超时回调都有末端**无抛出、无 payload**失败通知。错误收尾仍写失败时，`delivery.background_failed` 只记录组件，锁定 unhealthy，不再次写 SQLite；已持久未 ACK 行仍可重放，不发布虚假的完成回执。首次写失败的事件无法承诺追回；后来某次 ACK/写成功不证明曾失败事件已找回。所有者检查存储后重开 store 才清失败锁存。

### 可观测性与边界

Core 可读 `store.delivery.snapshot()`/`connection.deliveryStatus()`；直建 connection/client 传 `delivery`，或 `new PhononStore(path,{delivery})`。注入共享 store 未显式覆盖时沿用其阈值。

`/health.delivery` 有分通道数量/字节、总 `pendingCount/pendingBytes`、`maxPendingBytes/warningBytes`、`state`（normal/warning/critical）、`pressureCritical`、`persistenceHealthy`、`admissionBlocked`。**压力与准入独立**：健康 critical 为 `pressureCritical=true`、`admissionBlocked=false`；没有其它健康问题时 HTTP 200/`ok=true`，仅 `degraded=true`。真实持久化不健康才阻塞新工作，health 503。

指标包含 `phonon_delivery_pending_bytes/events`、分通道 gauge、`phonon_delivery_max_pending_bytes`（警戒阈值）、`phonon_delivery_pressure_critical`、`phonon_delivery_admission_blocked`、`phonon_delivery_persistence_healthy`。容量/后台遥测只含数字、状态或组件，不含正文/凭据。

计数读取本身失败时 `/health`、`/metrics`、`/metrics.json` 均返回脱敏 JSON **503**：`state="unavailable"`、`measurementAvailable=false`、`persistenceHealthy=false`、`admissionBlocked=true`、固定错误标签。未知计量字段省略，**不伪造为零**；不返回原始 SQL 错误、堆栈、内部路径或 payload。HTTP 不退出，其它端点和已有权限的状态/重放/控制仍可用，但受自身存储要求约束。Core 新工作读取失败仍抛错/fail-closed；读恢复后指标可展示真实值，不清 sticky failed。正常 critical 与读取不可用明确区分。

**不保证磁盘/RAM 有界：**字节不含 SQLite 页/索引/账本/WAL、checkpoint、已确认历史、Session JSONL/归档与文件系统开销；ACK 不一定立即缩小文件。Outbox 仍镜像 stream payload 到内存，workflow/run 重放也会物化行；1 GiB 警戒不限制 RAM、积压增长或磁盘。请监控实际余量。满盘/损坏可导致首次写失败，unhealthy 不是防满盘保证。

所有 Session JSONL 与旧归档默认保留不变，ACK 不截断/轮转/过期历史；没有新增生产依赖、服务、替代队列/数据库或自动保留策略。
