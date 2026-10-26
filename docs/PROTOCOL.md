# agent-phonon 协议总览（一页速读）

> 自动对照 `packages/protocol` 源码的人话版总览。字段级看 `src/schemas/*.ts`，决策看 `docs/design.md`。
> 当前 105 个方法，协议版本 `0.1.0`。新增方法保持向后兼容。

## 一句话

phonon 拿 device key 主动拨出连服务端；单条 WebSocket 上双向跑 JSON-RPC 2.0。服务端下发 session 操作，phonon 上推流式结果 / 自发输出 / hook 请求。

## 方法摘要

| 方法 | 方向 | 类型 | 干啥 |
|------|------|------|------|
| `connect.hello` | phonon→server | request | 握手：协议版本 + 设备身份 → 回 tenant 绑定 |
| `device.info` | server→phonon | request | 查 OS/机器信息与调度标签：平台、架构、hostname、capabilities（如 ios-development/windows-desktop-development） |
| `device.resources` | server→phonon | request | 查设备资源快照：CPU/内存/磁盘/进程/GPU best-effort（仅监控，不调度） |
| `device.fs.roots` | server→phonon | request | 返回设备可浏览根：workspaceRoot/home，以及 Linux/macOS `/` 或 Windows 盘符 |
| `device.fs.list` | server→phonon | request | 设备级目录浏览；`projectCandidates` 模式按本机路径前缀返回可导航/可选目录与身份，不读取文件内容。见 [WORKSPACE_DIRECTORIES.md](WORKSPACE_DIRECTORIES.md)。 |
| `maintenance.targets` | server→phonon | request | 列设备本地预注册的维护 target/config/service 及当前权限 |
| `maintenance.diagnose` | server→phonon | request | 确定性诊断 executable、已注册文本配置和用户服务，不依赖 LLM/外部 Agent |
| `maintenance.config.get` | server→phonon | request | 读取预注册 JSON/JSONC/YAML/TOML/text，secret 字段递归脱敏，并返回 SHA-256 乐观锁 |
| `maintenance.config.patch` | server→phonon | request | RFC 7396 merge patch；本地 policy gate，自动备份、原子写，拒绝 raw path 和 `***` secret 占位符 |
| `maintenance.config.edit` | server→phonon | request | expectedSha256 + 唯一非重叠 oldText/newText；显式 public 文本、写前格式校验、root allowlist、原始字节备份 |
| `maintenance.rollback` | server→phonon | request | 按本地 backupId 校验 checksum 后回滚预注册配置 |
| `maintenance.package.update` | server→phonon | request | 更新设备本地白名单中的用户态 npm/pnpm 包，协议不接受包名 |
| `maintenance.service.status` | server→phonon | request | 查询设备本地白名单用户服务状态 |
| `maintenance.service.restart` | server→phonon | request | 重启设备本地白名单用户服务，协议不接受任意服务名 |
| `discovery.list` | server→phonon | request | 列本机可用 agent + 各自模型 |
| `discovery.get` | server→phonon | request | 单个 agent 详情 |
| `discovery.changed` | phonon→server | notify | 可用性变化主动推 |
| `session.create` | server→phonon | request | 建会话，**必须绑 project + agent + model** |
| `session.send` | server→phonon | request | 发任务＝对话；ack 回 turnId，内容走 stream；可传 `skills` 指定本轮技能 |
| `session.inject` | server→phonon | request | 注入上下文 |
| `session.compress` | server→phonon | request | 压缩，native \| custom 双模；custom `dropToolIO` 仅适用于 adapter 可安全操作的存储。OpenClaw SQLite Gateway 无对应自定义 API 时返回 `errCapabilityUnsupported`，不编辑其私有数据库；native 必须确认实际 compacted，不能吞错伪成功。 |
| `session.compression.status` | server→phonon | request | 按 Session/operation 查询持久压缩回执；区分 running/succeeded/noop/failed/unknown，未知结果不自动重做。 |
| `session.switchModel` | server→phonon | request | 中途换模型（agent 不变） |
| `session.interrupt` | server→phonon | request | **打断当前 turn，session 存活** |
| `session.terminate` | server→phonon | request | 销毁整个 session |
| `session.status` | server→phonon | request | 查单个 session（带状态/绑定/正在跑哪轮） |
| `session.recover` | server→phonon | request | 校验保留的 project/agent/model 和设备原生检查点，接回原 Session；不发送输入、不恢复队列、不重跑 workflow。 |
| `session.list` | server→phonon | request | 列 session（可按 agent 筛） |
| `stream.event` | phonon→server | notify | 流式结果（含自发输出；终态 status） |
| `stream.ack` | server→phonon | notify | 确认已收 seq≤N，phonon 清 outbox（P0-4） |
| `stream.replay` | server→phonon | request | 按 Session 重发尚未 ACK 的持久输出，最多 1000 条；不启动模型、不代替 ACK |
| `hook.fired` | phonon→server | request | 到 hook 点抛事件，阻塞等裁决 |
| `hook.resolve` | server→phonon | request | 裁决：continue/inject/modify/abort |
| `document.send` | phonon→server | request | 发本地文档（agent emit 路径，phonon 读盘上传；project-scoped）；原生会话来源及文件传输见 [NATIVE_DOCUMENTS.md](NATIVE_DOCUMENTS.md) |
| `document.prepare_upload` | phonon→server | request | 大文件凭证上传（预签名 URL，P1-6） |
| `interaction.request` | phonon→server | request | 发可交互表单/卡片给人填（timeout/cancel） |
| `interaction.response` | server→phonon | notify | 人填完的值回填（异步路径） |
| `interaction.cancel` | server→phonon | request | 主动取消 pending 交互（P1-5） |
| `interaction.status` | server→phonon | request | 查询 tenant 隔离的持久交互回执、请求/回应哈希和可信运行归属；区分已送达与执行方已确认消费 |
| `conversation.board` | phonon→server | request | 当前原生轮次读写自己的会话状态板；控制器标记来源，服务端校验权限、版本及幂等回执。 |
| `conversation.workflow` | phonon→server | request | DE 读取显式 Agent / Role / 工作副本目录、提交跨设备 DAG 并按来源选择请求审批；返回真实子任务结果，不把工作 Agent 加入群。 |
| `conversation.message` | phonon→server | request | 当前项目群 DE 的成员查询、显式定向消息及只读回执；身份由控制器标记，权限、预算及真实投递状态由服务端维护。 |
| `project.coordination` | phonon→server | request | 独立项目协作目录、活动声明、跨设备信箱与回执；不写人类聊天、不自动启动任务。详见 `PROJECT_COORDINATION.md`。 |
| `conversation.archive.append/read/status` | server→phonon | request | 独立持久化 Phonon 规范会话记录、固定水位分页和查询归档检查点；默认关闭，不启动 Agent、不替代附件归档或安全回收。见 [CONVERSATION_ARCHIVE.md](CONVERSATION_ARCHIVE.md)。 |
| `conversation.archive.entities` | server→phonon | request | 固定归档水位下按实体逻辑顺序倒序分页或按 key 查询完整版本引用；需 `conversation_archive_entities_v1`，保留十进制字符串和分片校验，不启动 Agent。 |
| `conversation.archive.blob.write/status/read` | server→phonon | request | 独立附件二进制分块持久化、续传和读取；需 `conversation_archive_blobs_v1`，复用归档作用域和额度，完整 SHA-256 校验后才确认完成，不启动 Agent 或自动删除源文件。 |
| `employee.profile.apply/status` | server→phonon | request | 按显式设备策略安装独立 DE 配置、真实私聊目录；校验版本，保留原生记忆 |
| `project.create` | server→phonon | request | 建项目；可用 `existingDirectoryIdentity` + `git:false` 严格登记既有目录，不建目录或 Git。见 [WORKSPACE_DIRECTORIES.md](WORKSPACE_DIRECTORIES.md)。 |
| `project.list/get` | server→phonon | request | 查项目 |
| `project.remove` | server→phonon | request | 删项目（默认只解绑不删盘） |
| `project.worktree.create` | server→phonon | request | 基于 branch 建 worktree |
| `project.worktree.provision` | server→phonon | request | 持久化、单次派发地创建并注册独立 linked checkout；需本机 allowProjectProvision 与 receiverID，不接受调用方路径 |
| `project.worktree.provision.status` | server→phonon | request | 读取原创建凭据，不重试不确定的 Git 操作 |
| `project.worktree.list` | server→phonon | request | 列 worktree |
| `project.worktree.remove` | server→phonon | request | 清理 worktree |
| `project.git.deleteBranch` | server→phonon | request | 删合并分支 |
| `project.git.commit/merge/diff/log/push/status` | server→phonon | request | 底层 Git 操作：提交、合并、diff、日志、推送、状态 |
| `project.git.origin` | server→phonon | request | 只读检测已注册目录的 origin；按 projectId 隔离，返回去除凭据的地址或 missing/unsupported，不 fetch |
| `project.exec` | server→phonon | request | 在 project/worktree sandbox 内受控执行非 shell 命令，返回 exitCode/stdout/stderr/duration |
| `file.read` | server→phonon | request | 读取 project/worktree 内文件（utf8/base64，可 maxBytes 截断） |
| `file.write` | server→phonon | request | 写 project/worktree 内文件（可建父目录、可幂等） |
| `file.list` | server→phonon | request | 列 project/worktree 内目录（可递归、limit） |
| `file.stat` | server→phonon | request | 查文件/目录 metadata |
| `file.mkdir` | server→phonon | request | 创建 project/worktree 内目录 |
| `env.set` | server→phonon | request | 配置执行环境变量（global/project/skill scope，明文存在设备本地） |
| `env.list` | server→phonon | request | 查询环境变量配置；默认脱敏，reveal 需本地 policy 允许 |
| `env.delete` | server→phonon | request | 删除环境变量配置 |
| `skill.install` | server→phonon | request | 给 agent 装 skill（global\|project）；source 支持 inline files / archive tar.gz / localPath / url 预留 |
| `skill.install.status` | server→phonon | request | Read the exact owned install receipt without replaying writes. Optional `includeReceiverIdentity:true` proves only an originally captured persistent namespace receiver; legacy/missing proof stays absent. Unknown/not_found is not proof of no effects. See NATIVE_SKILL_INSTALL_RECEIPTS.md. |
| `skill.install.fence` | server→phonon | request | Explicit local-policy recovery CAS prevents late confirmation of the exact unconfirmed Project transaction; result remains unknown, files are not deleted and the target stays locked. Never a default Agent MCP tool or an unlock. See NATIVE_SKILL_FENCES.md. |
| `skill.publish` | server→phonon | request | Project-only immutable version publication with original nonce and explicit base revision. Optional `expectedReceiverID` is checked before cached receipt replay, mutation and commit; never a legacy-mode fallback. |
| `skill.unpublish` | server→phonon | request | Revision-checked deactivation and queued-version revocation; files and history are preserved. |
| `skill.uninstall` | server→phonon | request | 卸 skill |
| `skill.list` | server→phonon | request | 列 skill |
| `skill.dirs` | server→phonon | request | 查询某 agent global skill 目录、某 project `.agent/skills` 下 skill 名称与真实本机路径 |
| `workflow.run` | server→phonon | request | L3 编排：提交 DAG 或 executor graph 执行计划；policy.timeout/maxParallel/onNodeFailure 可选 |
| `workflow.status` | server→phonon | request | 查询 workflow 与各 node/session 状态；节点 result 带 text/status/usage；finalText 可选 |
| `workflow.cancel` | server→phonon | request | 取消 workflow（幂等） |
| `workflow.dispatch.cancel` | server→phonon | request | 按 tenant/project/dispatchKey 写入持久取消记录，处理尚未拿到 workflowId 的取消；已完成结果不改写 |
| `workflow.pause` | server→phonon | request | 暂停 workflow 并 fence 迟到事件 |
| `workflow.resume` | server→phonon | request | 按持久化 checkpoint 和指定策略恢复 |
| `workflow.list` | server→phonon | request | 列 workflow run（可按 status/projectId/since/until 筛） |
| `workflow.event` | phonon→server | notify | L3 工作流级元事件：workflow.status / node.status / edge.route / executor.decision / artifact.written / node.diagnostic（session 输出走 stream.event） |
| `workflow.ack` | server→phonon | notify | 确认 workflow.event seq≤lastSeq（与 stream.ack 平行） |
| `workflow.events.list` | server→phonon | request | 回放 workflow.event（afterSeq + limit），用于 Hub 重连/补历史 |
| `workflow.artifact.register` | server→phonon | request | 登记 workflow 产物并发 artifact.written 事件 |
| `workflow.artifacts.list` | server→phonon | request | 列出某 workflow 已登记产物 |

