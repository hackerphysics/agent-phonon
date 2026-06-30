# agent-phonon 安全问题汇总（三方 review 合并去重）— 2026-06-30

> 三份独立 review 合并：万万（L4 + PoC）、GPT（trust boundary 架构）、Minimax（攻击面扫描）。
> 万万对每条做了**交叉验证 + 本机核实**，标注真实性。`pnpm audit --prod` = 0 依赖漏洞。
> **结论先行**：核心沙箱/加密设计扎实，但有几个真实可利用洞 + 一个架构级 trust boundary 薄弱。
> 下面按"是否值得修"分三档，不是按发现者分。

---

## 一、值得修（确认真实 + 有实际风险）

### 🔴 P0 — 立即修（高危，已核实/已 PoC）

| # | 问题 | 证据 | 谁发现 | 值得修理由 |
|---|------|------|--------|-----------|
| **A1** | **git 参数注入 → 绕过文件沙箱任意写盘/RCE** | `project-manager.ts` gitLog:9 / push / diff，用户可控 branch/ref/remote 裸拼、无 `--` 隔离、不拒 `-` 开头。**万万本机 PoC：`git log --output=/tmp/PWNED.txt` 真写出沙箱外文件** | 万万 | 已 PoC，绕过整个 realpath 沙箱，可改 .bashrc → RCE |
| **A2** | **project.exec = server-driven RCE**（命令任意 + env 注入） | `project-manager.ts:424` `spawn(command, args, {env:{...process.env,...params.env}})`。command 可为任意 binary，env 可注入 `LD_PRELOAD`/`PATH` | GPT(C1)+万万(S2)+Minimax | shell:false 只挡 metachar，挡不住指定任意 binary + LD_PRELOAD 加载恶意 .so。三方都点到 |
| **A3** | **默认 policy `allowedMethods=[]` = 全放行** | `policy.ts:79` 只有 `length>0` 才限制；daemon config 没把 per-server policy 接进去 | GPT(C2) | 连上即拥有 exec/file.write/skill.install/env/schedule 全 RPC 面。语义反了：空应=最小权限 |
| **A4** | **device.fs.list 枚举整个文件系统，绕过 denyPathPatterns** | `index.ts` deviceFsList **不调用任何 deny/policy 校验**（万马核实属实），root 含 `/`、home、所有盘符 | GPT(C4) | 可列 ~/.ssh、~/.aws、openclaw.json、浏览器 profile。policy 写的 denylist 形同虚设 |
| **A5** | **server 不被认证 + ws:// 明文允许 + tenant 由 server 单方面决定** | `client.ts:65` 裸 `new WebSocket(url)`；SDK server 无 authenticate 时默认 `tenant-${deviceId}` 放行 | GPT(C3+C5)+Minimax | 非 loopback ws:// + DNS 劫持 → 冒充 server 下发 exec。trust boundary 太薄 |

### 🟠 P1 — 尽快修（确认真实，中高风险）

| # | 问题 | 证据 | 谁发现 | 值得修理由 |
|---|------|------|--------|-----------|
| **B1** | **tenant 越权：scheduler/workflow by-id 操作不校验 tenant** | 万万核实：`loadSchedule/runGet/getWorkflow` 都不查 `row.tenant_id`，而 daemon **多 server 共享同一 store**（`daemon.ts:97/114`） | GPT(H1+H2)+万万 | 多租户场景 tenant A 知 ID 即可读/触发/删 tenant B 的 schedule/run/workflow + 读 resultText/transcript |
| **B2** | **skill localPath 源无围栏 → 任意本地目录读取** | `skill-manager.ts:114` `copyDir(params.source.path)` 无 assertProjectPath | 万万(S4)+GPT(M4)+Minimax | server 传 `/home/user/.ssh` → 复制进 skill 区读出，绕过沙箱 |
| **B3** | **cron 不可能日期表达式 → 同步阻塞 daemon 24.5s** | **万万 PoC：`nextCronAfter("0 0 30 2 *")` 阻塞 24468ms**；`schedule.ts:35` expr 无任何约束 | 万万(S3) | 单个 schedule 冻结整个 daemon。L4 引入 |
| **B4** | **L4 consent 被 run.events.subscribe 绕过** | `scheduler-engine.ts:318` subscribed 即转发原始 stream.event；subscribe() 无 consent 检查 | 万万(M7) | `status-only`（本意内容不出设备）形同虚设。**万万设计承诺的安全门没落地，是 L4 自己的债** |
| **B5** | **transcript 明文存完整 prompt/输出 → 持久化泄露 secrets** | `transcript.ts` 注释自承"可能敏感"；env decrypt 后注入若被 echo 即落盘；路径可预测 | GPT(H3) | token/secret/文件内容落明文 JSONL，默认保留。需 redact + 可关闭 |
| **B6** | **HITL 默认 fail-open** | `openclaw-plugin/src/index.ts:81` bridge 不可达→放行；SDK 无 decider→`{applied:true}` | GPT(H5) | 安全拦截失效时静默放行危险 tool。高危操作应 fail-closed |

