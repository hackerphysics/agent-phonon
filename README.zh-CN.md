# agent-phonon

[English](./README.md)

> 把多种本地 Agent 编排成一个系统——在你的设备上运行，从任何地方调度。

**agent-phonon** 是一个设备侧 daemon。它会发现本机已安装的 AI Coding Agent
（Claude Code、Codex、GitHub Copilot CLI、OpenCode、OpenClaw、Hermes 等），并通过统一的
WebSocket/JSON 协议暴露给服务端。

名字来自凝聚态物理里的 **phonon（声子）**：大量原子共同振动时涌现出的集体准粒子。
单个 Agent 各自为战；编排在一起，就形成一个统一系统。*More is different.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## 它解决什么问题

本地 AI Agent 很强，但彼此割裂：每个 CLI 都有自己的会话模型、流式输出格式、模型切换方式和能力边界。agent-phonon 在它们前面放一个轻量 daemon，让服务端可以：

- 发现设备上有哪些 Agent 和模型可用；
- 用统一协议创建、发送、打断、终止会话；
- 接收流式输出和主动输出；
- 管理项目、worktree、skill、文件、环境变量和 HITL hook；
- 编排多台设备，同时每台设备仍保留自己的本地安全策略；
- 即使全部外部 Agent 都坏掉，仍保留内置 `phonon-rescue` 和确定性维护通道完成诊断与恢复。

Adapter 会声明真实能力；agent-phonon 不会假装所有 Agent 都完全一样。

## 架构

```text
        server(s)                          your device(s)
   ┌────────────────┐   wire protocol   ┌────────────────────────────┐
   │  server SDK    │◄─────WS / JSON────►│  phonon daemon (core)      │
   │  (TS / Python) │                   │   ├─ adapter: OpenClaw      │
   │  console / app │                   │   ├─ adapter: Claude Code   │
   └────────────────┘                   │   ├─ adapter: Codex         │
                                        │   ├─ adapter: Copilot CLI   │
                                        │   ├─ adapter: OpenCode      │
                                        │   └─ adapter: Hermes        │
                                        └────────────────────────────┘
```

## 包

| 目录 | 发布包 | 用途 |
|---|---|---|
| `packages/daemon` | `agent-phonon` (npm) | 设备侧 daemon / CLI |
| `packages/protocol` | `@agent-phonon/protocol` (npm) | 协议类型和 zod schema |
| `packages/sdk-server-ts` | `@agent-phonon/server-sdk` (npm) | TypeScript/Node 服务端 SDK |
| `sdk-python` | `agent-phonon-sdk` (PyPI) | Python 服务端 SDK |

`@agent-phonon/core` 会被打包进 daemon，不单独作为运行时包发布。Console、test-server、OpenClaw plugin 等包保留在仓库中用于开发和集成测试。

## 环境要求

- Node.js >= 22.5
- npm 或 pnpm
- 可选本地 Agent：
  - Claude Code：`claude`
  - Codex CLI：`codex`
  - GitHub Copilot CLI：`copilot`
  - OpenCode：`opencode`
  - Hermes：`hermes`
  - OpenClaw Gateway / plugin

Linux 服务管理目前支持 **systemd --user**。macOS launchd 和 Windows service 后续单独支持。

## 安装设备侧 daemon

```bash
npm install -g agent-phonon
agent-phonon --help
```

初始化本地配置：

```bash
agent-phonon init
```

配置文件位置：

```text
~/.agent-phonon/config.json
```

配置里包含 device id、本地数据库路径、adapter override、server 连接和本地安全策略。默认打印配置时会脱敏：

```bash
agent-phonon config
agent-phonon config --show-secrets   # 只有确实需要时才用
```

## 配置服务端连接

如果服务端给了 WebSocket URL 和 device key：

```bash
agent-phonon server add wss://your-server.example/phonon --device-key <device-key>
```

本地开发可以使用：

```bash
agent-phonon server add ws://127.0.0.1:4317/phonon --trust-local
```

查看已配置服务端：

```bash
agent-phonon server list
```

## 作为 Linux 用户服务运行

安装 systemd user unit：

```bash
agent-phonon service install
```

启动：

```bash
agent-phonon service start
```

常用命令：

```bash
agent-phonon service status
agent-phonon service restart
agent-phonon service stop
agent-phonon service uninstall
```

`service install` 会写入：

```text
~/.config/systemd/user/agent-phonon.service
```

