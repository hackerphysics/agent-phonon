# agent-phonon — Design (v0, 架构对齐版)

> 本文是**架构级共识**，不陷入实现细节（细节开发中逐步讨论并补充）。
> 状态：🚧 design agreed；protocol 包已实现（30 方法 + zod schema + 测试），adapter/core 待开发。Private repo.

---

## 1. 定位与核心类比

phonon 是一个**部署在单台个人设备上的 agent 调度 daemon**：对下统一调度本机的多种 AI agent，对上用**一套统一协议**主动连到服务端，让任何遵循该协议的服务端把任务分发下来、远程使用本机 agent。

**脊柱类比（贯穿全设计）：**

```
phonon : 服务端    ＝    OpenClaw-gateway : 飞书
```

- phonon 拿一个 **device key**，**主动拨出**连接到有公网 IP/域名的服务端（设备在 NAT 后，反向长连）。
- 服务端像飞书：负责**终端用户鉴权/登录**、把「活」推下来、承接「人在回路」交互。
- phonon **不负责鉴权登录**，只管：连上去 → 调度本机 agent → 把结果流回去。
- **server-agnostic**：只要遵循协议，任何服务端都能接。phonon 不绑定特定服务端。
- **多服务端/多租户**：phonon 可**同时**连多个服务端（每个 = 一条独立拨出连接 + 独立 device key），彼此**底层隔离**。恰如 OpenClaw-gateway 同时连飞书/TG/Discord 多 channel 且互不串。配置驱动，CLI 管理。

---

## 2. 分层架构

```
L3  多-agent 编排 (任务级)        ← Phase 2；底层复用 L1，不另起炉灶
        ↑
L2  统一协议 + 双向连接层            ← Phase 1 核心；**tenant 在此定义、拥有与强制**
        │  ├ phonon·conn-mgr ：每条服务端长连 = 一个 tenant（拥有者）
        │  └ phonon·dispatch：校验 sessionId.tenant，跨租户直接拒（强制点）
        ↑
L1  单-agent 会话引擎 (session)    ← Phase 1 核心，session 是一等公民；**不感知 tenant**
        ↓ adapter 层
   OpenClaw / Claude Code / Codex / OpenCode / Hermes
```

- **L1**：与单个 agent 通信，做会话管理 + 上下文管理。**发任务＝在 session 里对话。**只认 sessionId，**不感知 tenant**。
- **L2**：对外统一协议 + 与服务端的双向连接。**tenant 这个概念由 L2 定义并拥有**，内部两个子职责：
  - *conn-mgr*：管理每条服务端长连（= 一个 tenant）、device key、重连、配额——tenant 的**拥有者/定义者**。
  - *dispatch*：收到 server 下发的 `session.*`，在交给 L1 **之前**校验 `sessionId` 是否属于本连接的 tenant——tenant 的**强制执行点**。不符直接拒（`errSessionNotInTenant`），根本不下传 L1。
- **L3**：多 agent 编排（任务级管理，非会话级），**完全建在 L1 之上、复用单 agent 能力**。Phase 2。
- 设计铁律：**L1 的 session 抽象必须足够干净（不含 tenant），L3 编排才能纯复用而非重写；而因为 L3 的调用同样走 L2，tenant 隔离对 L3 也自动生效。**

---

## 3. 决策记录 (ADR)

