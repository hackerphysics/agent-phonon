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

`skill_install(..., client_request_id="original-key")` and
`skill_uninstall(..., client_request_id="original-key")` preserve optional native
retry identity. Keep the exact original payload; a changed target/content or
unverifiable old receipt is rejected by devices advertising
`skill_namespace_identity_v1`. This is confirmed-receipt identity, not permission
to repeat an uncertain filesystem write or a durable exactly-once guarantee.
- **`PhononSession`** — `send()` + `async for event in session.stream()`（流式）；`inject/interrupt/switch_model/compress/status/terminate`；自动 stream.ack

`send(..., whenBusy="inject")` 只有在当前 turn 的工具间隙实际应用输入后才返回
`disposition="injected"`，返回当前 turnId。不支持时明确失败；只有调用方显式传入
`fallback` 才允许降级。`session.inject` 是另一个上下文接口，不等于执行中插入。
详见 [current-turn input contract](../docs/MID_TURN_INPUT.md)。

手动压缩使用 `await session.compress("native", clientRequestId=operation_id,
background=True)` 接收持久操作，再用
`await session.compression_status(operation_id)` 查询结果。要求设备能力
`session_compression_receipts_v1` 和当前 Session 的实际可用性；`running` 不是成功，
`noop` 不算已压缩，`unknown` 不自动重试。完整状态与恢复限制见
[Session Compression](../docs/SESSION_COMPRESSION.md)。

显式恢复使用 `await session.recover(project="registered-project", agent="codex",
model="model")`，要求 `session_recovery_v1`，并验证原生检查点与原会话身份。
这不会发送输入、恢复队列或重跑 workflow；`status().recovery.canAttempt` 只是
可尝试验证，不是已恢复。中断、缺失和未支持的原生会话保持阻塞，详见
[Verified Session Recovery](../docs/SESSION_RECOVERY.md)。

逐轮思考级别可用 `await session.send("task", reasoning={"level": "high"})`，
`{"level": None}` 恢复原生默认值。要求 `turn_reasoning_v1`、执行器及当前模型的能力；
消费 `runtime_settings` 事件确认 Harness 实际设置，不能把 send ACK 当成设置确认。
workflow node 支持同样字段，详见 [Per-Turn Reasoning](../docs/TURN_REASONING.md)。
该字段是可选偏好；元数据缺失或设置未确认不应拦住原始消息，也不等于任务失败。

## Existing Directory Selection

`await device.fs_list(projectCandidates=True, directoryInput="/work/proj",
limit=100)` returns native one-level path suggestions and observed identities.
Register the selected existing path with
`await device.project_create("Project", path=selected_path, git=False,
existingDirectoryIdentity=observed_identity, clientRequestId=original_id)`.
Both operations require `workspace_directory_picker_v1`; there is no legacy
fallback. Registration preserves existing files and does not initialize Git,
create a directory or start an Agent. Keep current account/Project authority
separate from filesystem identity. See
[Existing Workspace Directories](../docs/WORKSPACE_DIRECTORIES.md) for policy,
identity revalidation, retries and Windows acceptance limits.

## RPC Deadlines

For a bounded read, use `await device.call("session.status", {"sessionId": sid},
timeout=12.0)` in Python (seconds), or
`await device.call("session.status", {sessionId: sid}, 12_000)` in TypeScript
(milliseconds). Omitting the deadline preserves the 600-second default. Expiry
removes the local pending RPC; it does not cancel remote execution or prove that
a mutating request was not accepted. Neither SDK automatically resubmits it.

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

## Native chat recovery

`await device.replay_stream(session_id, fromSeq=0, limit=200)` resends retained
unacknowledged frames without restarting a turn or ACKing them.
`await device.workflow_cancel_dispatch(dispatch_key, project, reason="Stop")`
records a durable cancellation even when the workflow ID is not yet known.
`await device.interaction_status(request_id)` reads a tenant-bound durable form
receipt, distinguishing delivered input from an agent's consumption acknowledgement.
See [Native Agent Interactions](../docs/NATIVE_INTERACTIONS.md).

