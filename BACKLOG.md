# agent-phonon — BACKLOG

> 暂不采纳 / 延后处理的设计点。来自多家 AI 模型的协议 review（2026-06-19）。
> 记录原因，待真实需求出现或进入相应阶段再做。不在当前收口轮次实现。

## 延后（有价值但非当前阶段刚需）

### B1. 操作审计表 audit_logs（Gemini#1）
- **内容**：sqlite 记录哪个 tenant 的哪个 session 何时对哪个 project 做了什么（装 skill、删分支、改文件…），形成本地证据链。
- **为什么延后**：Phase 1 是验证骨架能跑通，审计是多 tenant 协作成熟后的运维需求。等真有多 tenant 同项目协作冲突时再做。
- **触发条件**：出现多 tenant 共享项目的实际冲突 / 需要事后追溯。

### B2. 只读租户 readonly tenant（Gemini#1）
- **内容**：tenant 权限等级 readonly|readwrite，readonly 拦截所有写操作。
- **为什么延后/并入**：与 P0-1 的本地 policy 重叠。倾向用 P0-1 的 `allowedMethods` 表达只读，不单开一套权限等级模型，避免两套授权打架。
- **处置**：并入 P0-1 tenant policy 的 `allowedMethods`，不单独实现。

## 已并入其他项（不单独做）

- **skill 全量结构化**（GPT#7）：`session.send` 的 skills 暂保留可传 name（简单场景），需要时才升级成 `{name,version,scope,force}` 对象。已在 P2-12 部分采纳（加 version/hash + 优先级），不一上来全量结构化。
- **switchModel warnings**（Minimax 取舍）：并入 P1-8，`switchModel` 结果加 `warnings[]`，adapter 发现潜在不兼容时填。

## 决策原则（why this backlog exists）

Phase 1 目标 = **验证「拨出→discovery→建项目→create→send→流式→interrupt→terminate」骨架能真跑通**，不是发 1.0。
- 「补了不返工」的（安全 policy / turn 终态 / 幂等 / ack）→ 现在做。
- 「完备性/企业级」的（审计、权限等级、全套 limits）→ 钩子预留或 backlog，按需填充。
- 不把 Phase 1 做成 Phase 3。

## 下一阶段候选能力

这些是下一阶段要评估/实现的能力，不塞进当前协议收口轮次。

### N1. 任务编排层（Phase 2）
- **内容**：在单 session 能力之上增加任务级编排：一个任务拆成多个 step / 多个 agent / 多台设备协作，支持依赖、状态、重试、汇总结果。
- **定位**：这是 agent-phonon 的下一阶段核心，不在当前 Phase 1 基础协议里做。
- **备注**：底层应复用现有 session/project/stream/HITL 能力，不重写 L1。

### N1b. 中央「大脑」/ 编排指挥中心 + 可演化 Persona Registry（Phase 2，与 N1 同一个东西）
> 来源：2026-06-30 Stephen 看到 The Agency（`msitarzewski/agency-agents`，MIT）后提出分层设想；2026-08-09 按最新代码复查并补全。复查时该项目约 14.0w star、255 个源角色、17 个部门，并有独立桌面安装器。结论：值得借鉴，但只放在 phonon **上层**，不焊进设备。

- **核心判断**：persona/角色是**数据/策略**，不是机制。phonon daemon 要保持「薄 + 诚实 + 只暴露真实能力」；persona 变化极快（每个任务都可能定制），daemon 必须稳。把快变内容焊进慢变基础设施 = 反模式。
- **为什么不放设备**：焊在每台设备的 daemon 上 → N 台 N 份拷贝，改一次同步 N 次，立刻「死」且漂移。放中央大脑 → 单一事实来源，热编辑、可版本化、可按任务 fork 临时变体，设备侧零改动。
- **分层**：The Agency 提供「角色内容资产」；phonon 提供「身体+神经」（稳定执行底座）；大脑做「中枢」（实时调度 + persona 管理 + 按任务定制）。大脑 ≈ N1 任务编排层，Persona Registry 是它的子系统，不是全新概念。
- **The Agency 的准确定位**：它是结构化 Persona/Prompt 内容库 + 多工具格式转换器 + 安装器，**不是**多 Agent 编排引擎、持久记忆、任务状态机、跨设备控制面或自动演化系统。不要被其 `production-ready` 文案替代真实 eval 证据。

#### 可直接借鉴

