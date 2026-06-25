"""agent-phonon Server SDK（Python）。

让任何 Python 项目「一键成为 phonon 服务端」：导入 SDK → 配鉴权 → 监听 device →
用干净接口（discover / create_session / send / stream / on_hook）编排多台设备上的 agent。
协议帧/握手/ack/HITL 路由全由 SDK 处理。支持多设备。
"""
from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

import websockets

from .rpc import RpcPeer, new_id

# 鉴权回调：返回 tenantId 字符串表示通过，返回 None 拒绝。
Authenticate = Callable[[str, Optional[str]], Awaitable[Optional[str]]]
# HITL 裁决：返回 "continue"/"abort"/"inject"/"modify" 或 (action, reason)。
HookDecider = Callable[[dict, Optional["PhononSession"]], Awaitable[Any]]


class PhononSession:
    """一个会话。流式输出用 async iterator。"""

    def __init__(self, device: "PhononDevice", session_id: str) -> None:
        self.session_id = session_id
        self.device = device
        self._queue: asyncio.Queue = asyncio.Queue()
        self._last_seq = -1

    async def send(self, text: str, **opts: Any) -> dict:
        return await self.device.call("session.send", {"sessionId": self.session_id, "input": text, **opts})

    async def stream(self) -> AsyncIterator[dict]:
        """异步迭代本会话的流式事件，直到 final。"""
        while True:
            ev = await self._queue.get()
            yield ev
            if ev.get("final"):
                break

    async def inject(self, context: list[dict]) -> Any:
        return await self.device.call("session.inject", {"sessionId": self.session_id, "context": context})

    async def interrupt(self, reason: str | None = None) -> Any:
        return await self.device.call("session.interrupt", {"sessionId": self.session_id, "reason": reason})

    async def switch_model(self, model: str) -> Any:
        return await self.device.call("session.switchModel", {"sessionId": self.session_id, "model": model})

    async def compress(self, mode: str = "native") -> Any:
        return await self.device.call("session.compress", {"sessionId": self.session_id, "mode": mode})

    async def status(self) -> dict:
        return await self.device.call("session.status", {"sessionId": self.session_id})

    async def terminate(self) -> Any:
        return await self.device.call("session.terminate", {"sessionId": self.session_id})

    def _on_stream(self, ev: dict) -> None:
        seq = ev.get("seq", -1)
        if seq > self._last_seq:
            self._last_seq = seq
        self._queue.put_nowait(ev)