| # | 决策 | 取舍理由 |
|---|------|---------|
| D1 | **语言/运行时＝Node 22 LTS + TypeScript** | 目标机本就装 Node（agent 都是 Node 系）；可吃 TS-first 的 Claude Agent SDK / MCP SDK / node-pty；LMA(TS) 零迁移复用；zod 给「对外协议」端到端类型闭环。Go 在此场景丢 SDK 还要双端重写，不选。 |
| D2 | **传输＝双向 JSON-RPC 2.0 over 单条 WebSocket** | 真双向：服务端下发 session 操作 / phonon 上推流式结果 + 主动 hook/人交互请求；标准、任何语言服务端都能接。 |
| D3 | **协议形态＝session 会话协议（发任务＝对话）** | 持续性会话为主；一次性任务由调用方主动 terminate 收尾。 |
| D4 | **Hook/HITL＝phonon 只问服务端，服务端独占人交互** | phonon 不实现交互 UI：到 hook 点抛事件→阻塞等服务端裁决→执行。问不问真人、怎么问、等多久全是服务端的事。 |
| D5 | **全自动执行 + hook 拦截** | 默认全自动；主流 agent 的 hook（Codex hooks / Claude Code PreToolUse / OpenClaw 审批）映射成归一化 hook 类型，命中关键操作时触发自定义动作（注入上下文 / 暂停发人）。 |
| D6 | **本地 sqlite 持久化（必须）** | 维护 session 状态与各种元信息；进程重启后能 re-attach 原生 session（Claude Code/OpenClaw 本就可 resume）。 |
| D7 | **压缩双模：native + custom** | native＝透传 agent 原生压缩；custom＝phonon 自有压缩引擎，便于统一自定义上下文管理。第一版 custom 策略为 `dropToolIO`：删除结构化 tool_use/tool_result/tool_call（含 Codex `function_call`/`function_call_output`）内容和返回结果，保留纯文本；默认保留最近 3 个 tool call 及其 result，可用 `keepRecentToolCalls` 配置，因为最近工具上下文通常更重要。保留计数按「tool call 锚点」位置算（非按 id），所以没有 id 的最近 tool 块也能正确保留。已接入：OpenClaw spawn/Gateway + Claude Code（编辑 session JSONL）、Codex（rollout JSONL，按 thread_id 定位）、OpenCode（`opencode.db` 的 `part` 表，删 tool part 行）、Hermes（`state.db`，按 title 定位 session：删 `role=tool` 行、清 assistant 行的 tool_calls 列以保留推理）。sqlite 改动前用 `VACUUM INTO` 一致性备份（正确处理 WAL）、IMMEDIATE 事务、FTS 触发器自动同步。 |
| D8 | **Adapter 声明能力，core 补齐缺口** | 各 agent 厚薄不一：对外协议恒统一，对内 adapter 按 `capabilities` 声明原生支持，core 缺啥补啥。OpenClaw adapter 极薄，CLI adapter 较厚。 |
| D9 | **单设备，不感知其他设备** | 多设备互联由上层服务管理；phonon 装到多台，各管各的。不做设备发现/互联。 |
| D10 | **agent 支持顺序（✅ OpenClaw ✅ Claude Code ✅ Codex ✅ OpenCode ✅ Hermes（全部完成））** | 先搬 LMA 现成代码零迁移跑通。 |
| D11 | **phonon 是独立的底层能力** | phonon 是通用的设备侧 agent 调度底层，其上可延伸更多项目。与其他任何项目无绑定关系。 |
| D12 | **部署＝CLI + systemd 类守护（Linux/Mac）** | Docker 太重且不便调度本机 agent。Windows 无 systemd，后续单独想办法（NSSM / Windows Service / 计划任务，待定）。 |
| D13 | **多服务端 / 多租户，底层硬隔离，配置驱动 + CLI 管理** | phonon 同时维护 N 条到不同服务端的拨出连接，每条一把 device key，构成一个 tenant；session 及所有资源按 tenant 严格隔离（server A 不可见/不可控 server B 的 session）；隔离在 RPC 分发层强制。隔离单元＝「一条服务端连接」。 |
| D14 | **Agent / 模型发现：内部扫描（非协议）+ 对外接口（属协议）** | phonon 自动扫描本机「哪些 agent 可用、各 agent 哪些模型可用」（CLI 是否安装/可执行/已登录）——这部分是内部机制，不算协议；但**对外暴露一个接口**让服务端能查询/感知设备上的可用 agent 与模型；可用性变化时主动推送。 |
| D15 | **session 必须绑定 agent（一等身份）** | session 天生是「某个 agent 的会话」：`session.create` 必须指定 `agent`（来自 discovery 的 agentId）+ `model`；session 全生命周期任何时刻都能查到「这条 session 是哪个 agent / 哪个模型」；持久化表中落 `agent_id` + `model`。 |
| D16 | **会话是可订阅的持续输出流（非纯请求-响应）** | send 后结果**流式**回传；更关键的是像 OpenClaw 这类 session 会**自发输出**（cron/定时/心跳，同一 session 内不定期冒泡），这些也必须能被 server 监测到——像订阅。事件标 `origin: solicited\|unsolicited` + `source`（cron/scheduled/…）；「create 即订阅」，该 session 所有事件自动推给 server。Codex 一次性（流到 result 即止）；OpenClaw 持久冒泡。capability `proactiveOutput` 声明是否自发。 |
| D17 | **同会话可中途切换模型（agent 绑定不变）** | model 可换：某模型不行了就换另一个，同一 session 内生效（`session.switchModel`）；但 agent 绑定仍不可变（换 agent = 另开 session）。capability `modelSwitch` 声明是否支持。 |
| D18 | **双向消息不丢 + 忙碌处理三模式** | 上一轮未结束时新消息进来，`session.send` 的 `whenBusy` 选：**queue**（等待，结束后自动发积压，默认）/ **interrupt**（中断当前 turn，session 存活，需 `session.interrupt` 接口）/ **inject**（下一次 tool call 边界插入，agent 接着处理，靠原生接口或 hook）。结合断线缓冲重放（见 §9），**上行+下行消息都不丢、准确送达**是硬性要求。capability `interrupt` / `injectMidTurn` 声明支持情况。 |
| D19 | **session 状态区分「在执行」与「空闲」** | 状态机：`idle`（活着、空闲、可接 send；create 后初始态、turn 结束/interrupt 后回到这）/ `running`（agent 正在执行一个 turn，带 `currentTurnId`）/ `paused`（重启后待 re-attach 或被显式暂停）/ `terminated`。原来的 `active` 混淆了「在跑」与「空闲」，拆成 idle/running。interrupt 后回 `idle` 而非 terminated。 |
| D20 | **文档交换协议（agent emit 路径，phonon 读盘上传）** | 需要发本地文档时，agent 在输出里 emit 一个指令（`DocumentDirective`，含本地 path，skill 教格式）→ phonon **负责读本地文件** → 打包成附件/其他形式发服务端（`document.send`）。agent 只说路径，读盘+传输由 phonon 兑。 |
| D21 | **人机交互协议（可交互表单/卡片）** | HITL 时或 agent 主动问人，emit 一个**抽象表单定义**（`InteractionDirective`，skill 教）→ phonon→server 渲染给人填（飞书卡片/网页/TG 按钮，服务端决定，复用「甩锅服务端」）→ 人填完原路返回注入回 agent（`interaction.request/response`）。表单只定义抽象字段，不绑定渲染。 |
| D22 | **平面③：agent 主动发起的结构化通道，靠 skill 教格式（不依赖原生 function-calling）** | document/interaction 这类「agent→phonon→server」的主动请求，通过给每个 adapter 配一份 **skill 包**教 agent emit 约定格式（fenced directive block）→ phonon 解析后升级成协议调用。这样**任何大模型都能用**，不靠原生工具调用；是「向下兼容」原则的延伸。 |
| D23 | **项目是 session 的另一个一等身份（目录 + Git），设备级共享、不受 tenant 隔离** | 一个项目 = 一个目录 + Git。**所有 session 必须绑定一个项目（`session.create` 必填 `project`）**，全程携带、落库。agent 服务能创建/管理项目（`project.create/list/get/remove`）。**项目是磁盘上的客观目录，不是某 tenant 私有资源：不同 tenant 都能看到/用同一项目**，在其下各干各的；冲突风险用户自担。（tenant 隔离的是会话/任务，不是文件系统。）`project.remove` 默认只解绑不删盘，`deleteFiles:true` 才删物理目录。 |
| D24 | **Skill 装/卸，global | project 两级 scope，每个 agent 独立** | 给指定 agent 安装/卸载 skill（`skill.install/uninstall/list`）；scope=`global`（agent 全局，装到 runtime 全局 skill 目录）/ `project`（需 projectId，装到 **`<project>/.agent/skills/`**，runtime 无关）。每个 agent 靠 capability `skillManagement` 声明是否支持。source 支持 inline files、archive tar.gz（base64+sha256，多文件正式分发方式）、localPath；url/archiveUrl 后续再做。 |
| D25 | **项目支持 git worktree 与分支操作** | `project.worktree.create`（基于某 branch 建 worktree，可同时新建分支）/ `project.worktree.list` / `project.worktree.remove`（清理，默认不强制）/ `project.git.deleteBranch`（删合并分支，默认只删已合并）。worktree = 同仓多工作目录，天然适配「多 tenant/session 在同项目各干各的」；`session.create` 可选 `worktreeId` 指定跑在哪个 worktree。 |
| D26 | **执行时可指定 skill** | `session.send` 可传 `skills:[名]`，phonon 保证：(1) 该 skill 在 agent 能访问到的位置（未装则临时就位）；(2) 在上下文注入一条「强制加载该 skill」指令，让 agent 本轮务必用它。复用 inject 能力。 |
| D27 | **本地安全策略（设备主人的授权边界，非用户鉴权）** | phonon 不做终端用户鉴权，但必须有设备主人配置的本地 policy，否则任意接入的 server 能让本地 agent 读任意文件/装任意 skill/删 worktree。每 tenant 一份 `TenantPolicy`：`allowedProjectRoots / allowedAgents / allowedMethods / allowGlobalSkillInstall / allowUrlSkillInstall / allowDeleteFiles / allowExternalDocuments / allowEnvReveal / maxUploadBytes / denyPathPatterns`。默认最严格（写操作全关、白名单空、敏感路径黑名单）。`document.send` 默认 project-scoped；`skill.install url`、删盘、全局装 skill 默认拒。违反回 `errPolicyDenied`。只读租户用 `allowedMethods` 表达，不单开权限等级。 |
| D28 | **幂等：改状态请求带 clientRequestId** | server 断线重发同一请求不应让 agent 收两遍。`session.send/create`、`project.create`、`worktree.create` 等改状态请求可带 `clientRequestId`，phonon 据此去重；重复回原结果或 `errDuplicateRequest`。这是「双向不丢（D18）」的另一半：不丢 + 不重。 |
| D29 | **可靠投递闭环：stream.ack + 重连 resume** | 之前 outbox 重放「只写了一半」。补：`stream.ack{lastSeq}`（server→phonon，确认已收 seq≤N，phonon 据此清 outbox / 控背压）；重连时 `connect.hello.resumeFrom`（phonon 告知未 ack 起始 seq）与 `welcome.ackedSeqs`（server 告知各 session 最后收到的 seq）双向对齐，从å outbox 精确补发。 |
| D30 | **interaction 生命周期：timeout/cancel/状态 + 持久化（P1-5）** | `interaction.request` 加 `timeoutSeconds`（0=不超时，人可能去开会/带娃）；状态 pending→submitted|cancelled|timeout；新增 `interaction.cancel` 主动取消。发出即落 sqlite `pending_interactions`，重连握手时 re-sync，人填完数据重入 session 不丢。 |
| D31 | **大文件走 HTTP 凭证上传（P1-6）** | `document.send` 不走 WS 发文件主体（内存暴涨/断线重传痛）：`document.prepare_upload{filename,size,sha256}` → server 返预签名 URL → phonon 本地 HTTP PUT（断点续传）→ 上传成功用 ref 关联。小文件仍可 inline。 |
| D32 | **runtime vs agent：一个 runtime 可含多个 agent** | adapter 管的是 **runtime**（OpenClaw/Hermes/Codex/Claude Code/OpenCode）；对外暴露给 server 选的是 **agent**。单 agent runtime（Codex/Claude Code/OpenCode）= runtime 本身一个 agent；**多 agent runtime（OpenClaw/Hermes）按 workspace 枚举多个 agent**。agentId 复合形式 `<runtime>:<subAgent>`（如 `openclaw:main` / `openclaw:phonon`）。`adapter.discoverAgents()` 返回多个；session.create 按复合 agentId 选，registry.resolve() 按 runtime 前缀路由。OpenClaw 用 Gateway `agents.list` RPC 枚举子 agent。 |
| D33 | **发布策略＝单仓库，多包独立发布** | agent-phonon 保持一个 monorepo，便于 protocol/core/SDK/console/test-server 同步演进和跨语言 e2e；但面向用户的模块作为独立 npm/PyPI 包发布：`agent-phonon` daemon、`@agent-phonon/protocol`、`@agent-phonon/server-sdk`、Python SDK、`@agent-phonon/console`。用户按需安装包，不需要关心仓库结构；等协议/API 稳定且 SDK 发版节奏独立后，再考虑物理拆仓库。 |
| D34 | **设备信息用于调度，资源监控属于可观测性，不做资源调度** | 暴露 `device.info` 提供 OS/机器信息与调度标签（如 macOS→iOS 开发、Windows→桌面开发），服务端可按需派活；暴露 `device.resources` 用于 debug agent 执行异常：CPU/内存/磁盘/进程/GPU best-effort。只监控，不做 CPU/GPU/内存的调度、限制或抢占；资源管理留到真实需要时再设计。 |
| D35 | **服务端需要受控文件读写能力，文件同步/产物管理仍走 Git** | `file.read/write/list/stat/mkdir` 允许 server 主动操作 project/worktree 内文件；与 `document.send`（agent 主动发产物）区分。所有路径必须限定在 project/worktree 根内，禁止任意路径读写。文件同步、产物版本和 diff 仍统一交给 Git/project/worktree，不另做 artifact sync 系统。 |
| D36 | **Skill 依赖的环境变量独立配置，不随 skill 包分发** | 有些 skill 需要 API key/token 等环境变量；安全起见，skill 包只包含代码/说明，环境变量走 `env.set/list/delete` 单独配置。scope 支持 global/project/skill；查询默认脱敏，只有本地 policy `allowEnvReveal` 才允许 reveal 明文。执行时按 global < project < skill 优先级合并注入 adapter 子进程环境。 |
| D37 | **env 变量 at-rest 加密 + 受控文件读写沙箱（realpath）** | env 变量值落 sqlite 前用 AES-256-GCM 加密（每条独立 IV，前缀 `enc:v1:`），设备密钥存同目录 `device.key`（0600，与库分离、不入 git）；老明文值无前缀→读时原样返回，平滑迁移。`file.*` 沙箱不能只做字符串前缀判断（in-project symlink 如 `evil→/etc` 会逃逸）：必须 realpath 解析最深已存在祖先再做 containment 校验；`stat` 用 lstat 不跟随最终软链（仍可上报 type=symlink），`list` 用 lstat 不递归进软链目录。 |

