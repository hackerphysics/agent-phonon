# agent-phonon — Python Server SDK

让任何 Python 项目「一键成为 agent-phonon 服务端」：编排**多台设备**上的 AI agent（Claude Code / Codex / OpenCode / OpenClaw / Hermes）。

## 安装

```bash
pip install agent-phonon   # 或 pip install -e sdk-python/
```

## 用法

```python
import asyncio
from agent_phonon import PhononServer

async def main():
    server = PhononServer(port=8080, authenticate=verify_device)

    @server.on_device
    async def handle(device):                       # 每台设备拨入时
        agents = await device.discover()            # 列设备上的 agent
        proj = await device.project_create("my-proj")
        session = await device.create_session(
            project=proj["project"]["projectId"],
            agent="openclaw:main", model="claude-opus-4.8",
        )
        # HITL：危险操作裁决
        device.set_hook_decider(
            lambda hook, s: "abort" if "rm -rf" in str(hook.get("payload", {})) else "continue"
        )
        await session.send("帮我重构这个函数")
        async for event in session.stream():        # 流式输出
            if event.get("type") == "message":
                print(event["text"], end="")

    await server.listen()
    await asyncio.Future()  # 长跑

async def verify_device(device_id, device_key):
    return "tenant-1" if device_key == "secret" else None  # None = 拒绝

asyncio.run(main())
```

## 核心抽象

- **`PhononServer`** — ws 监听，管理多设备；`authenticate(device_id, device_key) -> tenant_id | None`；`on_device` 回调；`list_devices()` / `get_device()`
- **`PhononDevice`** — `discover()` / `create_session()` / `list_sessions()` + `project_*` / `skill_*` 封装；`set_hook_decider()`（HITL）/ `set_unsolicited_handler()`（自发输出）
- **`PhononSession`** — `send()` + `async for event in session.stream()`（流式）；`inject/interrupt/switch_model/compress/status/terminate`；自动 stream.ack

## 多设备

一个 `PhononServer` 同时连多个 phonon 设备，各设备 tenant 隔离、互不干扰——这是 phonon 作为「个人设备编排中心」的核心。

## 协议

JSON-RPC 2.0 over WebSocket。与 TS SDK（`@agent-phonon/server-sdk`）完全协议兼容——Python 服务端能指挥 TS phonon，反之亦然。


## Registered configuration editing

`await device.maintenance_config_edit(target_id, config_id, expected_sha256,
[{"oldText": "before", "newText": "after"}], reason="authorized repair",
clientRequestId="unique-id")` matches TS `device.maintenance.configEdit`.
Get the SHA with `maintenance_config_get`, verify with another get, and use
`maintenance_rollback(backup_id, expected_current_sha256)` to restore original bytes.
The device must explicitly register public text visibility and write permissions;
structured root allowlists still apply. No arbitrary paths, shell or redacted-document replacement.
JSON/JSONC/YAML also support the existing RFC7396 `maintenance_config_patch`;
TOML and plain UTF-8 text are exact-edit only. See `docs/PROTOCOL.md` for limits.

## Listener authentication and local regression tests

`PhononServer()` binds **127.0.0.1**, not a wildcard. Local loopback use may omit
`authenticate`; any explicit non-loopback host requires authentication by
**default** and otherwise `await server.listen()` raises `ValueError` **before
binding**. To deliberately expose an anonymous server, the keyword-only option
is `allow_anonymous=True` (TS: `allowAnonymous: true`). This is an unsafe opt-in,
not the recommended deployment mode; it never bypasses a supplied callback.

`authenticate` retains its existing **async** contract: awaitable returning a
tenant-ID string on acceptance or `None` on rejection, for example:

```python
async def authenticate(device_id, device_key):
    # Look up and verify the device using your server-side credential store.
    return await verify_registered_device(device_id, device_key)  # tenant ID or None

server = PhononServer(host="127.0.0.1", authenticate=authenticate)
```

Transport encryption and tenant pinning belong to the device client configuration:
remote plaintext is rejected unless the owner explicitly sets `allowInsecure`;
`expectedTenantId` rejects a mismatched welcome. Tenant string equality is not a
substitute for TLS or credential verification. See [local test entrypoints](../docs/LOCAL_TESTING.md)
for `pnpm test:python` (three SDK scenarios + authentication unittest/cross-language
Node-client checks). RPC method-string consistency alone does not test security behavior.