1. **Canonical Persona Schema**：身份/性格、使命、范围与非目标、沟通方式、关键规则、工作流、输入/输出契约、交付物、成功指标、工具/权限需求、上下文需求、示例。
2. **Persona Compiler**：一份 canonical source 按目标 runtime 编译成 OpenClaw、Claude Code、Codex、Copilot、OpenCode 等格式；修改一次，所有目标同步生成，避免设备/工具间漂移。
3. **内容治理门禁**：schema lint、重复角色检测、原创度/来源检查、目录一致性、多目标转换检查；在此基础上增加行为 eval、安全 eval、token 成本和版本回归。
4. **角色市场 UX**：浏览、搜索、分类、查看权限/成本/效果、fork 私有版本、编辑、试运行、比较、发布、回滚。可借鉴其桌面 App 的「浏览→选择→安装→更新」，但升级为中央管理而非复制静态文件。
5. **首批角色种子**：优先精选 10–20 个高价值角色（产品、架构、UI、前后端、review、安全、测试、SRE、技术写作、Minimal Change、Reality Checker 等），不要把数百个角色全量塞进上下文。

#### 我们必须补上的能力

- **动态检索与组装**：大脑先理解任务，再检索候选角色；只注入本次任务需要的片段。The Agency 角色平均很长，全量加载会造成上下文膨胀、路由混淆和角色重叠。
- **版本化与可追溯**：每个 persona 有稳定 id、version/hash、provenance、license、change history；每次任务记录实际使用版本，支持回放与回滚。
- **效果闭环**：把任务结果、review、用户反馈、成本与失败原因关联到 persona 版本；支持基线、A/B、回归测试和有证据的演化，而不是只改 Markdown。
- **角色边界治理**：区分硬规则、可配置默认值、经验建议和待验证假设；避免把未经验证的具体数字/经验写成普遍定律。
- **编排闭环**：理解意图 → 拆任务 → 选 persona/agent/model/device → 执行 → evaluator/reviewer 验收 → 反馈更新。The Agency 只提供中间的角色内容，不提供整个闭环。

#### 设计约束（开发大脑时必须遵守）

1. **大脑经现有协议注入 persona，不往设备装文件**：复用 `session.send` 的 skills/context（具体协议形态开发时核对），建会话/每任务时动态注入；保证大脑与 phonon 解耦，phonon 继续当薄底座。
2. **persona 带 version/hash，大脑决定每任务用哪版**：任务执行记录必须能回答「哪个角色的哪一版导致了这个结果」。
3. **设备最终否决权不可绕过**：大脑下发的 persona 不能覆盖 phonon 设备侧 tenant / HITL / allowExec / local policy；双层防线不因增加大脑而失效。
4. **大脑是独立服务**（Stephen 明确：单独建设多设备指挥中心）；Web、iOS、Figma 4 AI 等是同一大脑和连续数据流上的角色化界面，不各自复制 persona。
5. **合规复用**：The Agency 为 MIT，可作为初始种子，但导入时保留来源、许可证与修改记录；不要把上游内容无来源地内化成自有资产。

- **触发条件**：进入 Phase 2 开发中央大脑时启动。先定义 Persona Schema + Registry + Compiler + Eval，再精选导入 The Agency 角色；不要先复制全部角色。

### N1c. 自由讨论（无控场者的多 agent 群聊）— Group / ChatRoom 抽象（Phase 2 协议前置依赖）

> **状态：仅记录，尚未开发。** 2026-10-10 Stephen 确认「自由讨论先写入 backlog，后面再开发」。
> 检索词：`自由讨论` / `free discussion` / `群聊` / `chatroom` / `group`。
> 能力名 = **自由讨论**（用户视角：几个 agent 在一个群里自己聊，没人拍板）；
> 机制名 = **Group / ChatRoom 抽象**（实现视角：一个 groupId 持有多个 session + 共享时间轴）。
> 两者是同一件事的两种视角，不是两个需求。

> 来源：2026-09-23 Stephen 在 AgentSphere 上看到「AgentFunction 星型被动编排」问题后，明确提出「多 agent 能不能不走 A2A，直接在 phonon 内部通信」的需求。2026-09-24 明确容器形态：**Group / ChatRoom**，不是 shared session。
>
> **2026-09-24 补**：Stephen 提醒 phonon 早就有「一起聊」的能力（v0.5）。具体是 **`WorkflowDiscussionPlan`**（`packages/protocol/src/schemas/workflow.ts:122`）—— N 个 participant 平等多轮发言 + chairman 控场 + barrier 同步 + checkpoint resume + consensusSignal / chairmanSignal 终止。本条目是 **Discussion 之后的下一跳**，不是从零起。详见下方「已存在的能力」段。