### 🟡 P2 — 应修（确认真实，中低风险/纵深防御）

| # | 问题 | 谁发现 | 值得修理由 |
|---|------|--------|-----------|
| **C1** | file.read 先全量 readFile 再截断，maxBytes 不防 OOM | 万万(M1)+GPT | 读大文件 OOM，流式即可解 |
| **C2** | JSON-RPC / ws 无 payload 上限 + 无原型污染防护 | 万万(M2) | ws 设 maxPayload + 外部对象合并用白名单 |
| **C3** | skill tar 两段式（列表/解压分离）+ 硬链接绕过 + 解压无大小上限（tar 炸弹） | 万万(M4/M5)+GPT(M4)+Minimax | 换纯 JS tar 库带 filter + 字节上限 |
| **C4** | file.* TOCTOU + transcript symlink-follow 写入 | 万万(M6)+GPT(H4) | 用 O_NOFOLLOW/O_EXCL 拿 fd 再操作 |
| **C5** | worktree 默认建在受控根外（`proj.path/..`）不校验 | 万万(M3)+Minimax | 默认路径也走 assertProjectPath |
| **C6** | webhook 授权弱 + token DB 等值查询（待实现 HTTP 入口需常数时间比较）+ 无限流 | 万万(M8) | webhook 独立 policy + timingSafeEqual + maxConcurrentRuns |
| **C7** | hook plugin / obs-server 日志打印 params/decision；HTTP body/limit 无上限 | GPT(M1/M2) | 日志脱敏 + body 限 1MB + limit clamp |

---

## 二、可以不修 / 需先和你确认（by-design 嫌疑）

| 问题 | 谁提 | 万万判断 |
|------|------|---------|
| schedule token reveal 无独立 policy（不像 env reveal 有 allowEnvReveal） | GPT(M3) | **半 by-design**：server 本就是控制面，能 reveal 自己租户的 token 合理。但和 env reveal 模型不一致，建议加 `allowScheduleTokenReveal` 对齐，优先级低 |
| project.exec command 仅过滤换行/NUL，未限绝对路径 | 万万(L2)+Minimax | **取决于威胁模型**：如果 exec 本意就是"受信 server 跑任意命令"，这是 feature 不是 bug。但应和 A2/A3 一起，给 exec 加独立 gate + 默认关 |
| run/schedule id 用 `Date.now()+seq` 可预测 | 万万(L3) | 非密钥，单独看风险低。但**配合 B1 tenant 越权会放大**（可枚举他人 ID）→ 修了 B1 就不算问题 |
| trustLocal 默认开 allowDeleteFiles/allowGlobalSkillInstall | Minimax | **by-design**：trustLocal 就是"单机自用"开箱模式。但文档应明确"trustLocal 仅限 loopback 单机" |

---

## 三、确认做得好的（别改坏）

- **file.* realpath 双重围栏** + list/stat 用 lstat 不跟符号链接出根（三方一致认可）
- **不走 shell**：runGit/project.exec 都 `spawn({shell:false})`，根除经典 shell 注入（A1 是 argument injection，不是 shell 注入）
- **加密**：env 值 AES-256-GCM 每条独立 IV、device.key 0600 与库分离、env.list 默认脱敏
- **skill tar 主防护**：sha256 + 列表先校验拒 `..`/绝对路径/NUL + 解压后拒符号链接 + name 白名单
- **L4 webhookToken**：randomBytes(24) + 默认 `***` 脱敏 + 仅 create 返回一次
- **依赖干净**：`pnpm audit --prod` = 0 漏洞

---

## 四、建议修复顺序（合并三方意见）