## session 状态（你问的重点，D19）

```
create ──▶ idle ──send──▶ running ──turn结束/interrupt──▶ idle ──terminate──▶ terminated
重启恢复 ──▶ paused ──re-attach成功──▶ idle
```

| 状态 | 含义 |
|------|------|
| **idle** | 活着、空闲、可接 send（create 后初始态；turn 结束或 interrupt 后回到这） |
| **running** | agent **正在执行**一个 turn（`session.status` 带 `currentTurnId`） |
| **paused** | 重启后待 re-attach，或被显式暂停 |
| **terminated** | 已结束销毁 |

> 关键：`interrupt` 后回 **idle**（停一下、session 还在），不是 terminated。

## 流式输出两种来源（订阅模型，D16）

- **solicited** — 某次 `send` 触发的响应
- **unsolicited** — agent 自发（OpenClaw cron/定时/心跳），带 `source`；create 即订阅，自动推

一次性 agent（Codex）流到 `result final` 就停；持久 agent（OpenClaw）即使不 send 也持续冒泡。capability `proactiveOutput` 声明会不会自发；不支持的 agent 零成本（向下兼容）。

**L3 归属字段（2026-06-23 合并 P0-1）**：由 workflow node 创建的 session 的所有 `stream.event` 都会被 phonon 自动加上 `workflowId / nodeId / role` 三字段。服务端只需设一个 `streamEvent` 监听器，按 `workflowId` 筛、按 `nodeId/role` 区分来源即可；**不需要另外订阅 workflow.event 里的 session 输出**（原 `node.stream` 事件已删除）。普通 session 原样返回，不带额外字段。