---

## 4. L1 — Session 协议原语

> **铁律：session 必须绑定 agent（D15）。** 每条 session 天生属于某个具体 agent + model，这是 session 的**一等身份**，不是可选配置。

服务端 → phonon 调用（均经 L2 下发）：

| 操作 | 入参（要点） | 出参 |
|------|-------------|------|
| `session.create` | **`agent`（agentId，必填，来自 discovery）、`model`（必填）**、`agentConfig`、`initialContext`、`verbosity` | `sessionId`（含回显绑定的 `agent`/`model`） |
| `session.send` | `sessionId, input` | ack(`turnId`)；结果走 `stream.event` 异步流式回传 |
| `session.inject` | `sessionId, context` | ack（上下文注入） |
| `session.compress` | `sessionId, mode: native\|custom, strategy?` | 压缩结果摘要 |
| `session.switchModel` | `sessionId, model` | 中途换模型（agent 不变，D17） |
| `session.interrupt` | `sessionId, reason?` | 打断当前 turn（session 存活，D18） |
| `session.terminate` | `sessionId` | ack |
| `session.status` | `sessionId` | 状态/元信息（**含 `agent`/`model` 绑定**） |
| `session.list` | `filter?（可按 agent 筛）` | session 列表（**每项带 `agent`/`model`**） |

