# agent-phonon

[English](./README.md)

> 把多种本地 Agent 编排成一个系统——在你的设备上运行，从任何地方调度。

**agent-phonon** 是一个设备侧 daemon。它会发现本机已安装的 AI Coding Agent
（Claude Code、Codex、OpenCode、OpenClaw、Hermes 等），并通过统一的
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
- 编排多台设备，同时每台设备仍保留自己的本地安全策略。

Adapter 会声明真实能力；agent-phonon 不会假装所有 Agent 都完全一样。

## 架构

```text
        server(s)                          your device(s)
   ┌────────────────┐   wire protocol   ┌────────────────────────────┐
   │  server SDK    │◄─────WS / JSON────►│  phonon daemon (core)      │
   │  (TS / Python) │                   │   ├─ adapter: OpenClaw      │
   │  console / app │                   │   ├─ adapter: Claude Code   │
   └────────────────┘                   │   ├─ adapter: Codex         │
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
- Hermes 会读取 profile/config/catalog，并在 catalog 不完整时使用 provider fallback；
- 不硬编码任何用户个人 provider 名、endpoint 或本机路径。

## Adapter override

大部分用户不需要手动加 adapter，自动发现即可。只有需要强制路径、模型或 provider 时才使用 override：

```bash
agent-phonon adapter add codex --bin /path/to/codex --model default
agent-phonon adapter add claude-code --bin /path/to/claude --model default
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