原生聊天还会在发送 stream 前标注 `nativeRunId`，即使 dispatch ACK 尚未到达也能归属。
`native_chat_workflow_v1` 保留跨轮 Session，断连/重启后暂停而非自动重复执行。
能力要求、最终回复节点和 SDK 调用见 [NATIVE_CHAT.md](NATIVE_CHAT.md)。

## 忙碌时新消息怎么办（D18，双向不丢）

`session.send` 的 `whenBusy`：
- **queue**（默认）排队，上轮结束自动发
- **interrupt** 打断当前 turn 再发
- **inject** 下次 tool call 边界插入

下行断线靠 outbox 按 seq 重放，上行靠 inbox_queue 持久排队 —— **上下行都不丢**。

## 几条铁律

- **session 必绑 project + agent**（D23/D15）：create 必填 project+agent+model，全程携带（项目 = 目录 + Git）
- **verbosity 4 档**：final / messages / tools / trace
- **HITL 甩锅服务端**（§8）：phonon 只 fired→等 resolve
- **环境变量配置**：`env.*` 独立于 skill 包配置，list 默认脱敏；执行时按 global < project < skill 合并注入
- **本地文件读写**：`file.*` 只允许在 project/worktree 受控目录内操作，不允许任意路径读写
- **多租户硬隔离**（D13）：一条服务端连接 = 一个 tenant，跨租户访问拒
- **协议向上设计、实现向下兼容**（§7）：弱 agent 落子集，不报错不多写

