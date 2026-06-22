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