并执行：

```bash
systemctl --user daemon-reload
systemctl --user enable agent-phonon.service
```

它不会自动启动服务，必须显式执行 `service start`。

如果希望 Linux 服务器上用户退出登录后 daemon 仍持续运行，可能还需要：

```bash
loginctl enable-linger "$USER"
```

## 前台运行

调试或非 systemd 环境可以直接前台运行：

```bash
agent-phonon start
```

## 发现本地 Agent 和模型

```bash
agent-phonon doctor
agent-phonon discover
```

`doctor` 检查本机 CLI / Gateway / plugin 是否可用；`discover` 返回统一的 Agent 描述，包括可用模型和能力声明。

自动发现策略：

- 通过执行 CLI 的 version 命令判断是否可用；
- 尽量解析成绝对路径，避免 systemd/launchd 的 PATH 和交互 shell 不一致；
- Codex 会读取用户自己的 `~/.codex/config.toml`，从 provider endpoint 请求 `GET <base_url>/models`；失败时使用安全 fallback；
- GitHub Copilot CLI 会从 `copilot help config` 解析模型清单，并使用 JSONL 真流式输出和原生命名会话续接；
- Hermes 会读取 profile/config/catalog，并在 catalog 不完整时使用 provider fallback；
- 不硬编码任何用户个人 provider 名、endpoint 或本机路径。

## 内置救援 Agent 与确定性维护通道

`phonon-rescue` 直接内置在 daemon 中，不依赖 OpenClaw、Claude Code、
Codex、Copilot、OpenCode 或 Hermes。可配置支持 **OpenAI Chat Completions 或
Responses，以及 tool calling** 的 endpoint：

```bash
agent-phonon rescue configure \
  --base-url https://your-endpoint.example/v1 \
  --model your-tool-capable-model \
  --api-key-ref ~/.agent-phonon/rescue.key
```

CLI 使用与 runtime 相同的官方 provider 实测所选协议 + 工具调用，成功后才保存。也支持
`--api-key-env`；后台服务推荐使用权限为 `0600` 的 key 文件。

显式无认证的 loopback endpoint 可使用 `--no-auth`（保存为
`rescueAgent.authMode: "none"`），仅允许 `127.0.0.1`、`localhost`、`[::1]`。
该模式拒绝同时设置 key/file/env 引用，忽略默认 key 环境变量，完全不发送
Authorization、x-api-key、x-goog-api-key 或 query key；远程 endpoint 仍要求认证，默认模式仍为 `"api-key"`。
Discovery 只判断配置齐备，不代表 endpoint 实测可用；CLI 工具探测失败不会保存配置。

传输协议默认 `chat`，保持已有配置兼容。Responses 使用 `--wire-api responses`
（保存为 `rescueAgent.wireApi: "responses"`），例如：

```bash
agent-phonon rescue configure --base-url http://127.0.0.1:4000/v1 \
  --model gpt-5.6-sol --wire-api responses --no-auth
```

### Rescue 内置维修知识

全新 Rescue 会话可先通过只读 `query_knowledge` 按 Agent、版本、平台和协议检索维修经验，再调用维护工具。知识静态打包进 daemon，不依赖旧聊天、本助手 workspace 或全局 skills。覆盖 OpenCode、Claude 协议/角色和有条件的 GPT 兼容、Hermes YAML、Codex/Copilot 有限事实及五格式 SHA/回滚规则；未知版本/平台不返回维修正文，原生验证不足和服务停止必须如实说明。详见[知识包架构、边界与来源](docs/rescue-knowledge.md)。

### Rescue 主流协议

`rescueAgent.wireApi` / `--wire-api` **与 model ID 分离显式配置**，默认仍为
`chat`。不从模型名称猜协议，不在 HTTP 错误后自动切换协议或重试维护工具。
必须填写自选 endpoint 和该 endpoint 已列出的模型；绝不回退至 provider 的默认公网域名。

| wireApi | 官方 AI SDK provider | baseUrl 示例（包含 API 前缀） | SDK 自动添加的后缀 | 文本输出粒度 |
|---|---|---|---|---|
| `chat` | `@ai-sdk/openai-compatible` | `https://endpoint.example/v1` | `/chat/completions` | token 流式 |
| `responses` | `@ai-sdk/openai` | `https://endpoint.example/v1` | `/responses` | 完整步骤 |
| `anthropic` | `@ai-sdk/anthropic` | `https://endpoint.example/v1` | `/messages` | 完整步骤 |
| `gemini` | `@ai-sdk/google` | `https://endpoint.example/v1beta` | `/models/{model}:generateContent` | 完整步骤 |