## 第三个通信平面：agent 主动发起（§8b，D20/D21/D22）

靠 **skill 教格式**让任何大模型都能用，不依赖原生 function-calling：agent 输出里 emit 一个 directive → phonon 解析 → 升级成协议调用。

- **文档交换**：agent 只 emit 本地 path，phonon 读盘 + 上传（`document.send`）
- **人机交互**：agent emit 抽象表单 → server 自由渲染（飞书卡片/网页/TG）→ 人填完原路返回注入（`interaction.request/response`）。表单只定义抽象字段，不绑定渲染

原生聊天的当前轮专属交互入口、显式审批提示、无自动批准的超时/停止规则和
`native_interaction_receipts_v1` 见 [NATIVE_INTERACTIONS.md](NATIVE_INTERACTIONS.md)。

DE 的原生 profile、会话身份和私聊目录见 [EMPLOYEE_PROFILES.md](EMPLOYEE_PROFILES.md)。

会话状态板的当前轮读写使用 `conversation.board`（p2s request），包含控制器标记的
会话来源、版本冲突、幂等写入和真实作者；`native_conversation_board_v1` 及两端 SDK
入口见 [NATIVE_BOARDS.md](NATIVE_BOARDS.md)。

手动压缩的后台接收、真实结果回执、并发互斥和未知状态恢复限制见
[SESSION_COMPRESSION.md](SESSION_COMPRESSION.md)。`session_compression_receipts_v1`
不表示每个 adapter 或每个 Session 都支持原生/自定义压缩。