**agent 绑定详解**：
- `session.create` 的 `agent` 必须是 **discovery 返回的可用 agentId**（见 §5 Discovery）；传不可用/不存在的 agent → `errAgentUnavailable`。
- `model` 必须在该 agent 宣告的模型列表内 → 否则 `errModelUnavailable`。
- 绑定**部分可变**：agent 不可换（换 agent = 另开 session）；但 **model 可中途切换**（`session.switchModel`，D17）——某模型不行了就换另一个。
- session 状态/列表/持久化中**始终携带 agent 身份**，服务端任何时刻都能知道「这条 session 是哪个 agent 的」。

**订阅模型 / 持续输出流（D16）** — 关键：session 不只是请求-响应，是一条**可订阅的持续输出流**：
- `session.send` 同步只回一个 `turnId` ack，真正内容全走 `stream.event`，按 `turnId` 聚合一轮。
- 输出分两种 `origin`：**solicited**（某次 send 触发）/ **unsolicited**（agent 自发：OpenClaw 的 cron/定时/心跳，同 session 内不定期冒泡）；unsolicited 事件带 `source`（cron/scheduled/…）。
- **「create 即订阅」**：该 session 的**所有** stream.event（含自发）自动推给拥有它的 tenant 连接，无需显式 subscribe。
- 一次性 agent（Codex）流到 `result final` 就停；持久 agent（OpenClaw）即使不 send 也持续往上冒。capability `proactiveOutput` 声明是否自发。
- **每个 turn 必须有明确终态（P0-2）**：`result.status` ∈ completed|interrupted|aborted|failed|timeout；interrupt 后强制补发 `result{final:true,status:interrupted}` 收尾，服务端状态机不悬空。
- **向下兼容**：不支持自发的 agent（`proactiveOutput:false`）不会产生 unsolicited 事件，协议字段闲置、零成本；支持的立即生效。详见 §7 元原则。