`device.set_conversation_board_handler(handler)` handles controller-stamped
`conversation.board` reads/writes. Async handlers are awaited; an absent handler
is unsupported, not a successful empty board. Authorize the source and persist
versioned writes before responding. See [Native Boards](../docs/NATIVE_BOARDS.md).
`device.set_conversation_workflow_handler(handler)` handles controller-stamped
`conversation.workflow` catalog/execute/status requests. Missing handlers fail
explicitly; human review, canonical resources, frozen intent and durable
cross-device execution remain the control plane's responsibility. See
[Native Workflows](../docs/NATIVE_WORKFLOWS.md).
`device.set_conversation_message_handler(handler)` handles current-turn
`conversation.message` members/send/status requests. Futures/async handlers are
awaited; missing handlers fail rather than return fabricated acceptance. DE-only
membership, explicit mentions, causal budgets and actual recipient receipts are
control-plane responsibilities. See [Native Group Messages](../docs/NATIVE_GROUP_MESSAGES.md).
`await device.employee_profile_apply(**params)` and
`await device.employee_profile_status(employee_id)` install/read an isolated DE
under explicit device-local policy. See [Employee Profiles](../docs/EMPLOYEE_PROFILES.md).
The daemon enforces tenant/project scope. See [Native Chat](../docs/NATIVE_CHAT.md)
for capability negotiation and retained Session semantics.

## Durable Conversation Archives

`await device.conversation_archive_status(scope)`,
`await device.conversation_archive_append(params)`,
`await device.conversation_archive_read(params)` and
`await device.conversation_archive_entities(params)` match TS
`device.conversationArchive.status/append/read/entities`. They store/read normalized
Phonon history, never invoke an Agent, and require explicit local archive policy
and a persistent device database. Keep decimal cursors as strings and
`payloadJSON` frozen on retry. Request-specific `committedThrough/committedHash`
can be older than the current head; neither is proof every historical byte or
attachment was reverified. See [Conversation Archives](../docs/CONVERSATION_ARCHIVE.md)
for pinned pagination, hash serialization, capacity and safe-retention boundaries.
The optional indexed-entity capability returns complete version/fragment
references at a pinned checkpoint; it does not return parsed message bodies.
Legacy entries/hashes still work, but are not retroactively indexed.
The optional `conversation_archive_blobs_v1` capability exposes
`conversation_archive_blob_write/status/read(params)`, matching TypeScript
`device.conversationArchive.blob.write/status/read`. Files use scoped immutable
manifests, 256 KiB base64 wire chunks, binary SQLite storage and whole-file
checksum verification before completion. Partial uploads survive restart and
cannot be read as completed files. These SDKs provide no automatic replication
or server cleanup policy.

## Listener authentication and local regression tests

Reliable stream handlers may return `True` for the current frame or
`{"ackSeq": committed_contiguous_cursor}` after persistence; the latter can
cover a filled gap. Invalid/below-frame/unsafe cursors never ACK. Native proactive
provenance is retained in the parameter dictionary, and reserved proactive frames
do not fall back to ordinary Session auto-ACK without a reliable consumer. See
[`NATIVE_PROACTIVE.md`](../docs/NATIVE_PROACTIVE.md) for scope and capability limits.

Conversation workflow callbacks preserve optional node `attachmentIDs` and
`artifactSources`. File fields name
explicit scoped inputs and direct dependency output sources; the control plane
must transfer and verify real target bytes before model dispatch. They are not
device paths or permission to forward files across conversations.

Conversation workflow callbacks receive optional `delivery="detached"` unchanged
in their parameter dictionary. `native_detached_workflow_v1` devices can submit a
durable plan without holding the source turn open; a `status` response is not
completion. Omitted/`wait` delivery retains synchronous behavior. Request IDs and
the complete payload remain immutable on retry. See
[`NATIVE_WORKFLOWS.md`](../docs/NATIVE_WORKFLOWS.md) for scope and report recovery.

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

## Managed MCP

For devices advertising `managed_mcp_v1`, use
`await device.mcp_configure(revision, bindings)` and `await device.mcp_status()`.
Bindings contain only `id`, `agentId` and `enabled`. Explicit local owner consent
is required; secrets and arbitrary commands are not accepted. See
[Managed MCP](../docs/MANAGED_MCP.md) for permissions, revocation and status semantics.
### Structured Skill Selection