表中是占位示例，不是已配置服务。保留自定义路径前缀、移除末尾斜杠；不要把具体操作
后缀填入 baseUrl，也不要重复 `/v1`。官方服务相应前缀为
`https://api.anthropic.com/v1` 和 `https://generativelanguage.googleapis.com/v1beta`。
Gemini 可用裸模型 ID 或 endpoint 提供的资源 ID（`models/...`），SDK 不重复添加
`models/`。baseUrl 禁止 userinfo、query 参数（包括 key）和 fragment。

已有安全 key 文件时，原生安全入口为 **`--api-key-ref <file>`**：配置仅保存文件引用，
秘密值不进入命令参数、shell 历史或 rescue 配置。通过本地安全凭据流程准备该文件，
权限限制为所有者可读写的 `0600`；不要在聊天或 CLI 参数中粘贴秘密。例如以下仅为占位示例：

```bash
agent-phonon rescue configure --base-url https://endpoint.example/v1 \
  --model endpoint-listed-model --wire-api anthropic \
  --api-key-ref /secure/path/rescue-key
agent-phonon rescue configure --base-url https://endpoint.example/v1beta \
  --model endpoint-listed-model --wire-api gemini \
  --api-key-ref /secure/path/rescue-key
```

认证 Anthropic 由官方 provider 使用 `x-api-key` 和 `anthropic-version`，Gemini 使用
`x-goog-api-key`，Chat/Responses 使用 Bearer Authorization。Rescue 自行解析显式
key/ref/env 配置及原有 `PHONON_RESCUE_API_KEY` 后备，不隐式读取 provider 的默认 key
环境变量。四协议均支持显式 loopback `--no-auth`；拒绝同时设置 key，不读取 key env。
Responses/Anthropic/Gemini 通过官方导出的 `/internal` 构造器绕开强制 key 工厂，
不填假 key、不先生成认证头再删除。版本敏感入口已精确锁版：openai `4.0.43`、
anthropic `4.0.41`、google `4.0.50`（provider `4.0.7`，兼容 ai `7.0.58`），升级须回归。

Responses/Anthropic/Gemini 使用官方 `ToolLoopAgent.generate`：每个完成步骤的文本
作为一次追加消息输出，不伪装逐 token delta；真实工具执行回调实时发出。Zod 在执行前
拒绝的调用，从 SDK 步骤内容转发真实 call/error ID。Responses 保留 `store: false`、
`parallelToolCalls: false` 的无状态工具结果重放，兼容缺少 SSE 文本 delta 的 endpoint。
Chat 保留原 token 流式。所有协议均保留 Zod 参数验证、本地维护 policy 和 expectedSHA。
仅 Gemini 的 `patch_config.patch` 使用 JSON 编码的对象字符串，因为官方 OpenAPI
转换会丢弃开放对象的 additionalProperties。工具边界解析字符串并用 Zod 再验证为对象，
然后调用完全相同的 maintenance manager；其他协议仍接收对象参数。这是工具 schema
适配，不是 HTTP 协议转换器。
超时/中断、工具循环步数耗尽未完成、截断或过滤/错误结束不会标记 completed；均拒绝
HTTP 重定向。**协议实现及模拟回归通过不等于特定 endpoint 真实支持**：discovery
只检查配置齐备，CLI 则真实探测工具调用，成功后才保存。原生 Anthropic/Gemini 的
probe 在请求前固定选择 `toolChoice: auto`，兼容拒绝强制工具选择的 thinking endpoint；
仍必须返回真实 `phonon_probe` 调用才通过。Chat/Responses 保留强制工具选择。HTTP 200
但无工具调用也失败，不落盘、不重试、不切协议。保存配置不启动生产实例，
运行实例需另行重启加载。


救援 Agent 没有任意 shell，也不能任意读写宿主机。它只能调用设备本地预注册的
语义化维护操作。同一套操作也通过 Server SDK 的 `device.maintenance.*` 直接暴露，
因此即使救援模型 endpoint 也不可用，仍可走确定性 break-glass 通道：