**忙碌处理三模式（D18）** — 订阅式 session 的必然衔生问题：新消息进来时上一轮还没结束怎么办。`session.send` 的 `whenBusy`：
- **queue**（默认）：排队，上一轮结束后自动发积压消息。ack 返回 `disposition:queued` + `queuePosition`。
- **interrupt**：中断当前 turn（session 仍存活，区别于 terminate 销毁），再发新消息。靠独立接口 `session.interrupt`；需 capability `interrupt`。
- **inject**：不中断，在下一次 tool call 边界插入输入让 agent 接着处理；靠 agent 原生接口或通过 hook 实现；需 capability `injectMidTurn`。
- **铁律：双向消息不丢。** 不论哪种模式，上行（send/注入）与下行（stream.event）都要么按目的准确送达、要么明确拒绝并告知原因；配合断线缓冲重放（§9）保证不因连接抖动丢消息。

**verbosity（按配置返回多少）** — create 时设定，send 可覆盖，4 档：
`final`（仅最终结果）｜`messages`（每轮消息）｜`tools`（含工具调用）｜`trace`（全量含思考）。

**状态机（D19）** — 区分「在执行」与「空闲」：
```
create ─▶ idle ──send──▶ running ──turn结束/interrupt──▶ idle ──terminate──▶ terminated
重启恢复 ─▶ paused ──re-attach成功──▶ idle
```
- `idle`：活着、空闲、就绪可接 send。
- `running`：agent 正在执行一个 turn，`session.status` 带 `currentTurnId`。
- `paused`：重启后从 DB 恢复、原生 ref 尚未 re-attach；或被显式暂停。
- `terminated`：已结束销毁。
- **interrupt 后回 `idle`（停一下、session 还在），不是 terminated。**

**initialContext / inject / compress** 三者共同构成「统一上下文管理」能力——这是 phonon 相对裸 adapter 的核心增值。

---

## 5. Agent / 模型发现 (Discovery)

> 发现 = **内部扫描机制（非协议）** + **对外查询接口（属协议）**。回答「这台设备上哪些 agent 可用、各自哪些模型可用」。

**内部扫描（非协议）**：phonon 启动时 + 定期/事件触发，通过各 adapter 探测本机 agent：
- 是否安装 / 可执行（CLI 在 PATH、版本）；
- 是否已登录 / 凭证就绪（能不能真跑）；
- 该 agent 可用的模型列表（如 OpenClaw 的 models 列表、Claude Code 可用模型等）。

**对外接口（属协议，server 可调）**：
| 操作 | 说明 |
|------|------|
| `discovery.list` | 返回本设备可用 agent 清单：`[{ agentId, displayName, available, version, models:[...], capabilities }]` |
| `discovery.get` | 某个 agent 的详情（含 capabilities §7） |
| `discovery.changed`（phonon→server 主动推） | 可用性变化时（某 agent 上/下线、模型增减）主动通知服务端 |

- `discovery.list` 返回的 `agentId` 就是 `session.create` 要填的 `agent`——discovery 与 session 闭环。
- discovery 同样**受 tenant 隔离**：可按 tenant 配置「该服务端能看到哪些 agent」（即 D13 提的 per-tenant adapter 启用清单）。
- capabilities（§7）是 discovery 返回的一部分：server 先通过 discovery 知道 agent 能力，再决定怎么用。

---

## 6. L2 — 连接层（多服务端 / 多租户）

- phonon 可**同时**持有 N 个服务端配置，启动时**逐个拨出**、各自独立长连 + 断线重连。
- 每个服务端携**独立 device key** 表明身份；鉴权由服务端做，phonon 不认证终端用户。
- 单条 WS 上跑 **JSON-RPC 2.0**，**两端皆可作 requester**：
  - server → phonon：`session.*` 等操作。
  - phonon → server：`stream.event`（流式结果）、`hook.fired`（hook 触发，见 §8）。