**第一波（把"连上 server ≈ 本机 RCE"压下去）**
1. A2 project.exec 加 `allowExec=false` 独立 gate + env 危险变量黑名单 + command 白名单
2. A3 默认 policy 改最小权限 + daemon config 接 per-server policy + mutating 默认禁
3. A5 非 loopback 强制 wss + SDK server 默认不放行 + device 侧 expectedTenantId 校验
4. A1 git 参数注入：ref/branch/remote 拒 `-` 开头 + `--` 隔离 + 白名单
5. A4 device.fs.* 默认关 + 只允许 allowed roots + 过 denyPathPatterns

**第二波**
6. B1 补全 tenant scoping（scheduler/workflow/store 所有 by-id 带 tenantId）
7. B3 cron DoS（计算硬上限 + expr zod 校验）
8. B2 skill localPath 围栏
9. B4 L4 consent 落地到 run.event（我的 L4 债）
10. B5/B6 transcript redaction + HITL fail-closed 选项

**第三波**：C1-C7 纵深防御逐个清。

---

## 万万的诚实交代

- **B3/B4/C6 是 L4（我刚写的）引入或相关的安全债**。B4 尤其——我在设计文档里白纸黑字承诺"webhook 触发的 run 同样过 consent/policy 门、status-only 内容不出设备"，但代码里 subscribe 能绕过 consent、assertRunAllowed 只是个弱方法白名单。这是我的责任，应优先补。
- **A1-A5、B1-B2、B5-B6 是项目既有问题**，不是 L4 引入，但都真实且部分高危。
- 三份 review 高度交叉印证的（A2 三方都点、B1 GPT+我、B2 三方都点）可信度最高，建议最先动。

---

## v0.9.1 修复落地（2026-06-30）

Stephen 拍板"A 和 B 都修，B5/B6 以后遇到问题再说"。本版修复以下，全部带回归测试（`packages/test-server/src/fn-security-review.test.ts`，13 个）：

| # | 修复 | 实现 |
|---|------|------|
| **A1** | git 参数注入 | `project-manager.ts`：新增 `assertNotOption`/`assertRefName`/`assertRemote`，所有 git 方法（log/diff/push/merge/worktree/deleteBranch/remote）对用户可控 branch/ref/remote 拒 `-` 开头 + 保守白名单 + `--` 隔离。PoC `git log --output=` 已被拦，无文件写出 |
| **A2/A3** | exec RCE | 新增 `allowExec` policy（默认 false，trustLocal 单机默认 true）；`project.exec` dispatch 加 `assertExec()` 门；`sanitizeExecEnv` 剔除 LD_PRELOAD/LD_LIBRARY_PATH/DYLD_*/NODE_OPTIONS/GIT_SSH_COMMAND/BASH_ENV 等危险 env + 禁止覆写 PATH |
| **A4** | device.fs 枚举 | 新增 `allowDeviceFsBrowse` policy（默认 **true**，保留能力，按 Stephen 决定）；设 false 可锁 device.fs.roots/list |
| **A5** | server 鉴权 | `client.ts` 新增 `assertSecureServerUrl`：非 loopback 强制 wss://（明文 ws:// 仅 loopback，`allowInsecure` 可显式绕过）；新增 `expectedTenantId` 校验（welcome 不匹配拒连）；SDK `PhononServer.listen` 非 loopback 绑定且无 authenticate 且未设 allowAnonymous → 拒绝启动 |
| **B1** | tenant 越权 | store 的 getSchedule/getRun/getScheduleByWebhookToken/listRunsForSchedule/getWorkflow/ackWorkflow 全部加 tenantId 过滤；scheduler/workflow 所有 by-id 调用传 tenantId |
| **B2** | skill localPath | 新增 `allowLocalPathSkillInstall` policy（默认 false） |
| **B3** | cron DoS | 重写 `nextCronAfter` 按天跳过（不可能日期 24468ms→63ms）；`schedule.create` 校验可解析 + 能算出下次触发；CronTrigger zod 加字段数/长度约束。闰年 Feb29 不误杀 |
| **B4** | L4 consent 绕过 | `run.event` 转发 + `run.events.subscribe`（含已结束 run 分支）按 consent 门控，非 full 拒订阅 |

**暂不修（Stephen：以后遇到问题再说）**：B5（transcript redaction）、B6（HITL fail-closed）、C 档纵深防御。

**测试**：functional 141 / e2e 32 / protocol 50 / daemon 2 全绿；consistency + build 全过。
