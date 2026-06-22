# @agent-phonon/protocol

> agent-phonon 的**线协议**——phonon 设备与服务端之间的唯一契约。
> zod schema + TS 类型 + 方法注册表的单一事实来源。对应设计：[`../../docs/design.md`](../../docs/design.md)。

## 是什么

任何想调度本机 agent 的服务端，都通过这套协议和 phonon 通信。本包用 **zod** 定义全部消息形状，既是运行时校验、又是编译期类型，还能导出 **JSON Schema** 给非 TS 的服务端（Python/Go…）消费。

## 传输模型（design D2）

单条 **WebSocket** 上双向跑 **JSON-RPC 2.0**，两端皆可作 requester：

| 方向 | 方法 |
|------|------|
| **phonon → server** (`p2s`) | `connect.hello`、`discovery.changed`、`stream.event`、`hook.fired` |
| **server → phonon** (`s2p`) | `discovery.list/get`、`session.*`、`hook.resolve` |

## 方法一览（33 个）

```
connect.hello        握手：协议版本 + 设备身份 → 服务端回 tenant 绑定
discovery.list/get   发现：本机有哪些 agent 可用、各自哪些模型（design §5）
discovery.changed    可用性变化时 phonon 主动推
session.create       建会话，必须绑定 agent + model（D15）
session.send         发任务＝对话；结果走 stream.event 异步流式回
session.inject       上下文注入
session.compress     压缩双模 native | custom（D7）
session.terminate    结束会话
session.status/list   查会话（始终携带 agent 身份）
stream.event         phonon 上推流式结果（按 verbosity 分档）
hook.fired           到 hook 点抛事件，阻塞等服务端裁决（HITL，design §8）
hook.resolve         服务端裁决：continue | inject | modify | abort
```

## 核心设计点

- **session 必绑 agent**（D15）：`session.create` 的 `agent`(来自 discovery 的 agentId) + `model` 必填，全生命周期携带。
- **verbosity 4 档**：`final | messages | tools | trace`，控制返回内容多少。
- **HITL 甩锅服务端**（design §8）：phonon 只做 `hook.fired` → 阻塞等 `hook.resolve`，问不问真人由服务端决定。
- **tenant 隔离错误码**：`errSessionNotInTenant` 等，挂在 JSON-RPC `error.data.appCode`。
- **方法注册表** `METHODS`：声明每个方法的 direction/kind/params/result，core 与 client-sdk 共享同一份，机器可校验。

## 用法

```ts
import { parseParams, parseResult, METHODS, StreamEvent } from "@agent-phonon/protocol";

// 校验入参
const p = parseParams("session.create", { agent: "openclaw", model: "claude-opus-4.8" });

// 取类型
type CreateParams = import("@agent-phonon/protocol").ParamsOf<"session.create">;

// 校验流式事件
const ev = StreamEvent.parse(incoming);
```

## 脚本

```bash
pnpm build         # tsc → dist/
pnpm typecheck     # 仅类型检查
pnpm test          # build + node --test（10 个契约测试）
pnpm json-schema   # 导出 dist/json-schema/*.json（供非 TS 服务端）
```

## 状态

🚧 **v0.0.1 草案** — 协议仍在和需求方对齐中，字段可能调整。未发布。