### Tenant 隔离（D13）

```
            ┌─ conn(serverA, keyA) ─ tenant A ─ {sessionA1, sessionA2, ...}
  phonon ──╋─ conn(serverB, keyB) ─ tenant B ─ {sessionB1, ...}
            └─ conn(serverC, keyC) ─ tenant C ─ {...}
```

- **隔离单元 = 一条服务端连接（tenant）**。每个 tenant 拥有独立的 session 集合、资源配额、甚至可独立的 adapter 启用清单。
- **硬隔离规则（在 RPC 分发层强制）**：
  - `sessionId` 全局唯一但**归属某一 tenant**；server A 下发的任何 `session.*` 只能函盖本 tenant 名下的 session。
  - 跨 tenant 访问一律拒绝（返回 `errSessionNotInTenant`）——A 看不到、也动不了 B 的 session。
  - hook/HITL 的 `hook.fired` 只往**该 session 所属 tenant** 的连接上报。
- **资源配额分两级**：全局上限（保护设备）+ per-tenant 上限（防某服务端吃满资源）。
- **身份**：tenant 由本地配置赋予稳定 `tenantId`（与 device key 绑定）；sqlite 中所有 session 记录携 `tenant_id`。

> 设计铁律：**tenant 由 L2 定义并拥有——L2 连接层（conn-mgr）感知、L2 分发子层（dispatch）强制；L1 不感知 tenant。** 隔离裁决在交给 L1 之前完成，L1 拿到的永远是「已过校验的合法 sessionId + 操作」。这样 L3 编排复用 L1 时也天然被圈在某 tenant 内。

---

## 7. Adapter 能力模型

> **元原则（协议向上设计、实现向下兼容）**：协议按**最强 agent 的能力**设计，弱 agent 自然落到它能做到的子集——不报错、不别扭、不多写代码。多出来的能力对不支持者是「沉默的」（存在但不触发，零负担），对支持者是「激活的」（协议价值立即兼现）。这正是坚持 adapter「声明能力 + core 补齐」而不是「假装统一」的原因——假装统一才会在弱 agent 上翻车。以后加新能力都须遵此原则。

adapter 不假装统一，而是**声明原生支持**，core 据此补齐：

```ts
capabilities: {
  nativeSession: boolean        // 原生 session/resume
  nativeCompression: boolean    // 原生压缩（决定 compress mode=native 是否可用）
  contextInjection: boolean     // 原生上下文注入
  proactiveOutput: boolean      // 是否会自发输出（OpenClaw cron=true / Codex=false，D16）
  modelSwitch: boolean          // 是否支持中途换模型（D17）
  interrupt: boolean            // 是否支持打断当前 turn（D18）
  injectMidTurn: boolean        // 是否支持中途插入输入（D18）
  hooks: HookType[]             // 原生支持的 hook 点
  streaming: boolean
}
```

- 原生有 → 转发；原生无 → phonon core 兜底实现（如 custom 压缩、外部 session 注册表模拟 resume）。
- 对外协议恒统一，调用方无需感知 adapter 厚薄。

---

## 8. Hook / 人在回路 (HITL) 模型

**核心：phonon 自己不实现人在回路，只做事件中转 + 阻塞等裁决。**

```
phonon → server :  hook.fired   { sessionId, hookType, payload }   // pre_tool / pre_command / ...
server → phonon :  hook.resolve { action }                          // continue | inject | abort | <human-interaction 载荷>
```

- 服务端决定：是否问真人、用什么渠道（飞书/TG/网页）、等多久 —— 全在服务端，phonon 只在该 session 上挂起等回包。
- 协议只需定义：**hook 事件 schema** + **裁决 schema（含一种 human-interaction 载荷）**。
- adapter 负责把各家原生 hook 点映射成 phonon 归一化 `HookType`。

---

## 8b. 平面③：agent 主动发起的结构化通道（D20/D21/D22）

前面 session.* 是「服务端下发」、stream.event 是「phonon 上推结果」。这里是**第三个通信平面**：agent **主动发起**的结构化请求，路径 `agent → phonon → server`。

```
agent 在输出里 emit 一个 directive（skill 教的 fenced block）
        ↓  phonon 解析
 phonon 升级成协议调用（document.send / interaction.request）
        ↓
      server
```

**为什么靠 skill 而不靠原生 function-calling（D22）**：给每个 adapter 配一份 skill 包，教 agent「需要发文档/问人时，输出这样一个约定格式的 block」。再笨的模型也能 emit 一段约定文本 → **任何大模型都能用**，不依赖原生工具调用。这是「向下兼容」原则的延伸。

### 文档交换（D20）
- agent emit `DocumentDirective`（含本地 `path` + 可选 name/kind/caption）。
- phonon **读本地文件**，封装成 `DocumentDescriptor`（内联 base64/utf8，大文件走 ref 分块）→ `document.send` 发 server。
- server 落地（附件/云文档/其他），回 `serverRef`。「agent 只说路径，读盘+传输 phonon 兑」。