- 目标清单和诊断；
- JSON/JSONC/YAML/TOML 脱敏配置读取，以及显式 public 的 UTF-8 文本；
- 带 hash 乐观锁和原始字节备份的 JSON/JSONC/YAML Merge Patch，以及通用精确文本编辑；
- 校验备份 checksum 的回滚；
- 白名单内用户态 npm/pnpm 包更新；
- 白名单内用户服务状态和重启。

四类维护权限由独立设备 policy 控制，默认全部关闭。`trustLocal` **不会**自动开放宿主机维护；
每条 server 连接都必须在本地 `policy` 中显式授权。线协议不接受任意路径、包名、服务名或 shell 字符串。

详见[多格式维护协议](docs/PROTOCOL.md#多格式维护配置与文本编辑)：文本可见及整文件授权默认关闭；TOML 只做 parse 校验后的局部 edit，不作有损 stringify；YAML patch 可能规范化格式。Hermes YAML、Codex TOML 新默认注册只读，不自动扩权。

## Adapter override

大部分用户不需要手动加 adapter，自动发现即可。只有需要强制路径、模型或 provider 时才使用 override：

```bash
agent-phonon adapter add codex --bin /path/to/codex --model default
agent-phonon adapter add claude-code --bin /path/to/claude --model default
agent-phonon adapter add copilot --bin /path/to/copilot --model default
agent-phonon adapter add hermes --bin /path/to/hermes
agent-phonon adapter add opencode --bin /path/to/opencode
```

OpenClaw 集成：

```bash
agent-phonon plugin install openclaw
agent-phonon adapter add openclaw --agent main
```

## 服务端 SDK

### TypeScript / Node

```bash
npm install @agent-phonon/server-sdk
```

```ts
import { PhononServer } from "@agent-phonon/server-sdk";

const server = new PhononServer({ port: 4317 });
server.listen();
```

### Python

```bash
pip install agent-phonon-sdk
```

```python
from agent_phonon import PhononServer

server = PhononServer(port=4317)
server.run()
```

## 开发

```bash
pnpm install
pnpm run consistency
pnpm -r build
pnpm -r test
```

提交或打 release tag 前，建议安装项目 git hook：

```bash
pnpm run install-hooks
```

发布/一致性守卫见：

- `AGENTS.md`
- `docs/COMMIT_RELEASE_CHECKLIST.md`
- `scripts/check-consistency.mjs`
- `scripts/release-guard.mjs`

## 文档

- [协议](./docs/PROTOCOL.md)
- [L3 多 Agent 编排协议](./docs/L3_ORCHESTRATION.md)
- [设计决策](./docs/design.md)
- [Agent CLI 集成](./docs/agent-cli-integration.md)
- [发布 checklist](./docs/COMMIT_RELEASE_CHECKLIST.md)
- [安全](./SECURITY.md)

## 安全模型

agent-phonon 是本地 Agent 的远程控制面，因此本地设备主人是授权边界。文件访问受本地 policy 约束，secret 默认脱敏，phonon 自己保存的敏感值会加密落盘，危险操作默认拒绝，除非本地 policy 明确允许。

## License

[MIT](./LICENSE) © agent-phonon contributors

### 安全连接默认值与本地测试

Daemon 的 `servers[]` 正式支持 `expectedTenantId`（可选、非空的精确租户 ID，
拒绝首尾空白/控制字符）和 `allowInsecure`（可选布尔值，默认 false），均传入
真实设备客户端。welcome 租户不一致会拒绝连接；非 loopback 明文仍默认拒绝。
推荐 WSS；租户字符串匹配不能替代 TLS/凭据鉴权。本轮不写任何生产配置。

TS `new PhononServer()` 省略 host 时实际绑定 **127.0.0.1**。显式非 loopback
且无 `authenticate` 时在 bind 前拒绝；仅显式 `allowAnonymous: true` 例外。
Python 对应 keyword-only `allow_anonymous=True`，既有异步认证回调保持不变。
有认证回调时匿名 opt-in 不会绕过它。

`pnpm test`、`pnpm test:e2e`、`pnpm test:python` 使用隔离 HOME 和本地 fixture；
E2E 明确包含 workflow、Git、scheduler、obs。Python 包含三个场景脚本与新增认证/
Node 跨语言回归。真实 CLI/Gateway/模型保留独立显式 opt-in，compat 固定依赖
为可选独立入口。详见 [本地测试说明](docs/LOCAL_TESTING.md)；RPC 方法字符串
parity 不能证明构造参数、监听地址或鉴权行为一致。