重启后的原生会话恢复、检查点与兼容性边界见
[SESSION_RECOVERY.md](SESSION_RECOVERY.md)。`session_recovery_v1` 表示提供恢复接口，
不表示所有 Session 都能恢复；`session.status.recovery.canAttempt` 仅表示可尝试验证，
成功必须以 `session.recover` 返回的原会话身份为准。

逐轮思考级别使用 `session.send.reasoning` / workflow node `reasoning`，由
`turn_reasoning_v1` 和当前模型能力共同约束。保存偏好不等于生效；控制器确认的
`runtime_settings` 事件才是 Harness 设置回执，不证明模型内部预算或任务完成。
原生参数、默认值恢复与两套 SDK 示例见 [TURN_REASONING.md](TURN_REASONING.md)。

DE 发起的计划、版本化审阅、跨设备委派、真实执行者与原会话汇报见
[NATIVE_WORKFLOWS.md](NATIVE_WORKFLOWS.md)。能力 `native_workflow_delegation_v1`
不等同于任意 RPC 转发，也不默认替 Agent 决定审批政策。

## v0.2 收口（四家 review 采纳，2026-06-20）

多家 AI 模型 review 后，补齐工程化可靠性与安全边界：

**P0（可靠+安全骨架）**
- 本地 policy（D27）：`TenantPolicy` 设备授权边界，默认最严格；document 默认 project-scoped；url 装 skill/删盘/全局 skill/env 写入默认拒
- turn 终态（P0-2）：每个 turn 必有 `result.status` ∈ completed|interrupted|aborted|failed|timeout
- 幂等（D28）：改状态请求带 `clientRequestId` 去重（不丢 + 不重）
- 可靠投递闭环（D29）：`stream.ack` + 重连 `resumeFrom`/`ackedSeqs` 双向对齐

**P1（边界与韧性）**
- worktree/branch 删除前查 active session，force 返回 affected
- worktree GC（terminate cleanWorktree）；project.remove cascade
- switchModel `whenRunning`（默认 reject）+ warnings
- whenBusy `fallback` 仅在显式指定时降级；未指定时不把插入悄悄改为排队或打断
- interaction `timeout`/`cancel`/状态 + pending 持久化
- 大文件 `document.prepare_upload`（预签名 URL 断点续传）

**P2（DX/一致性）**
- session.list 分页；capabilities.limits；FormField discriminated union
- skill version/hash/优先级（send>project>global）；compress.strategy server-private 透传

未采纳项见 `BACKLOG.md`（审计表、只读租户独立模型——后者并入 policy 的 allowedMethods）。

## v0.4 收口（L3 编排协议 review，2026-06-23）

GPT 落了 0.3.0 的 L3 协议骨架后，万万对协议做了一次 review，三家共识修正：