### 人机交互（D21）
- agent/HITL emit `InteractionDirective`（抽象表单：title + fields[] + 按钮，field 类型 text/select/…）。
- phonon → `interaction.request`（带 requestId，blocking 时阻塞等）→ server **自由渲染**（飞书卡片/网页/TG）。
- 人填完 → `interaction.request` result 或异步 `interaction.response`（submit/cancel + values）→ phonon 注入回 agent。
- 表单**只定义抽象字段结构，不绑定渲染**——复用 HITL 的「甩锅服务端」原则。若由 HITL hook 触发，可携 `hookId` 与 hook.resolve 合流。

> 两者的「directive（agent↔phonon，skill 教）vs 线协议（phonon↔server）」两层分离是关键：agent 侧只需会 emit 简单 block，复杂性（读盘/传输/渲染/回填）全在 phonon 与 server。

---

## 8c. 项目与 Skill（D23/D24）

### 项目（D23）— session 的另一个一等身份
- **一个项目 = 一个目录 + Git。所有 session 必须绑定一个项目**（`session.create` 必填 `project`）——和 agent 并列的一等身份，全程携带、落库。
- `project.create`（目录 + 可选 git init/remote）/ `project.list` / `project.get` / `project.remove`。
- 路径缺省由 phonon 在**受控工作区**下按 name 生成，避免服务端越权指定任意本地路径。
- **不受 tenant 隔离**：项目是磁盘上的客观目录，大家都有权限访问才正常。不同 tenant 能看到/用同一项目，在其下可能干不同的事；有冲突由用户自担。（隔离发生在会话/任务层，不在文件层。）
- **安全**：`project.remove` 默认只解绑不删盘；`deleteFiles:true` 才删物理目录。

### Skill 管理（D24）
- 给指定 agent 装/卸 skill：`skill.install` / `skill.uninstall` / `skill.list`。
- 两级 scope：`global`（agent 全局，该 agent 所有项目可见）/ `project`（需 `projectId`，仅该项目可见）。
- 每个 agent 靠 capability `skillManagement` 声明是否支持；不支持 → `errCapabilityUnsupported`。
- source：`inline`（内联文件）/ `localPath` / `url`。
- 注：平面③（§8b）的 directive 能力本身就靠给 agent 装 skill 教格式——skill 管理是它的基础设施。

### Worktree 与分支操作（D25）
- `project.worktree.create`：基于某 `baseBranch` 创建 worktree，可同时 `newBranch` 新建分支（同一 branch 不能被两 worktree 同时检出，多开并发传 newBranch）。
- `project.worktree.list` / `project.worktree.remove`（默认不强制，有未提交变更会拦）。
- `project.git.deleteBranch`：删除（已合并的）分支；默认只删已合并（git branch -d），`force:true` 才强删未合并（-D）。
- **worktree = 同仓多工作目录**，正好适配「多 tenant/session 在同一项目各干各的互不踩」；`session.create` 可选 `worktreeId` 指定跑在哪个 worktree。

### 执行时指定 Skill（D26）
- `session.send` 可传 `skills:[名]`，表示本轮务必用这些 skill。
- phonon 保证两件事：**(1) 该 skill 在 agent 能访问到的位置**（已装直接用，未装则临时就位）；**(2) 在上下文注入一条「强制加载该 skill」的指令**（复用 inject），让再笨的模型也会本轮务必加载。

---

## 9. 持久化 (sqlite) — 草案

> **实现状态（2026-06-20）**：**sqlite 持久化已落地**（node:sqlite，零依赖）。PhononStore 持久化 projects/worktrees/skills/sessions(元数据)/outbox_events/idempotency/pending_interactions；ProjectManager/SkillManager/Outbox 重启自动从库恢复。dbPath 缺省 :memory:（测试），daemon 传文件路径。policy/幂等/whenBusy/outbox 重发/unsolicited/重连均已落地。

```
sessions(
  id TEXT PK,            -- phonon sessionId（全局唯一）
  tenant_id TEXT,        -- 归属哪个服务端/租户（隔离键）
  project_id TEXT,       -- 绑定哪个项目（一等身份，D23）
  agent_id TEXT,         -- 绑定哪个 agent（一等身份，D15）
  model TEXT,            -- 绑定哪个模型
  adapter TEXT,
  agent_config JSON,
  native_ref TEXT,       -- 原生 session 引用（resume 用）
  status TEXT,           -- idle | running | paused | terminated（D19）
  verbosity TEXT,
  created_at, updated_at, last_active
)
-- 项目（目录 + Git，D23；设备级共享，无 tenant_id）：
projects(id TEXT PK, name TEXT, path TEXT, git INT, remote TEXT, created_at)
-- skill 安装记录（按 agent + scope，D24）：
skills(id INTEGER PK, agent_id TEXT, name TEXT, scope TEXT, project_id TEXT, version TEXT, installed_path TEXT, installed_at)
-- 未完成的人机交互（P1-5，重连 re-sync）：
pending_interactions(request_id TEXT PK, session_id TEXT, turn_id TEXT, form JSON, status TEXT, timeout_seconds INT, created_at)
-- tenant 配置可入库（或纯配置文件，待定）：
tenants(id TEXT PK, server_url TEXT, key_ref TEXT, enabled INT, quota JSON, created_at)
-- agent 发现缓存（可选，加速启动 + 变更比对）：
agents_cache(agent_id TEXT PK, available INT, version TEXT, models JSON, capabilities JSON, scanned_at)
-- 上行待发队列（D18 queue 模式：忙碌时积压的 send，按序不丢）：
inbox_queue(id INTEGER PK, session_id TEXT, turn_id TEXT, input TEXT, when_busy TEXT, enqueued_at, status)
-- 下行发送缓冲/重放 outbox（断线期间的 stream.event 缓存，重连按 seq 补发，D18）：
outbox_events(id INTEGER PK, session_id TEXT, seq INTEGER, payload JSON, created_at, acked INT)
-- 可选：session_events(id, session_id, type, payload, ts) 历史留痕
```