**为什么不走 shared sessionId**（决策记录，避免反复讨论）：
- session 是「一个 agent 的一次连续对话」——这个不变量不能动；动了 `terminat / compressNative / compressCustom / interrupt / switchModel / switch session 身份` 全部歧义。
- adapter 的 native session（claude-code `--resume` / hermes session_id / codex thread）也只属于单个 agent。
- 「同一个 sessionId 上挂多 agent」会把这个 1:1 不变量打碎，调试/续接/audit 全部变难。

**为什么不是 A2A**（同样决策记录）：
- A2A 每个 agent-to-agent 调用是 HTTP/JSON-RPC round-trip；同信任域内是纯 overhead。
- A2A 引入跨进程 trace 与 OAuth；现有 tenant/policy/audit 体系足够。
- 跨组织场景：让 **N1 大脑层接 A2A**，不放在 daemon 层（daemon 是控制面，不是协作面）。

**正确抽象：Group / ChatRoom**（类比 Slack channel、Matrix room、微信群）：

### 已存在的能力（v0.5 Discussion plan mode，不要重复造）

> 2026-09-24 Stephen 提醒后核实：phonon 已有「多 agent 一起聊」。**别把它当空白需求重做。**

- **协议层**：`WorkflowPlan = WorkflowDagPlan | WorkflowGraphPlan | **WorkflowDiscussionPlan**`（`packages/protocol/src/schemas/workflow.ts:144`）
- **Discussion plan 字段**：`topic` / `participants[].nodeId+agent+model+role`（≥2 个，无主从）/ `chairman`（必须是 participants 之一）/ `termination = { chairmanSignal: "[DISCUSS_END]", maxRounds: 10, consensusSignal? }`
- **执行机制**（`packages/core/src/workflow-engine.ts:1186 executeDiscussion`）：
  - 每轮 participants **并行发言**（`Promise.allSettled` + `maxParallel` 控制并发）
  - **barrier 同步**：本轮全员发完才进 chairman
  - chairman 看完本轮所有发言，决定续/停；输出含 `chairmanSignal` 则终止
  - 任一 participant 输出含 `consensusSignal` 也可自然终止
  - 状态落 sqlite（`workflows` 表），崩溃后能 resume 上一轮
  - 事件：`round.started` / `round.completed` / `discussion.terminated` 三种新事件
- **测试**：`packages/test-server/src/fn-workflow.test.ts:273` 「workflow.run discussion: chairman signal terminates after N rounds」—— 验证多 round + chairman 决定 + event 流
- **使用位置**：在 `workflow.run` RPC 里选 `mode: "discussion"` 即用
- **示例**（实测代码）：3 个 participant (alice supporter / bob supporter / chair chairman) + 5 轮上限 + `[DISCUSS_END]` 终止

### Discussion 缺什么、不够什么（明确差距）

#### 三种已实现模式对照（以免跟现有能力混了）

| 模式 | 控场者 | 结构 | 适用场景 |
|---|---|---|---|
| **dag** | 编译期拓扑 | `nodes + edges + finalNodeId` | 确定性流水线 |
| **graph** | **executor（一个 agent）**发 RoutingDirective 调度 workers | 主从循环，executor 决策 + worker 执行，maxIterations 兑底 | 主从型委托（A 调 B、C） |
| **discussion** | **固定 chairman**控场，N participant 并行发言 | 评审 / 多视角讨论，barrier + maxRounds + chairmanSignal / consensusSignal | 需拍板的评审、决策类 |

**都「有控场者」**——无论是编译期拓扑、executor 还是 chairman。**没有完全自由讨论 / 无控场者的多 agent 模式**——那是 N1c 要补的。

下面是 Discussion **作为「多 agent 群聊」还缺的部分**（不要重新造 Discussion，补足缺口）：

1. **运行时上下文连贯性**：Discussion 里 chairman prompt 里才看见本轮发言，上一轮发言只在 chairman 的 systemPrompt 里。**没有跨轮 stream 订阅**——participant 看不见别人上一轮说了什么，只能看到「同一 round 的其他 participant」。AgentSphere 需要的是 Slack channel 语义（任何人看到所有历史）。
2. **动态加成员**：Discussion 在 `workflow.run` 时定好 participants。**中途加一个 agent 进群**要新建 workflow。
3. **长生命周期**：Discussion 在 `workflow.run` 里跑，结束即释放。**群里 agent 可以留几天**继续讨论——这不是 workflow 语义。
4. **session 是 1:1 adapter**这个不变量保持：Discussion 是每次发言调 `executeNode` → 创建临时 session，结束释放；**不是 group 中驻留的 agent**。这两者不同——group 里的 agent 是「在场成员」，Discussion 的 agent 是「每轮临时调起」。
5. **agent 间主动互问**（A 问 B 「帮我算 X」）—— Discussion 里只能 chairman 控场，没有 agent-to-agent 直接说。