**P0（避免后期返工）**
- **stream / workflow 不再两套流**（P0-1）：`StreamEventBase` 加 `workflowId / nodeId / role` 可选字段；workflow node 创建的 session 由 phonon 自动 decorate；workflow.event 仅承载 status/route/decision 元事件，**删除 `node.stream` 事件类型**。
- **节点终态自带产物**（P0-2）：`WorkflowNodeRuntime.result: {text, status, usage}`；DAG 下游 ready 时自动注入上游 `result.text` 到本节点 input。
- **workflow.event 也有 ack**（P0-3）：新增 `workflow.ack` notification，TS/Python SDK 自动 ack，复用 outbox 管理思路。

**P1（趁早定型）**
- **executor schema 不重复定义**（P1-4）：`WorkflowExecutorNode = WorkflowNode.extend({role: literal("executor")})`，跟随 WorkflowNode 演进不漂移。
- **RoutingDirective 协议形态**（P1-5）：executor 用 fenced block `phonon.workflow.route` emit 路由指令，phonon 解析升级成内部动作；任何大模型都能用（延续 D22）。
- **WorkflowRunParams.policy**（P1-6）：`{timeoutSeconds, perNodeTimeoutSeconds, onNodeFailure, maxParallel}`，全 optional，默认 `onNodeFailure=fail_workflow`。

**P2（DX/能力声明）**
- `AgentCapabilities.workflowRoles?: ("executor"|"worker")[]`（P2-9）：6 个 adapter 已按各自能力填值。
- `workflow.list` 加 `projectId / since / until` 筛选；`workflow.status` 增加 `finalText`。

**实现状态**：协议 + WorkflowEngine + TS/Python SDK + tests 同步落地；test-server 90/90 全过。


## v0.5 收口（Foreman 借鉴 + 共享上下文/Discussion，2026-06-23）

万万 review 了 Foreman 项目的编排实现（DAG executor + group_study + discussion + checkpoint），与 Stephen 对齐后落实：

**采纳（4 项）**
- **RoutingDirective 升级为 4-kind 判别联合**（借鉴 1）：`workflow.route`（派活，原语义） / `workflow.feedback`（显式返工修订，phonon 自动加 `[FEEDBACK / REVISE]` 标记） / `workflow.reply`（应答 agent 卡住的交互提示，如 `Y`/`n`） / `workflow.done`（显式宣告完成 + finalSummary）。原 `terminate: true` flag 被 `workflow.done` 取代。
- **Checkpoint + Resume**（借鉴 2）：workflow 状态落 sqlite（新增 `workflows` 表）；`WorkflowRunParams.resumeFrom = { workflowId, strategy: "failed_node" | "last_success_dependents" | "node:<id>", rerunNodes? }`；`WorkflowStatusResult.resumable` 标记当前 workflow 是否可恢复；`WorkflowRunResult.resumed` 标记本次是否走 resume 路径。
- **SharedContext**（借鉴 3）：`WorkflowRunParams.sharedContext = { text?, files?, placement: "prepend"|"append" }`，phonon 在每个 node 的 `session.create` 时拼到 systemPrompt；文件路径受 workspace 沙箱保护，读不到的文件静默跳过。**协议层不叫 SSOT**（Foreman 那个 SSOT.md 实现已被弃用，名字不沿用）。
- **Discussion plan mode**（借鉴 4）：新增第三种 plan mode（与 dag/graph 并列），N 个 participant 平等多轮发言 + 指定 chairman 控场审视。`termination = { chairmanSignal: "[DISCUSS_END]", maxRounds, consensusSignal? }` 三选一。新增事件类型 `round.started / round.completed / discussion.terminated`。

**不采纳（2 项，phonon 解耦）**
- ❌ Category（借鉴 5）：上层服务自己映射 role↔category↔model，phonon 不感知。但协议层**保留 `role` 字段说明**作为 agent 当前在 workflow 中扮演角色的透传通道。
- ❌ Wisdom 累积（借鉴 6）：上层服务通过适当 agent 编排实现，phonon 不内置。

**核心原则**：phonon 提供通用底层能力，上层服务实现具体业务功能。

