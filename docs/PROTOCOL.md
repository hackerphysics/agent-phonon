# agent-phonon 协议总览（一页速读）

> 自动对照 `packages/protocol` 源码的人话版总览。字段级看 `src/schemas/*.ts`，决策看 `docs/design.md`。
> 当前 43 个方法，协议版本 `0.1.0`。

## 一句话

phonon 拿 device key 主动拨出连服务端；单条 WebSocket 上双向跑 JSON-RPC 2.0。服务端下发 session 操作，phonon 上推流式结果 / 自发输出 / hook 请求。

## 43 个方法

| 方法 | 方向 | 类型 | 干啥 |
|------|------|------|------|
| `connect.hello` | phonon→server | request | 握手：协议版本 + 设备身份 → 回 tenant 绑定 |
| `device.info` | server→phonon | request | 查 OS/机器信息与调度标签：平台、架构、hostname、capabilities（如 ios-development/windows-desktop-development） |
| `device.resources` | server→phonon | request | 查设备资源快照：CPU/内存/磁盘/进程/GPU best-effort（仅监控，不调度） |
| `discovery.list` | server→phonon | request | 列本机可用 agent + 各自模型 |
| `discovery.get` | server→phonon | request | 单个 agent 详情 |
| `discovery.changed` | phonon→server | notify | 可用性变化主动推 |
| `session.create` | server→phonon | request | 建会话，**必须绑 project + agent + model** |
| `session.send` | server→phonon | request | 发任务＝对话；ack 回 turnId，内容走 stream；可传 `skills` 指定本轮技能 |
| `session.inject` | server→phonon | request | 注入上下文 |
| `session.compress` | server→phonon | request | 压缩，native \| custom 双模；custom 第一版支持 `dropToolIO`（删除结构化 tool 调用/结果，保留文本，默认保留最近 3 个 tool call，可 `keepRecentToolCalls` 配置） |
| `session.switchModel` | server→phonon | request | 中途换模型（agent 不变） |
| `session.interrupt` | server→phonon | request | **打断当前 turn，session 存活** |
| `session.terminate` | server→phonon | request | 销毁整个 session |
| `session.status` | server→phonon | request | 查单个 session（带状态/绑定/正在跑哪轮） |
| `session.list` | server→phonon | request | 列 session（可按 agent 筛） |
| `stream.event` | phonon→server | notify | 流式结果（含自发输出；终态 status） |
| `stream.ack` | server→phonon | notify | 确认已收 seq≤N，phonon 清 outbox（P0-4） |
| `hook.fired` | phonon→server | request | 到 hook 点抛事件，阻塞等裁决 |
| `hook.resolve` | server→phonon | request | 裁决：continue/inject/modify/abort |
| `document.send` | phonon→server | request | 发本地文档（agent emit 路径，phonon 读盘上传；project-scoped） |
| `document.prepare_upload` | phonon→server | request | 大文件凭证上传（预签名 URL，P1-6） |
| `interaction.request` | phonon→server | request | 发可交互表单/卡片给人填（timeout/cancel） |
| `interaction.response` | server→phonon | notify | 人填完的值回填（异步路径） |
| `interaction.cancel` | server→phonon | request | 主动取消 pending 交互（P1-5） |
| `project.create` | server→phonon | request | 建项目（目录 + Git） |
| `project.list/get` | server→phonon | request | 查项目 |
| `project.remove` | server→phonon | request | 删项目（默认只解绑不删盘） |
| `project.worktree.create` | server→phonon | request | 基于 branch 建 worktree |
| `project.worktree.list` | server→phonon | request | 列 worktree |
| `project.worktree.remove` | server→phonon | request | 清理 worktree |
| `project.git.deleteBranch` | server→phonon | request | 删合并分支 |
| `file.read` | server→phonon | request | 读取 project/worktree 内文件（utf8/base64，可 maxBytes 截断） |
| `file.write` | server→phonon | request | 写 project/worktree 内文件（可建父目录、可幂等） |
| `file.list` | server→phonon | request | 列 project/worktree 内目录（可递归、limit） |
| `file.stat` | server→phonon | request | 查文件/目录 metadata |
| `file.mkdir` | server→phonon | request | 创建 project/worktree 内目录 |
| `env.set` | server→phonon | request | 配置执行环境变量（global/project/skill scope，明文存在设备本地） |
| `env.list` | server→phonon | request | 查询环境变量配置；默认脱敏，reveal 需本地 policy 允许 |
| `env.delete` | server→phonon | request | 删除环境变量配置 |
| `skill.install` | server→phonon | request | 给 agent 装 skill（global\|project）；source 支持 inline files / archive tar.gz / localPath / url 预留 |
| `skill.uninstall` | server→phonon | request | 卸 skill |
| `skill.list` | server→phonon | request | 列 skill |

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

## v0.2 收口（四家 review 采纳，2026-06-20）

多家 AI 模型 review 后，补齐工程化可靠性与安全边界：

**P0（可靠+安全骨架）**
- 本地 policy（D27）：`TenantPolicy` 设备授权边界，默认最严格；document 默认 project-scoped；url 装 skill/删盘/全局 skill 默认拒
- turn 终态（P0-2）：每个 turn 必有 `result.status` ∈ completed|interrupted|aborted|failed|timeout
- 幂等（D28）：改状态请求带 `clientRequestId` 去重（不丢 + 不重）
- 可靠投递闭环（D29）：`stream.ack` + 重连 `resumeFrom`/`ackedSeqs` 双向对齐

**P1（边界与韧性）**
- worktree/branch 删除前查 active session，force 返回 affected
- worktree GC（terminate cleanWorktree）；project.remove cascade
- switchModel `whenRunning`（默认 reject）+ warnings
- whenBusy `fallback` 自动降级
- interaction `timeout`/`cancel`/状态 + pending 持久化
- 大文件 `document.prepare_upload`（预签名 URL 断点续传）

**P2（DX/一致性）**
- session.list 分页；capabilities.limits；FormField discriminated union
- skill version/hash/优先级（send>project>global）；compress.strategy server-private 透传

未采纳项见 `BACKLOG.md`（审计表、只读租户独立模型——后者并入 policy 的 allowedMethods）。