### 真正还要做的（基于已存在能力往上加，不是从零起）

> 下面三个新增是 **Discussion 没覆盖的场景**，跟 N1c 原描述一脉相承。

**正确抽象：Group / ChatRoom**（类比 Slack channel、Matrix room、微信群）：
- 一个 **group** 拥有自己的 `groupId`（也可叫 `chatId`）。
- group = 一组 **member**（`sessionId` 列表）；每个 member session 仍然 1:1 绑定到单个 agent，与今天完全一样。
- group 拥有**共享事件时间轴**：每个 member session 发出的 stream.event 都会 fan-in 到 group timeline。
- member 可以 `group.subscribe(filter)` 看其他人事件；可以 `group.publish(event)` 往时间轴上推事件。
- member 可以动态 `group.add({ sessionId })` / `group.remove({ sessionId })`；一个 agent 退出不影响其他 member。
- session 本身的 lifecycle 不变：terminate 那个 session 只清自己的 native state，group timeline 仍记得他发过什么。

**协议改动面**（一个全新子树，不动 session 子树）：

| 方法 | 方向 | 干啥 |
|---|---|---|
| `group.create` | server→phonon | 建空 group，拿 groupId |
| `group.add` | server→phonon | 把已存在的 sessionId 加入 group（不创建新 session） |
| `group.remove` | server→phonon | 把 sessionId 移除 group；session 本身不受影响 |
| `group.list` | server→phonon | 列 group + 当前 members + 状态 |
| `group.subscribe` | server→phonon | 返回 group timeline 的事件流（可过滤 member / event kind） |
| `group.publish` | server→phonon | 往 group timeline 推一个事件（fromSessionId 必须是 group member） |
| `group.close` | server→phonon | 关 group（不关任何 member session） |
| `group.event` | phonon→server | group timeline 上的新事件（stream 同 `stream.event` 走相同可靠投递） |

成员 session 发出的 stream.event 自动 fan-in 到 group timeline（**不需要每 agent 主动 publish**——这是 daemon 在 stream 分发层做的）。

**典型场景（AgentFunction 摆脱星型编排）**：
```
group.create({ title: "讨论架构" })
  → session.create({ agent: "codex" }) → sessionId=ssn_a
  → session.create({ agent: "claude" }) → sessionId=ssn_b
  → group.add({ groupId, sessionId: ssn_a })
  → group.add({ groupId, sessionId: ssn_b })
  → server 给 ssn_a 发 seed prompt（"帮我分析 X 选型"）
  → ssn_a 跑完一轮后，stream.event 自动进 group timeline
  → ssn_b 能从 group.subscribe 看到 ssn_a 的所有中间事件（thinking/tool_call/result）
  → 编排器只需监听 group.event + 收尾
```

agent-to-agent 「看到」通过 **group timeline** 实现，不是 A2A；成员退出通过 `group.remove`；强边界 = tenant + policy + audit 都按现有规则走。

**不变的部分**：
- session 子树不变（当前 90 个方法不动；sessionId ↔ agent 1:1 保持）
- 不新增协议依赖（不用 A2A/MCP/ACP）
- 不改 model/workflow/schedule/maintenance；中枢大脑另起项目（N1）

**明确不做**：
- 同一个 sessionId 挂多 adapter（违反不变量，明确拒绝）
- daemon 层接 A2A server（重复造轮，且混控制面与协作面）
- agent-to-agent 远程调用 HTTP 化（违反 phonon 是 daemon-控制面原则）
- 跨 daemon 集群的 group（Phase 3+；group 默认是 daemon-local）

**触发条件**：
- N1 中央大脑项目启动后、或 AgentSphere 需要多 agent 在同一群里相互讨论
- 先 PR：`group.create/add/remove/list` + group timeline fan-in（最小可用）
- 再 PR：`group.subscribe/publish/event`（让 server / agent 能消费 group timeline）
- 最后由 AgentSphere / 大脑层使用；不在 daemon 控制面暴露 agent-to-agent 高级 API

**实现预估**：协议 < 250 行（schema + dispatch + outbox 复用）；stream fan-in < 80 行（PhononConnection 层加 hook）；测试 < 250 行。**不需要另立包，在现有 protocol/core 增量上即可。**