**实现状态**：协议 + WorkflowEngine + sqlite store + tests 同步落地；test-server **95/95 全过**（90 旧 + 5 新增：done directive、feedback directive、discussion chairman 终止、sharedContext.text 注入、resume 失败节点）。


## v0.9.0 — L4 Scheduling（定时任务 / Automation，2026-06-30）

新增 18 个方法（63 → 81），device-authoritative 定时任务调度。详见 `docs/L4_SCHEDULING.md`。

**核心**：调度真相在 device（本地 cron 时钟 + 本地表，离线自治）；一个 run = 一次 L1 session（复用 stream.event / v0.8.7 transcript 快照 / 主动推送）；webhook 是 trigger 的一种（与 cron/manual 并列）；consent 三档（full/summary/status-only）控制 run 结束后推送粒度。

**s2p（server 控制 + 观测）**
- 管理：`schedule.create` / `schedule.update` / `schedule.delete` / `schedule.list` / `schedule.get` / `schedule.enable` / `schedule.disable` / `schedule.trigger`
- 观测：`schedule.runs.list` / `run.get` / `run.events.subscribe` / `run.events.unsubscribe` / `run.cancel`
- ack：`schedule.ack`（notification，平行 stream.ack）

**p2s（device 镜像 + 推送）**
- `schedule.changed`（schedule 变化含 nextRunAt） / `run.started` / `run.event`（订阅才推） / `run.finished`（按 consent 裁剪）

**安全**：每 schedule 独立 webhookToken（默认脱敏，仅 create 返回一次 / reveal 才给）；webhook 触发的 run 同样过 device consent/policy 门。

**v1 范围**：runKind=session 已实现；runKind=workflow 保留接口位（报 errCapabilityUnsupported）。webhook 的 server 端 HTTP 入口待 server SDK 暴露（core 已有 triggerByWebhook）。

**实现状态**：协议 + SchedulerEngine + cron 解析器 + sqlite store（schedules/runs 两表）+ TS/Python SDK + tests 同步落地。fn-cron(9) + fn-scheduler(8) + e2e-scheduler(3) 全过；全量回归 functional 128 / e2e 29 / protocol 50 全绿；真实挂钟 cron + webhook 端到端实跑验证通过。


## 多格式维护配置与文本编辑

本地注册的 `format` 为 `json | jsonc | yaml | toml | text`，旧 `json` 注册及
`maintenance.config.patch` 参数保持兼容。`get` 返回 format、原始字节 SHA、脱敏 value；
`text` 只有本地所有者显式注册 `textVisibility: "public"` 且保守扫描无疑似秘密时才返回，
否则省略 text 并返回 `textWithheld: true`。public 是该文件的所有者声明，不是自动秘密探测保证。
普通 text 不返回结构化 value；必须同时显式 `writable: true`、`wholeFileWritable: true` 和
`textVisibility: "public"` 才可编辑，仅授权这一条既有文件，不允许任意路径或整个 HOME。

| format | get/diagnose | merge patch | exact edit |
| --- | --- | --- | --- |
| json | 严格 JSON；拒绝重复键 | RFC7396，jsonc-parser 局部节点修改 | public 文本；写前 parse |
| jsonc | JSON + 注释/尾逗号；拒绝重复键 | 同上，保留未涉及的注释 | 同上 |
| yaml | 单文档 core schema，string mapping keys | 仅 plain mapping root；安全 Document API | 同一安全 YAML 子集，public 文本 |
| toml | smol-toml，保留本地 date/time/bigint 类型 | **不支持**，明确要求 edit，不 stringify | 精确替换并重新 parse，其他字节不动 |
| text | 有界有效 UTF-8；不作领域语法校验 | 不支持 | public + whole-file 授权 |

YAML 禁止显式 tag、自定义构造、merge key、多文档和别名（预算 0）；节点预算 20,000，
深度 64。不支持的输入明确失败，不静默丢弃内容。YAML patch 保留注释，可能规范化引号、缩进及集合样式；
尽量保留 BOM、CRLF 与末尾换行状态，**不承诺 patch 的未修改文本逐字节相同**。
需要字节局部性时使用 public exact edit；带秘密文件的 text 始终保守隐藏，exact edit 拒绝，改用 server 原值 merge patch。
JSON/JSONC patch 采用叶节点源文本编辑；新增/删除节点可能调整附近空白。数组整体替换，null 删除 mapping 键，
不是 TOML null，也不是数组元素逐项删除。
TOML 的日期/本地时间、大整数及非有限数在 value 中使用 `$tomlDate`/`$tomlInteger`/`$number` 诊断投影；
该投影不是写入格式，不得 JSON 序列化后覆盖 TOML。