Nonce-bearing installation receipts can be observed with
`await device.skill_install_status(agent, name, scope, client_request_id, project_id)`.
Project scope requires `project_id`; global scope omits it. Read-only states
distinguish preparation, dispatch, confirmation and uncertain effects. Never retry
an unknown write with another ID. A confirmed receipt is the original historical
result, not a current-filesystem certificate. This requires a matching native
receiver reporting `skill_install_receipts_v1`; see `docs/NATIVE_SKILL_INSTALL_RECEIPTS.md`.

With `skill_install_receiver_identity_v1`, `await device.info()` additionally
returns a persistent account-namespace `skillReceiverID`. Pass that exact value
as keyword-only `expected_receiver_id=` to `skill_publish`, and request original
receipt proof with `skill_install_status(..., include_receiver_identity=True)`.
The returned `receiverID` exists only for a matching originally tagged record;
old receipts are not backfilled. Defaults keep the old response shape. This ID
is not a credential or grant, and a missing/changed ID never permits a new write
or authorizes another account, lease, Project or human decision.

Privileged recovery separately opts into
`skill_install_status(..., include_recovery_context=True)` and
`skill_install_fence(agent, name, project_id, original_request_id,
expected_receiver_id, base_recovery_revision, client_request_id)`. It requires
explicit local `allowSkillRecovery` and exact observed scope/revision. The
receipt remains unknown with its target locked and files undeleted; this is not
an Agent approval, unlock, successful installation or filesystem cleanup. See
`docs/NATIVE_SKILL_FENCES.md` for the intentionally unfinished release gates.

Immutable Project versions use the separate
`await device.skill_publish(agent, name, project_id, source, base_revision, client_request_id)`.
Use `None` only for an absent selection, otherwise its actual `revision`.
`await device.skill_unpublish(agent, name, project_id, base_revision, client_request_id)`
deactivates and revokes queued references without deleting files. Neither method
falls back to legacy installation; a matching receiver/runtime is required.

```python
await session.send("Continue the development task", skills=[{
    "name": "product-intent-canvas", "scope": "project",
    "version": "1.3.0", "force": True,
}])
```

The receiver requires a current confirmed installation in the authenticated
namespace and checks the requested scope/version. `force` controls loading
intent, not permissions or human approval. Queued turns retain their original
installation identity; a changed installation/content/root is not substituted.
Legacy unconfirmed metadata and missing packaged native assets remain unavailable
for managed selection. This does not establish complete MCP installation or
installed-model/three-device acceptance.

Exact immutable selections can additionally retain the native descriptor's
`revision` and `publication.versionId` as selector `installationId`:

```python
selected = {"name": skill["name"], "scope": "project",
            "revision": skill["revision"],
            "installationId": skill["publication"]["versionId"]}
await device.workflow_run(project=owned_runtime_project, client_request_id=original_id,
                          plan={"mode": "dag", "nodes": [{"nodeId": "work",
                                "agent": agent, "model": model,
                                "input": task, "skills": [selected]}]})
```

Workflow nodes use the existing session loading boundary; pins are not grants.
The SDK verifies `workflow_skill_selection_v1`/`pinned_skill_selection_v1` before
new-feature mutations and never falls back to unpinned context. Session and
schedule helpers preserve pins too. Old unskilled calls add no capability probe.
Raw RPC users and durable commit-to-send controllers must perform preparation at
the correct boundary; see `../docs/WORKFLOW_SKILLS.md`. This does not finish the
Phonon Canvas dispatcher or real three-device/model acceptance.
# Controlled Workspace Preparation

`project_provision(client_request_id, name, expected_receiver_id)` checks the
actual device capability/receiver and forwards the fixed path-free request.
`project_provision_status(client_request_id, expected_receiver_id)` observes its
original durable state without reissuing directory creation. It may let the
controller finish original metadata registration from an actual saved receipt;
an uncertain filesystem result remains unknown. This default-off native feature
requires an explicit local host policy and qualified runtime assets. It is not a
new MCP permission/approval API or proof of three-device readiness; see
`../docs/PROJECT_PROVISIONING.md`.