### N2. 长期任务 / 计划任务（Phase 2）
- **内容**：支持 long-running job、定时任务、周期任务、延迟任务；任务状态可查询，结果走 stream/notification 回传。
- **定位**：下一阶段做。当前先通过服务端侧调度或 OpenClaw 自身 cron 兜底。
- **设计约束**：不要和 session 混成一个概念；session 是 agent 会话，job/workflow 是任务编排层对象。

### N3. 资源监控（可观测性增强）— ✅ 基础版已完成 2026-06-21
- **内容**：提供设备资源状态查询，方便 agent 执行异常时 debug：CPU、GPU、内存、磁盘空间、进程/子进程状态、必要时包括负载和最近 OOM/退出信息。
- **定位**：属于可观测性，不是资源调度/资源限制。**资源管理/调度先不做**。
- **可能协议形态**：`device.status` / `device.resources` / obs endpoint 扩展；具体命名下一轮设计时定。

### N4. 本地文件读写能力（优先级高于权限细化）— ✅ 基础版已完成 2026-06-21
- **内容**：服务端需要能对本地磁盘上的受控目录做基础文件操作：读文件、写文件、列目录、创建目录、删除/移动/重命名（是否包含删除需再确认）、读取 metadata/hash。
- **边界**：必须受 project/worktree/root policy 约束，默认限制在 project/worktree 内；不能变成任意路径读写。
- **和现有 document 能力区别**：`document.send` 是 agent 主动把产物/文档发给服务端；文件读写是 server 主动操作本地工作区。
- **需要设计的问题**：大文件读写走 chunk/prepare_upload 还是直接内容；是否支持 patch/diff；写入冲突如何处理；是否必须经过 Git diff 审计。

### N5. 文件同步 / 产物管理不单独做，统一走 Git — ✅ 已写入设计决策 D35
- **决策**：文件同步、产物版本、diff、改动历史，先全部通过 Git/project/worktree 管理，不单独设计一套 artifact sync 系统。
- **后续仅补必要 glue**：例如暴露 git status/diff/commit metadata 的查询能力，可作为 project/git 能力增强。

### N6. 权限模型细化暂不做
- **内容**：更细的只读项目、工具级 allowlist、路径级策略等。
- **决策**：当前先不扩。已有 TenantPolicy 作为基础边界；等真实使用中暴露需要再细化。

## Bug-bash 后延后项（2026-06-20，三家 review 后）

这些是真问题但属"地基工程"，单独一轮做，不在本次修复批次：

### B3. sqlite 持久化（design D6 要求）— ✅ 已完成 2026-06-20
- 现状：sessions/projects/skills/worktrees/outbox/idempotency/pending_interactions 全内存
- 影响：daemon 重启丢所有状态；paused 状态机有但无触发路径
- 表：sessions/projects/skills/worktrees/outbox_events/inbox_queue/pending_interactions/idempotency
- 为什么延后：涉及 daemon 启动/恢复全链路，是独立一轮工程

### B4. Daemon CLI 主包 agent-phonon — ✅ 已完成 2026-06-20
- 现状：只有 PhononClient（单连接）+ library，没有 daemon CLI
- 需要：读 config、管 tenants、启 HookBridge、注册 adapters、连多 server、systemd unit
- 多 server 同时连：PhononDaemon 管理多个 PhononClient

### B5. 其他增强（非阻塞）— ⏳ 部分完成 2026-06-20（可观测性 health/metrics/结构化日志/audit 已做）
- health 端点 / metrics 上报 / 结构化日志（pino，替 console.log）
- 配置热加载 / graceful shutdown（SIGTERM 等 turn 完成）
- custom 压缩引擎真实现（现在 mode=custom 明确报 errCapabilityUnsupported）
- url skill 安装完整安全实现（https+sha256+大小限+Zip Slip 防护；现在默认 policy 拒）
- plugin debug 日志降噪（改 debug 模式）/ plugin 默认只拦 phonon sessionKey prefix
- HookBridge sessionKey→sessionId 用 registry 而非正则

### R1. Review 跟进项 — ✅ 本轮完成 2026-06-22
- custom 压缩补齐 Codex/OpenCode/Hermes：3/6→6/6 provider 支持 dropToolIO（D7 更新）
- dropToolIO keep-recent 改为按「tool call 锚点」位置计算，修复无 id 的最近 tool 块被误删
- env 变量 at-rest 加密：AES-256-GCM + device.key(0600)，老明文平滑迁移（D37）
- file.* sandbox symlink 逃逸修复：realpath containment + lstat 不跟随（D37）
- ⏳ 仍未做：env reveal 的更细审计、Hermes/OpenCode 压缩在「会话正被 agent 进程并发写」时的强一致（现靠 busy_timeout + VACUUM INTO 备份兜底）