进程重启 → 读表 → 对 `idle`/`running`/`paused` 的 session 按 **tenant** 重建连接后尝试 re-attach 原生 ref（原 running 恢复为 paused 待重跑）。（表结构开发中细化）

**双向不丢机制（D18）**：
- **下行（phonon→server）**：stream.event 带单调递增 `seq`；断线期间写入 `outbox_events`，重连后按 `seq` 补发（缓冲重放，带上限）；server 按 seq 去重；server 用 `stream.ack{lastSeq}` 确认后 phonon 清理 outbox（P0-4）。OpenClaw 的自发输出不会因连接抖动丢失。
- **上行（server→phonon）**：忙碌时的 send 按 `whenBusy` 处理；queue 模式进 `inbox_queue` 持久排队，上一轮结束自动出队发送。

---

## 10. 包结构 (pnpm monorepo)

| 包 | 角色 | 是否发布 |
|----|------|---------|
| `@agent-phonon/protocol` | zod schema + 导出 JSON Schema/OpenAPI + spec（**唯一对外契约**） | ✅ 发布，供任何调用方 import |
| `@agent-phonon/core` | 设备侧 daemon：连接、调度、session 引擎、sqlite、压缩引擎 | 内部 |
| `@agent-phonon/adapter-*` | 每种 agent 一个适配器（先 `openclaw`） | 内部 |
| `agent-phonon` | 主包 / 全局 CLI（`npm i -g`）：启动 daemon + **管理多租户配置**（增删服务端/device key/配额、查连接与 session 状态） | ✅ 发布 |
| `@agent-phonon/client-sdk` | 给服务端用的带类型客户端 | ✅ 发布 |

npm org `agent-phonon` → 占下 `@agent-phonon/*` 整个 scope。

---

## 11. 阶段与交付顺序

**Phase 1（核心，本期）**
1. `@agent-phonon/protocol` — zod 类型 + 导出 JSON Schema + 一页 spec（唯一契约，先行）。
2. 最小 **server stub** + **OpenClaw adapter**，把整条链路跑通验证：
   `拨出连接 → discovery.list（看到 OpenClaw 及模型） → session.create（绑定 agent+model） → session.send → 流式回包 → session.terminate`。
3. sqlite 持久化（含 agent_id/model）+ 重启 re-attach。
4. hook/HITL 最小闭环（一个 pre_tool hook 走通 fired→resolve）。

**Phase 2**
- 更多 adapter（Claude Code → Codex → OpenCode → Hermes）。
- L3 多-agent 编排（任务级，复用 L1）。
- custom 压缩引擎策略化。
- Windows 守护方案。

---

## 12. CLI 职责（草案）

CLI 是配置与运维入口（具体命令名开发中定）：

- **多租户配置**：`tenant add/list/remove/enable/disable`——增删服务端（server URL + device key + 配额 + 启用 adapter）。
- **守护进程**：`start/stop/status`（配套 systemd unit）。
- **观测**：`conn ls`（各 tenant 连接状态）、`session ls`（按 tenant 列 session）。
- device key 等敏感值不入 git，存本地受限配置（权限 600）。

---

## 13. 开放问题（开发中再定）

- custom 压缩的具体策略（摘要/截断/关键轮保留…）。
- discovery 扫描频率 / 触发方式（定时 vs 文件监听 vs 按需）、结果缓存时效。
- 资源配额（全局 + per-tenant）的具体值。
- tenant 配置落库 vs 纯配置文件的最终选择。
- outbox 缓冲的上限 / 留存时长 / 超上限策略（丢最旧 vs 背压）。
- session_events 是否落库、留多久。
- 协议版本协商（device 与 server 版本不一致时）。
- Windows 守护进程的最终方案。
| D34 | **可观测性 = 放权的前提（产品理念）** | 人放权让 agent 自动干活，但关键时刻要能揭盖看里面——黑盒不可放权，可观测才敢放权。统一 ObsBus 事件源（session/turn/tool/hitl/connection/daemon 类别）+ 多消费者：结构化 JSON 日志、sqlite audit_events 回溯、实时指标、可观测 HTTP（/health /metrics /sessions /events /stream）。两层观测：服务（health/metrics）+ agent 调度（/sessions 实时快照 + /events 时间线 + /stream SSE）。zero-dep（自写 JSON logger，不引 pino）。 |