`maintenance.config.edit` 参数：
```json
{"targetId":"fixture","configId":"main","expectedSha256":"<get 返回的 SHA>","edits":[{"oldText":"before","newText":"after"}],"reason":"authorized repair","clientRequestId":"unique-request-id"}
```
1–100 项替换始终匹配**同一原始版本**，每项 oldText 非空且只能出现一次，区间不重叠；
匹配 0/多处、非法 Unicode、`***` 占位、语法错误、过期 SHA 都不写。不会把 redacted text 整篇写回。
结构化 edit/patch 都对解析前后的根键及嵌套语义差异检查 `allowedRootKeys`，包括删除和新增；
rollback 也重新检查当前注册的根键权限。不会借 exact edit 更改其他 root 或 Rescue 自身 policy/maintenance 授权。

文件限制：最多 1 MiB，拒绝非普通文件、非法 UTF-8、NUL 和二进制控制字符；exact edit 只更改匹配区间，
保留其他 UTF-8 字节、BOM、CRLF、换行。所有写入先完整 parse，再保存私有原始字节 backup，以同目录 temp+rename
原子替换；不支持原子替换的平台报错，绝不退化为部分 copy-over。备份后再检查当前 SHA；同 broker 同路径串行。
这不是对不受控外部写者的文件系统原子 CAS 保证。无变化返回 changed=false，不创建备份。
写结果包含 format、previousSha256、sha256、changed，发生改变时附 backupId；回滚使用 current SHA，校验备份 checksum，
恢复原始字节并建立可逆备份。

TS：`device.maintenance.configEdit(params)`；Python：
`device.maintenance_config_edit(target_id, config_id, expected_sha256, edits, **opts)`。
Rescue 四协议均提供 `edit_config` array-of-objects schema；Gemini 原 patch 的 JSON 对象字符串转换保留，
edit 没有任意 additionalProperties，使用正常 array schema，经相同本地 Zod 与 policy 校验。
新默认注册 Hermes `~/.hermes/config.yaml` 和 Codex `~/.codex/config.toml` **只读、text hidden**。
已有持久注册不会自动扩权，Agent/maintenance/policy 自身仍不可由 Rescue 重写。

## Workflow Skill Selection

`WorkflowNode.skills` now carries the bounded `SkillSelection[]` used by
`session.send`, including optional exact `revision` and `installationId` pins.
The receiver validates pins before model invocation; they cannot change tenant,
Project ownership, policy or human decisions. All workflow modes and workflow
schedule persistence retain node selectors. Changed retries retain normal
request-hash rejection rather than adopting another installation.

Check `device.info` flags `workflow_skill_selection_v1` and
`pinned_skill_selection_v1` before using these fields with older receivers.
Current SDK helpers fail closed and snapshot new-feature packets before their
capability read. Critical commit-to-send controllers must prepare that read
before their dispatch claim. Details and evidence: `WORKFLOW_SKILLS.md`.
# Controlled Workspace Provisioning

`project.provision` and `project.provision.status` provide native controlled-root
directory preparation and original-receipt observation, not a general filesystem
path or account administration API. The mutator accepts exactly UUID retry key,
display name and expected receiver UUID; status accepts the two identities.
`device.info` advertises `project_provision_v1` / `projectProvisionReceiverID`
only when explicitly host-enabled and a qualified exclusive-creation helper is
available. Both SDKs preserve the new contract; raw controllers must prepare
capabilities before their own durable claims. Unknown filesystem outcomes never
auto-replay. See `PROJECT_PROVISIONING.md` for lifecycle, metadata-only status
repair, default-off policy, Windows refusal and incomplete release/device gates.