class PhononDevice:
    """一台连入的设备。"""

    def __init__(self, device_id: str, tenant_id: str, peer: RpcPeer) -> None:
        self.device_id = device_id
        self.tenant_id = tenant_id
        self._peer = peer
        self._sessions: dict[str, PhononSession] = {}
        self._hook_decider: Optional[HookDecider] = None
        self._unsolicited: Optional[Callable[[dict], None]] = None
        self._discovery_changed: Optional[Callable[[dict], None]] = None
        self._document_handler: Optional[Callable[[dict], None]] = None
        self._prepare_upload_handler: Optional[Callable[[dict], dict]] = None
        self._interaction_handler: Optional[Callable[[dict], dict]] = None
        self._workflow_event_handler: Optional[Callable[[dict], Awaitable[None] | None]] = None

    async def call(self, method: str, params: Any) -> Any:
        return await self._peer.request(method, params)

    async def discover(self) -> list[dict]:
        r = await self._peer.request("discovery.list", {})
        return r.get("agents", [])

    async def get_agent(self, agent_id: str) -> dict:
        r = await self._peer.request("discovery.get", {"agentId": agent_id})
        return r.get("agent", {})

    async def create_session(self, project: str, agent: str, model: str, **opts: Any) -> PhononSession:
        r = await self._peer.request("session.create", {"project": project, "agent": agent, "model": model, "verbosity": "messages", **opts})
        s = PhononSession(self, r["sessionId"])
        self._sessions[r["sessionId"]] = s
        return s

    async def list_sessions(self, **filt: Any) -> dict:
        return await self._peer.request("session.list", filt)

    async def info(self) -> dict:
        """设备 OS/机器信息，用于服务端做任务调度决策。"""
        return await self._peer.request("device.info", {})

    async def resources(self) -> dict:
        """设备资源快照：CPU/内存/磁盘/进程/GPU best-effort。"""
        return await self._peer.request("device.resources", {})

    async def fs_roots(self) -> dict:
        """Device-level browsable filesystem roots."""
        return await self._peer.request("device.fs.roots", {})

    async def fs_list(self, **opts: Any) -> dict:
        """Device-level directory listing under safe roots or absolute root paths."""
        return await self._peer.request("device.fs.list", opts)

    # ---- project / file / skill 便捷封装 ----
    async def project_create(self, name: str, git: bool = True, **opts: Any) -> dict:
        return await self._peer.request("project.create", {"name": name, "git": git, **opts})

    async def project_list(self) -> dict:
        return await self._peer.request("project.list", {})

    async def project_get(self, project_id: str) -> dict:
        return await self._peer.request("project.get", {"projectId": project_id})

    async def project_remove(self, project_id: str, **opts: Any) -> Any:
        return await self._peer.request("project.remove", {"projectId": project_id, **opts})

    async def worktree_create(self, project_id: str, base_branch: str, **opts: Any) -> Any:
        return await self._peer.request("project.worktree.create", {"projectId": project_id, "baseBranch": base_branch, **opts})

    async def worktree_list(self, project_id: str) -> Any:
        return await self._peer.request("project.worktree.list", {"projectId": project_id})

    async def worktree_remove(self, project_id: str, worktree_id: str, **opts: Any) -> Any:
        return await self._peer.request("project.worktree.remove", {"projectId": project_id, "worktreeId": worktree_id, **opts})

    async def git_delete_branch(self, project_id: str, branch: str, **opts: Any) -> Any:
        return await self._peer.request("project.git.deleteBranch", {"projectId": project_id, "branch": branch, **opts})

    # v0.7: 6 个底层 git 操作
    async def git_commit(self, project_id: str, message: str, **opts: Any) -> dict:
        return await self._peer.request("project.git.commit", {"projectId": project_id, "message": message, **opts})

    async def git_merge(self, project_id: str, source_branch: str, **opts: Any) -> dict:
        params: dict = {"projectId": project_id, "sourceBranch": source_branch}
        for k in ("targetBranch", "strategy", "message", "abortOnConflict"):
            if k in opts: params[k] = opts[k]
        return await self._peer.request("project.git.merge", params)

    async def git_diff(self, project_id: str, **opts: Any) -> dict:
        return await self._peer.request("project.git.diff", {"projectId": project_id, **opts})

    async def git_log(self, project_id: str, **opts: Any) -> dict:
        return await self._peer.request("project.git.log", {"projectId": project_id, **opts})

    async def git_push(self, project_id: str, branch: str, **opts: Any) -> dict:
        return await self._peer.request("project.git.push", {"projectId": project_id, "branch": branch, **opts})

    async def git_status(self, project_id: str, **opts: Any) -> dict:
        return await self._peer.request("project.git.status", {"projectId": project_id, **opts})

    async def project_exec(self, project_id: str, command: str, args: list[str] | None = None, **opts: Any) -> dict:
        return await self._peer.request("project.exec", {"projectId": project_id, "command": command, "args": args or [], **opts})

    async def env_set(self, scope: str, name: str, value: str, **opts: Any) -> dict:
        return await self._peer.request("env.set", {"scope": scope, "name": name, "value": value, **opts})

    async def env_list(self, **opts: Any) -> dict:
        return await self._peer.request("env.list", opts)

    async def env_delete(self, scope: str, name: str, **opts: Any) -> dict:
        return await self._peer.request("env.delete", {"scope": scope, "name": name, **opts})

    async def file_read(self, project_id: str, path: str, **opts: Any) -> dict:
        return await self._peer.request("file.read", {"projectId": project_id, "path": path, **opts})

    async def file_write(self, project_id: str, path: str, data: str, **opts: Any) -> dict:
        return await self._peer.request("file.write", {"projectId": project_id, "path": path, "data": data, **opts})

    async def file_list(self, project_id: str, path: str = ".", **opts: Any) -> dict:
        return await self._peer.request("file.list", {"projectId": project_id, "path": path, **opts})

    async def file_stat(self, project_id: str, path: str, **opts: Any) -> dict:
        return await self._peer.request("file.stat", {"projectId": project_id, "path": path, **opts})

    async def file_mkdir(self, project_id: str, path: str, **opts: Any) -> dict:
        return await self._peer.request("file.mkdir", {"projectId": project_id, "path": path, **opts})

    async def skill_install(self, agent: str, name: str, scope: str, source: dict, project_id: str | None = None) -> Any:
        return await self._peer.request("skill.install", {"agent": agent, "name": name, "scope": scope, "projectId": project_id, "source": source})

    async def skill_uninstall(self, agent: str, name: str, scope: str, project_id: str | None = None) -> Any:
        return await self._peer.request("skill.uninstall", {"agent": agent, "name": name, "scope": scope, "projectId": project_id})

    async def skill_list(self, **filt: Any) -> dict:
        return await self._peer.request("skill.list", filt)

    async def skill_dirs(self, **filt: Any) -> dict:
        return await self._peer.request("skill.dirs", filt)

    async def workflow_run(
        self,
        *,
        plan: dict,
        project: str | None = None,
        worktree_id: str | None = None,
        branch: str | None = None,
        input: str | None = None,
        policy: dict | None = None,
        shared_context: dict | None = None,
        resume_from: dict | None = None,
        client_request_id: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """Start (or resume) an L3 workflow.

        plan: { mode: "dag" | "graph" | "discussion", ... }
        policy: { onNodeFailure?: "fail_workflow"|"skip_dependents"|"continue",
                  timeoutSeconds?, perNodeTimeoutSeconds?, maxParallel? }
        shared_context: { text?, files?, placement: "prepend"|"append" }
        resume_from: { workflowId, strategy, rerunNodes? }
        """
        params: dict = {"plan": plan}
        if project is not None:
            params["project"] = project
        if worktree_id is not None:
            params["worktreeId"] = worktree_id
        if branch is not None:
            params["branch"] = branch
        if input is not None:
            params["input"] = input
        if policy is not None:
            params["policy"] = policy
        if shared_context is not None:
            params["sharedContext"] = shared_context
        if resume_from is not None:
            params["resumeFrom"] = resume_from
        if client_request_id is not None:
            params["clientRequestId"] = client_request_id
        if metadata is not None:
            params["metadata"] = metadata
        return await self._peer.request("workflow.run", params)

    async def workflow_status(self, workflow_id: str) -> dict:
        return await self._peer.request("workflow.status", {"workflowId": workflow_id})

    async def workflow_resume(
        self,
        workflow_id: str,
        strategy: str = "failed_node",
        rerun_nodes: list[str] | None = None,
        feedback: str | None = None,
        shared_context_patch: dict | None = None,
    ) -> dict:
        params: dict = {"workflowId": workflow_id, "strategy": strategy}
        if rerun_nodes is not None:
            params["rerunNodes"] = rerun_nodes
        if feedback is not None:
            params["feedback"] = feedback
        if shared_context_patch is not None:
            params["sharedContextPatch"] = shared_context_patch
        return await self._peer.request("workflow.resume", params)

    async def workflow_cancel(self, workflow_id: str, reason: str | None = None) -> dict:
        return await self._peer.request("workflow.cancel", {"workflowId": workflow_id, "reason": reason})

    async def workflow_list(
        self,
        *,
        status: str | None = None,
        project_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict:
        params: dict = {}
        if status is not None: params["status"] = status
        if project_id is not None: params["projectId"] = project_id
        if since is not None: params["since"] = since
        if until is not None: params["until"] = until
        if limit is not None: params["limit"] = limit
        if cursor is not None: params["cursor"] = cursor
        return await self._peer.request("workflow.list", params)

    async def workflow_ack(self, workflow_id: str, last_seq: int) -> None:
        """Acknowledge workflow.event seq<=last_seq (parallel to stream.ack, P0-3).
        一般不需调用：SDK 在 workflow.event 入口已自动 ack。
        """
        await self._peer.notify("workflow.ack", {"workflowId": workflow_id, "lastSeq": last_seq})

    async def workflow_events_list(self, workflow_id: str, after_seq: int | None = None, limit: int | None = None) -> dict:
        params: dict = {"workflowId": workflow_id}
        if after_seq is not None: params["afterSeq"] = after_seq
        if limit is not None: params["limit"] = limit
        return await self._peer.request("workflow.events.list", params)

    async def workflow_artifact_register(self, workflow_id: str, kind: str, path: str, **opts: Any) -> dict:
        return await self._peer.request("workflow.artifact.register", {"workflowId": workflow_id, "kind": kind, "path": path, **opts})

    async def workflow_artifacts_list(self, workflow_id: str) -> dict:
        return await self._peer.request("workflow.artifacts.list", {"workflowId": workflow_id})

    def set_hook_decider(self, fn: HookDecider) -> None:
        self._hook_decider = fn

    def set_unsolicited_handler(self, fn: Callable[[dict], None]) -> None:
        self._unsolicited = fn

    def set_discovery_changed_handler(self, fn: Callable[[dict], None]) -> None:
        self._discovery_changed = fn

    def set_document_handler(self, fn: Callable[[dict], None]) -> None:
        self._document_handler = fn

    def set_prepare_upload_handler(self, fn: Callable[[dict], dict]) -> None:
        self._prepare_upload_handler = fn

    def set_interaction_handler(self, fn: Callable[[dict], dict]) -> None:
        self._interaction_handler = fn

    def set_workflow_event_handler(self, fn: Callable[[dict], Awaitable[None] | None]) -> None:
        self._workflow_event_handler = fn

    async def _handle_inbound(self, method: str, params: Any) -> Any:
        if method == "stream.event":
            ev = params or {}
            s = self._sessions.get(ev.get("sessionId"))
            if s is not None:
                s._on_stream(ev)
                await self._peer.notify("stream.ack", {"sessionId": ev.get("sessionId"), "lastSeq": s._last_seq})
            elif ev.get("origin") == "unsolicited" and self._unsolicited:
                self._unsolicited(ev)
            return None
        if method == "hook.fired":
            s = self._sessions.get((params or {}).get("sessionId"))
            if not self._hook_decider:
                return {"applied": True}
            d = await self._hook_decider(params, s)
            if isinstance(d, tuple):
                return {"action": d[0], "reason": d[1]}
            return {"action": d}
        if method == "discovery.changed":
            if self._discovery_changed:
                self._discovery_changed(params or {})
            return None
        if method == "workflow.event":
            ev = params or {}
            if self._workflow_event_handler:
                res = self._workflow_event_handler(ev)
                if asyncio.iscoroutine(res):
                    await res
            wid = ev.get("workflowId")
            seq = ev.get("seq")
            if wid and isinstance(seq, int):
                await self._peer.notify("workflow.ack", {"workflowId": wid, "lastSeq": seq})
            return None
        if method == "document.send":
            if self._document_handler:
                res = self._document_handler(params or {})
                if asyncio.iscoroutine(res):
                    res = await res
                if isinstance(res, dict):
                    return res
            return {"delivered": []}
        if method == "document.prepare_upload":
            if self._prepare_upload_handler:
                res = self._prepare_upload_handler(params or {})
                if asyncio.iscoroutine(res):
                    res = await res
                return res
            return {"uploadRef": new_id(), "uploadUrl": "", "method": "PUT"}
        if method == "interaction.request":
            if self._interaction_handler:
                res = self._interaction_handler(params or {})
                if asyncio.iscoroutine(res):
                    res = await res
                return res
            return {"requestId": (params or {}).get("requestId"), "action": "cancel"}
        return None

    def _on_close(self) -> None:
        self._peer.reject_all("device disconnected")


class PhononServer:
    """监听 ws，管理多设备。"""

    def __init__(self, host: str = "127.0.0.1", port: int = 0, authenticate: Optional[Authenticate] = None) -> None:
        self._host = host
        self._port = port
        self._authenticate = authenticate
        self._devices: dict[str, PhononDevice] = {}
        self._on_device: Optional[Callable[[PhononDevice], Awaitable[None]]] = None
        self._server: Any = None
        self.port = port

    def on_device(self, fn: Callable[[PhononDevice], Awaitable[None]]) -> Callable:
        """装饰器/setter：设备拨入时回调。"""
        self._on_device = fn
        return fn

    def list_devices(self) -> list[PhononDevice]:
        return list(self._devices.values())

    def get_device(self, device_id: str) -> Optional[PhononDevice]:
        return self._devices.get(device_id)

    async def listen(self) -> int:
        self._server = await websockets.serve(self._on_connection, self._host, self._port)
        sock = list(self._server.sockets)[0]
        self.port = sock.getsockname()[1]
        return self.port

    async def _on_connection(self, ws: Any) -> None:
        device: Optional[PhononDevice] = None

        async def send(data: str) -> None:
            await ws.send(data)

        async def handler(method: str, params: Any) -> Any:
            nonlocal device
            if method == "connect.hello":
                p = params or {}
                device_id = p.get("deviceId")
                device_key = (p.get("auth") or {}).get("deviceKey")
                if self._authenticate:
                    tenant = await self._authenticate(device_id, device_key)
                else:
                    tenant = f"tenant-{device_id}"
                if tenant is None:
                    raise PermissionError("unauthorized")
                device = PhononDevice(device_id, tenant, peer)
                self._devices[device_id] = device
                if self._on_device:
                    asyncio.create_task(self._on_device(device))
                import datetime
                return {"protocolVersion": "0.1.0", "tenantId": tenant, "features": [], "at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            if device is None:
                raise RuntimeError("not connected")
            return await device._handle_inbound(method, params)

        peer = RpcPeer(send, handler)
        try:
            async for raw in ws:
                await peer.handle(raw if isinstance(raw, str) else raw.decode())
        finally:
            if device is not None:
                self._devices.pop(device.device_id, None)
                device._on_close()

    async def close(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
