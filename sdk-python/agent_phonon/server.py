"""agent-phonon Server SDK（Python）。

让任何 Python 项目「一键成为 phonon 服务端」：导入 SDK → 配鉴权 → 监听 device →
用干净接口（discover / create_session / send / stream / on_hook）编排多台设备上的 agent。
协议帧/握手/ack/HITL 路由全由 SDK 处理。支持多设备。
"""
from __future__ import annotations

import asyncio
import inspect
from copy import deepcopy
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, TypedDict, Union, Sequence, Literal

import websockets

from .rpc import RpcPeer, new_id

# 鉴权回调：返回 tenantId 字符串表示通过，返回 None 拒绝。
Authenticate = Callable[[str, Optional[str]], Awaitable[Optional[str]]]
# HITL 裁决：返回 "continue"/"abort"/"inject"/"modify" 或 (action, reason)。
HookDecider = Callable[[dict, Optional["PhononSession"]], Awaitable[Any]]


class _SkillName(TypedDict):
    name: str


class SkillReference(_SkillName, total=False):
    version: str
    scope: Literal["global", "project"]
    force: bool
    revision: str
    installationId: str


SkillSelection = Union[str, SkillReference]


def _workflow_skills(plan: dict) -> list[SkillSelection]:
    mode = plan.get("mode")
    if mode == "dag":
        nodes = plan.get("nodes")
    elif mode == "graph":
        nodes = [plan.get("executor"), *plan.get("workers", [])]
    elif mode == "discussion":
        nodes = plan.get("participants")
    else:
        raise ValueError("invalid_workflow_plan")
    if not isinstance(nodes, (list, tuple)):
        raise ValueError("invalid_workflow_plan")
    selected: list[SkillSelection] = []
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("invalid_workflow_plan")
        if "skills" in node:
            if not isinstance(node["skills"], (list, tuple)):
                raise ValueError("invalid_workflow_skill_selection")
            selected.extend(node["skills"])
    return selected


def _pinned_skills(skills: Sequence[SkillSelection]) -> bool:
    return any(isinstance(value, dict) and ("revision" in value or "installationId" in value) for value in skills)


def _target_skills(target: dict | None) -> tuple[list[SkillSelection], bool]:
    if target is None:
        return [], False
    direct = target.get("skills", [])
    if not isinstance(direct, (list, tuple)):
        raise ValueError("invalid_skill_selection")
    workflow = _workflow_skills(target["plan"]) if target.get("plan") is not None else []
    return [*direct, *workflow], bool(workflow)


async def _require_skill_capabilities(device: PhononDevice, skills: Sequence[SkillSelection], workflow: bool) -> None:
    required = (["workflow_skill_selection_v1"] if workflow and skills else []) + (["pinned_skill_selection_v1"] if _pinned_skills(skills) else [])
    if not required:
        return
    info = await device.info()
    capabilities = info.get("capabilities") if isinstance(info, dict) else None
    if not isinstance(capabilities, list) or any(flag not in capabilities for flag in required):
        raise RuntimeError("skill_selection_device_update_required")


class PhononSession:
    """一个会话。流式输出用 async iterator。"""

    def __init__(self, device: "PhononDevice", session_id: str) -> None:
        self.session_id = session_id
        self.device = device
        self._queue: asyncio.Queue = asyncio.Queue()
        self._last_seq = -1

    async def send(self, text: str, *, skills: Optional[Sequence[SkillSelection]] = None, **opts: Any) -> dict:
        """Forward whenBusy/fallback/turnId/clientRequestId without changing modes.

        inject acknowledges actual application to the current turn; unsupported
        modes fail unless the caller explicitly provides a supported fallback.
        """
        payload = {"sessionId": self.session_id, "input": text, **opts}
        if skills is not None:
            payload["skills"] = list(skills)
        if _pinned_skills(payload.get("skills", [])):
            payload = deepcopy(payload)
            await _require_skill_capabilities(self.device, payload["skills"], False)
        return await self.device.call("session.send", payload)

    async def recover(self, *, project: str, agent: str, model: str) -> dict:
        """Verify/reopen the same settled native Session; never sends input."""
        return await self.device.call("session.recover", {"sessionId": self.session_id, "project": project, "agent": agent, "model": model})

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

    async def compress(self, mode: str = "native", **opts: Any) -> Any:
        return await self.device.call("session.compress", {"sessionId": self.session_id, "mode": mode, **opts})

    async def compression_status(self, operation_id: str) -> Any:
        return await self.device.call("session.compression.status", {"sessionId": self.session_id, "operationId": operation_id})

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

    def __init__(self, device_id: str, tenant_id: str, peer: RpcPeer, close_transport=None) -> None:
        self.device_id = device_id
        self.tenant_id = tenant_id
        self._peer = peer
        self._close_transport = close_transport
        self._sessions: dict[str, PhononSession] = {}
        self._hook_decider: Optional[HookDecider] = None
        self._unsolicited: Optional[Callable[[dict], None]] = None
        self._discovery_changed: Optional[Callable[[dict], None]] = None
        self._document_handler: Optional[Callable[[dict], None]] = None
        self._prepare_upload_handler: Optional[Callable[[dict], dict]] = None
        self._interaction_handler: Optional[Callable[[dict], dict]] = None
        self._conversation_board_handler: Optional[Callable[[dict], Any]] = None
        self._conversation_workflow_handler: Optional[Callable[[dict], Any]] = None
        self._conversation_message_handler: Optional[Callable[[dict], Any]] = None
        self._project_coordination_handler: Optional[Callable[[dict], Any]] = None
        self._project_coordination_evidence_handler: Optional[Callable[[dict], Any]] = None
        self._stream_event_handler: Optional[Callable[[dict], Awaitable[bool | dict] | bool | dict]] = None
        self._workflow_event_handler: Optional[Callable[[dict], Awaitable[None] | None]] = None
        self._schedule_changed_handler: Optional[Callable[[dict], None]] = None
        self._run_started_handler: Optional[Callable[[dict], None]] = None
        self._run_event_handler: Optional[Callable[[dict], None]] = None
        self._run_finished_handler: Optional[Callable[[dict], Awaitable[None] | None]] = None

    async def call(self, method: str, params: Any, timeout: Optional[float] = None) -> Any:
        """Bound the reply wait in seconds, not the remote operation's lifetime."""
        if timeout is None:
            return await self._peer.request(method, params)
        return await self._peer.request(method, params, timeout=timeout)

    async def mcp_configure(self, revision: int, bindings: list[dict]) -> dict:
        return await self._peer.request("mcp.configure", {"revision": revision, "bindings": bindings})

    async def mcp_status(self) -> dict:
        return await self._peer.request("mcp.status", {})

    async def conversation_archive_blob_write(self, params: dict) -> dict:
        return await self._peer.request("conversation.archive.blob.write", params)

    async def conversation_archive_blob_status(self, params: dict) -> dict:
        return await self._peer.request("conversation.archive.blob.status", params)

    async def conversation_archive_blob_read(self, params: dict) -> dict:
        return await self._peer.request("conversation.archive.blob.read", params)

    async def conversation_archive_append(self, params: dict) -> dict:
        """Append a frozen contiguous archive batch; never executes an agent."""
        return await self._peer.request("conversation.archive.append", params)

    async def conversation_archive_read(self, params: dict) -> dict:
        """Read a bounded, hash-checked range from permanent device history."""
        return await self._peer.request("conversation.archive.read", params)

    async def conversation_archive_status(self, params: dict) -> dict:
        """Inspect the original archive identity and committed checkpoint."""
        return await self._peer.request("conversation.archive.status", params)

    async def conversation_archive_entities(self, params: dict) -> dict:
        """Query complete indexed entity versions without invoking an agent."""
        return await self._peer.request("conversation.archive.entities", params)

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

    async def replay_stream(self, session_id: str, **opts: Any) -> dict:
        """Resend unacknowledged frames; this never restarts a model or ACKs."""
        return await self._peer.request("stream.replay", {"sessionId": session_id, **opts})

    async def interaction_status(self, request_id: str) -> dict:
        """Read the tenant-bound durable delivery/application receipt."""
        return await self._peer.request("interaction.status", {"requestId": request_id})

    async def employee_profile_apply(self, **params: Any) -> dict:
        """Provision an isolated employee under the device's explicit local policy."""
        return await self._peer.request("employee.profile.apply", params)

    async def employee_profile_status(self, employee_id: str) -> dict:
        """Read the real device installation/version and known memory metadata."""
        return await self._peer.request("employee.profile.status", {"employeeId": employee_id})

    async def workflow_cancel_dispatch(self, dispatch_key: str, project: str, **opts: Any) -> dict:
        """Persist cancellation; preserve nativeStop evidence, which may be unconfirmed."""
        return await self._peer.request("workflow.dispatch.cancel", {"dispatchKey": dispatch_key, "project": project, **opts})

    async def info(self) -> dict:
        """OS metadata and optional ssh username/port/public/private/Tailscale IP hints.

        No credentials or reachability assertion; older devices may omit ssh.
        """
        return await self._peer.request("device.info", {})

    async def resources(self) -> dict:
        """设备资源快照：CPU/内存/磁盘/进程/GPU best-effort。"""
        return await self._peer.request("device.resources", {})

    async def fs_roots(self) -> dict:
        """Device-level browsable filesystem roots."""
        return await self._peer.request("device.fs.roots", {})

    async def fs_list(self, **opts: Any) -> dict:
        """Device-level directory listing under safe roots or absolute root paths."""
        if "directoryInput" in opts and opts.get("projectCandidates") is not True:
            raise RuntimeError("directory_mode_required")
        if opts.get("projectCandidates"):
            info = await self.info()
            if not isinstance(info, dict) or not isinstance(info.get("capabilities"), list) or "workspace_directory_picker_v1" not in info["capabilities"]:
                raise RuntimeError("workspace_directory_device_update_required")
        return await self._peer.request("device.fs.list", opts)

    # ---- deterministic host maintenance (no external agent/LLM required) ----
    async def maintenance_targets(self) -> dict:
        return await self._peer.request("maintenance.targets", {})

    async def maintenance_diagnose(self, target_id: str | None = None) -> dict:
        return await self._peer.request("maintenance.diagnose", {"targetId": target_id} if target_id else {})

    async def maintenance_config_get(self, target_id: str, config_id: str) -> dict:
        return await self._peer.request("maintenance.config.get", {"targetId": target_id, "configId": config_id})

    async def maintenance_config_edit(self, target_id: str, config_id: str, expected_sha256: str, edits: list[dict[str, str]], **opts: Any) -> dict:
        return await self._peer.request("maintenance.config.edit", {"targetId": target_id, "configId": config_id, "expectedSha256": expected_sha256, "edits": edits, **opts})

    async def maintenance_config_patch(self, target_id: str, config_id: str, expected_sha256: str, patch: dict, **opts: Any) -> dict:
        return await self._peer.request("maintenance.config.patch", {"targetId": target_id, "configId": config_id, "expectedSha256": expected_sha256, "patch": patch, **opts})

    async def maintenance_rollback(self, backup_id: str, expected_current_sha256: str, **opts: Any) -> dict:
        return await self._peer.request("maintenance.rollback", {"backupId": backup_id, "expectedCurrentSha256": expected_current_sha256, **opts})

    async def maintenance_package_update(self, target_id: str, **opts: Any) -> dict:
        return await self._peer.request("maintenance.package.update", {"targetId": target_id, **opts})

    async def maintenance_service_status(self, target_id: str, service_id: str) -> dict:
        return await self._peer.request("maintenance.service.status", {"targetId": target_id, "serviceId": service_id})

    async def maintenance_service_restart(self, target_id: str, service_id: str, **opts: Any) -> dict:
        return await self._peer.request("maintenance.service.restart", {"targetId": target_id, "serviceId": service_id, **opts})

    # ---- project / file / skill 便捷封装 ----
    async def project_provision(self, client_request_id: str, name: str, expected_receiver_id: str) -> dict:
        payload = {"clientRequestId": client_request_id, "name": name, "expectedReceiverID": expected_receiver_id}
        info = await self.info()
        if not isinstance(info, dict) or not isinstance(info.get("capabilities"), list) or "project_provision_v1" not in info["capabilities"] or info.get("projectProvisionReceiverID") != expected_receiver_id:
            raise RuntimeError("project_provision_device_update_required")
        return await self._peer.request("project.provision", payload)

    async def project_provision_status(self, client_request_id: str, expected_receiver_id: str) -> dict:
        return await self._peer.request("project.provision.status", {"clientRequestId": client_request_id, "expectedReceiverID": expected_receiver_id})

    async def project_create(self, name: str, git: bool = True, **opts: Any) -> dict:
        expected = opts.get("existingDirectoryIdentity")
        strict = "existingDirectoryIdentity" in opts
        if strict:
            info = await self.info()
            if not isinstance(info, dict) or not isinstance(info.get("capabilities"), list) or "workspace_directory_picker_v1" not in info["capabilities"]:
                raise RuntimeError("workspace_directory_device_update_required")
        result = await self._peer.request("project.create", {"name": name, "git": git, **opts})
        if strict and (not isinstance(result, dict) or not isinstance(result.get("project"), dict) or result["project"].get("directoryIdentity") != expected):
            raise RuntimeError("workspace_directory_unconfirmed")
        return result

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
        """Return live Git files and optional device-observed workspace identity/counts."""
        return await self._peer.request("project.git.status", {"projectId": project_id, **opts})

    async def git_origin(self, project_id: str) -> dict:
        """Read a registered directory's credential-free origin without network access."""
        return await self._peer.request("project.git.origin", {"projectId": project_id})

    async def worktree_provision(self, project_id: str, client_request_id: str, expected_receiver_id: str, name: str, base_branch: str, new_branch: str) -> dict:
        """Create one durable linked checkout without caller-selected paths or replay."""
        return await self._peer.request("project.worktree.provision", {"projectId": project_id, "clientRequestId": client_request_id,
            "expectedReceiverID": expected_receiver_id, "name": name, "baseBranch": base_branch, "newBranch": new_branch})

    async def worktree_provision_status(self, project_id: str, client_request_id: str, expected_receiver_id: str) -> dict:
        """Observe the original creation operation without creating another checkout."""
        return await self._peer.request("project.worktree.provision.status", {"projectId": project_id,
            "clientRequestId": client_request_id, "expectedReceiverID": expected_receiver_id})

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

    async def skill_install(self, agent: str, name: str, scope: str, source: dict, project_id: str | None = None, *, client_request_id: str | None = None) -> Any:
        params: dict = {"agent": agent, "name": name, "scope": scope, "source": source}
        if project_id is not None: params["projectId"] = project_id
        if client_request_id is not None: params["clientRequestId"] = client_request_id
        return await self._peer.request("skill.install", params)

    async def skill_install_status(self, agent: str, name: str, scope: str, client_request_id: str, project_id: str | None = None, *, include_receiver_identity: bool = False, include_recovery_context: bool = False) -> Any:
        params = {"agent": agent, "name": name, "scope": scope, "clientRequestId": client_request_id}
        if project_id is not None:
            params["projectId"] = project_id
        if include_receiver_identity:
            params["includeReceiverIdentity"] = True
        if include_recovery_context:
            params["includeRecoveryContext"] = True
        return await self._peer.request("skill.install.status", params)

    async def skill_install_fence(self, agent: str, name: str, project_id: str, original_request_id: str, expected_receiver_id: str, base_recovery_revision: str, client_request_id: str) -> Any:
        return await self._peer.request("skill.install.fence", {"agent": agent, "name": name, "scope": "project", "projectId": project_id,
            "originalRequestId": original_request_id, "expectedReceiverID": expected_receiver_id, "baseRecoveryRevision": base_recovery_revision, "clientRequestId": client_request_id})

    async def skill_uninstall(self, agent: str, name: str, scope: str, project_id: str | None = None, *, client_request_id: str | None = None) -> Any:
        params: dict = {"agent": agent, "name": name, "scope": scope}
        if project_id is not None: params["projectId"] = project_id
        if client_request_id is not None: params["clientRequestId"] = client_request_id
        return await self._peer.request("skill.uninstall", params)

    async def skill_publish(self, agent: str, name: str, project_id: str, source: dict, base_revision: str | None, client_request_id: str, *, expected_receiver_id: str | None = None) -> Any:
        params = {"agent": agent, "name": name, "scope": "project", "projectId": project_id, "source": source, "baseRevision": base_revision, "clientRequestId": client_request_id}
        if expected_receiver_id is not None:
            params["expectedReceiverID"] = expected_receiver_id
        return await self._peer.request("skill.publish", params)

    async def skill_unpublish(self, agent: str, name: str, project_id: str, base_revision: str, client_request_id: str) -> Any:
        return await self._peer.request("skill.unpublish", {"agent": agent, "name": name, "scope": "project", "projectId": project_id, "baseRevision": base_revision, "clientRequestId": client_request_id})

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
        resume_from: { workflowId, strategy, rerunNodes?, expectedSeq? }
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
        if _workflow_skills(plan):
            params = deepcopy(params)
            await _require_skill_capabilities(self, _workflow_skills(params["plan"]), True)
        return await self._peer.request("workflow.run", params)

    async def workflow_status(self, workflow_id: str) -> dict:
        return await self._peer.request("workflow.status", {"workflowId": workflow_id})

    async def workflow_input(self, workflow_id: str, node_id: str, session_id: str,
                             turn_id: str, input_id: str, text: str) -> dict:
        """Insert only into the original active turn; an unknown receipt must not be replayed."""
        return await self._peer.request("workflow.input", {"workflowId": workflow_id,
            "nodeId": node_id, "sessionId": session_id, "turnId": turn_id,
            "inputId": input_id, "input": text})

    async def workflow_input_status(self, workflow_id: str, input_id: str) -> dict:
        """Read the original durable receipt without inserting or starting a turn."""
        return await self._peer.request("workflow.input.status", {
            "workflowId": workflow_id, "inputId": input_id})

    async def workflow_result(self, workflow_id: str, node_id: str | None = None,
                              offset: int = 0, version: str | None = None,
                              known_version: str | None = None) -> dict:
        params: dict = {"workflowId": workflow_id, "offset": offset}
        if node_id is not None:
            params["nodeId"] = node_id
        if version is not None:
            params["version"] = version
        if known_version is not None:
            params["knownVersion"] = known_version
        return await self._peer.request("workflow.result", params)

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
        """Request cancellation. Native work is stopped only when nativeStop is confirmed."""
        return await self._peer.request("workflow.cancel", {"workflowId": workflow_id, "reason": reason})

    async def workflow_pause(self, workflow_id: str, reason: str | None = None) -> dict:
        """Pause at the current node/round boundary; resume with strategy='continue'."""
        return await self._peer.request("workflow.pause", {"workflowId": workflow_id, "reason": reason})

    async def workflow_list(
        self,
        *,
        dispatch_key: str | None = None,
        status: str | None = None,
        project_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict:
        params: dict = {}
        if dispatch_key is not None: params["dispatchKey"] = dispatch_key
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

    # ---- L4 scheduling (cron / webhook / manual; device-authoritative) ----
    async def schedule_create(
        self,
        name: str,
        trigger: dict,
        target: dict,
        consent: dict | None = None,
        policy: dict | None = None,
        enabled: bool | None = None,
        client_request_id: str | None = None,
    ) -> dict:
        """Create a schedule.

        trigger: {kind: "cron", expr, tz?} | {kind: "webhook"} | {kind: "manual"}
        target:  {runKind: "session", project, agent?, model?, prompt?, skills?}
        consent: {push: "full"|"summary"|"status-only"}
        """
        params: dict = {"name": name, "trigger": trigger, "target": target}
        if consent is not None: params["consent"] = consent
        if policy is not None: params["policy"] = policy
        if enabled is not None: params["enabled"] = enabled
        if client_request_id is not None: params["clientRequestId"] = client_request_id
        selected, workflow = _target_skills(params["target"])
        if workflow or _pinned_skills(selected):
            params = deepcopy(params)
            selected, workflow = _target_skills(params["target"])
            await _require_skill_capabilities(self, selected, workflow)
        return await self._peer.request("schedule.create", params)

    async def schedule_update(self, schedule_id: str, **patch: Any) -> dict:
        params = {"scheduleId": schedule_id, **patch}
        selected, workflow = _target_skills(params.get("target"))
        if workflow or _pinned_skills(selected):
            params = deepcopy(params)
            selected, workflow = _target_skills(params.get("target"))
            await _require_skill_capabilities(self, selected, workflow)
        return await self._peer.request("schedule.update", params)

    async def schedule_delete(self, schedule_id: str, client_request_id: str | None = None) -> dict:
        params: dict = {"scheduleId": schedule_id}
        if client_request_id is not None: params["clientRequestId"] = client_request_id
        return await self._peer.request("schedule.delete", params)

    async def schedule_list(self, **filt: Any) -> dict:
        return await self._peer.request("schedule.list", filt)

    async def schedule_get(self, schedule_id: str, reveal: bool | None = None) -> dict:
        params: dict = {"scheduleId": schedule_id}
        if reveal is not None: params["reveal"] = reveal
        return await self._peer.request("schedule.get", params)

    async def schedule_enable(self, schedule_id: str) -> dict:
        return await self._peer.request("schedule.enable", {"scheduleId": schedule_id})

    async def schedule_disable(self, schedule_id: str) -> dict:
        return await self._peer.request("schedule.disable", {"scheduleId": schedule_id})

    async def schedule_trigger(self, schedule_id: str, source: str | None = None, input: str | dict | None = None) -> dict:
        """Manually trigger one run (manual / test cron / replay webhook)."""
        params: dict = {"scheduleId": schedule_id}
        if source is not None: params["source"] = source
        if input is not None: params["input"] = input
        return await self._peer.request("schedule.trigger", params)

    async def schedule_runs_list(self, schedule_id: str, status: str | None = None, limit: int | None = None, unacked_only: bool | None = None) -> dict:
        params: dict = {"scheduleId": schedule_id}
        if unacked_only is not None: params["unackedOnly"] = unacked_only
        if status is not None: params["status"] = status
        if limit is not None: params["limit"] = limit
        return await self._peer.request("schedule.runs.list", params)

    async def schedule_ack(self, run_id: str, last_seq: int | None = None, finished: bool | None = None) -> None:
        """Acknowledge a finished/streaming run (parallel to stream.ack).
        一般不需调用：SDK 在 run.event / run.finished 入口已自动 ack。
        """
        params: dict = {"runId": run_id}
        if last_seq is not None: params["lastSeq"] = last_seq
        if finished is not None: params["finished"] = finished
        await self._peer.notify("schedule.ack", params)

    async def run_get(self, run_id: str) -> dict:
        return await self._peer.request("run.get", {"runId": run_id})

    async def run_resolve(
        self, run_id: str, dispatch: dict, status: str,
        result_text: str | None = None, error: str | None = None,
        client_request_id: str | None = None,
    ) -> dict:
        """Settle a controller-dispatch occurrence, without launching any work."""
        params: dict = {"runId": run_id, "dispatch": dispatch, "status": status}
        if result_text is not None:
            params["resultText"] = result_text
        if error is not None:
            params["error"] = error
        if client_request_id is not None:
            params["clientRequestId"] = client_request_id
        return await self._peer.request("run.resolve", params)

    async def run_events_subscribe(self, run_id: str) -> dict:
        return await self._peer.request("run.events.subscribe", {"runId": run_id})

    async def run_events_unsubscribe(self, run_id: str) -> dict:
        return await self._peer.request("run.events.unsubscribe", {"runId": run_id})

    async def run_cancel(self, run_id: str, reason: str | None = None) -> dict:
        return await self._peer.request("run.cancel", {"runId": run_id, "reason": reason})

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
        """Preserve nativeRunId/devRunId and original workflow/turn attribution."""
        self._interaction_handler = fn

    def set_conversation_board_handler(self, fn: Callable[[dict], Any]) -> None:
        """Handle controller-stamped board reads/writes. Unset means unsupported."""
        self._conversation_board_handler = fn

    def set_conversation_workflow_handler(self, fn: Callable[[dict], Any]) -> None:
        self._conversation_workflow_handler = fn

    def set_conversation_message_handler(self, fn: Callable[[dict], Any]) -> None:
        """Handle stamped group messages, history/read, and immutable attachmentIDs.

        history/read preserve the active group scope and never dispatch a reply.
        Recorded receipts are not proof of verified recipient file delivery.
        """
        self._conversation_message_handler = fn

    def set_project_coordination_handler(self, fn: Callable[[dict], Any]) -> None:
        """Handle private coordination, preserving device-owned receive outside action.

        Only a host accepting receive reports returns receiveReporting: 1.
        workspaceVersion: 1 is negotiated by a read-only presence probe; peer
        workspace metadata is runtime-confirmed, never an agent activity claim.
        """
        self._project_coordination_handler = fn

    def set_project_coordination_evidence_handler(self, fn: Callable[[dict], Any]) -> None:
        """Record device-only historical observations, never model ACKs or new work."""
        self._project_coordination_evidence_handler = fn

    def set_stream_event_handler(self, fn: Callable[[dict], Awaitable[bool | dict] | bool | dict]) -> None:
        """True ACKs this event; {ackSeq} proves a committed contiguous cursor."""
        self._stream_event_handler = fn

    def set_workflow_event_handler(self, fn: Callable[[dict], Awaitable[None] | None]) -> None:
        self._workflow_event_handler = fn

    def set_schedule_changed_handler(self, fn: Callable[[dict], None]) -> None:
        self._schedule_changed_handler = fn

    def set_run_started_handler(self, fn: Callable[[dict], None]) -> None:
        self._run_started_handler = fn

    def set_run_event_handler(self, fn: Callable[[dict], None]) -> None:
        self._run_event_handler = fn

    def set_run_finished_handler(self, fn: Callable[[dict], Awaitable[None] | None]) -> None:
        self._run_finished_handler = fn

    async def disconnect(self) -> None:
        self._peer.reject_all("device disconnected")
        if self._close_transport:
            result = self._close_transport()
            if inspect.isawaitable(result):
                await result

    async def _handle_inbound(self, method: str, params: Any) -> Any:
        if method == "stream.event":
            ev = params or {}
            if self._stream_event_handler:
                consumed = self._stream_event_handler(ev)
                if inspect.isawaitable(consumed):
                    consumed = await consumed
                if consumed is True or isinstance(consumed, dict):
                    ack = ev.get("seq") if consumed is True else consumed.get("ackSeq")
                    seq = ev.get("seq")
                    if isinstance(ack, bool) or not isinstance(ack, int) or ack > 9007199254740991 or isinstance(seq, bool) or not isinstance(seq, int) or seq < 0 or seq > 9007199254740991 or ack < seq:
                        raise ValueError("invalid cumulative stream ACK cursor")
                    await self._peer.notify("stream.ack", {"sessionId": ev.get("sessionId"), "lastSeq": ack})
                    return None
            if "nativeProactive" in ev:
                return None
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
        # ---- L4 scheduling p2s ----
        if method == "schedule.changed":
            if self._schedule_changed_handler:
                self._schedule_changed_handler(params or {})
            return None
        if method == "run.started":
            if self._run_started_handler:
                self._run_started_handler(params or {})
            return None
        if method == "run.event":
            ev = params or {}
            if self._run_event_handler:
                self._run_event_handler(ev)
            rid = ev.get("runId")
            seq = ev.get("seq")
            if rid and isinstance(seq, int):
                await self._peer.notify("schedule.ack", {"runId": rid, "lastSeq": seq})
            return None
        if method == "run.finished":
            ev = params or {}
            if self._run_finished_handler:
                res = self._run_finished_handler(ev)
                if inspect.isawaitable(res):
                    await res
            run = ev.get("run") or {}
            rid = run.get("id")
            controller_dispatch = run.get("controllerDispatch") is True or bool(run.get("dispatch"))
            if rid and (not controller_dispatch or self._run_finished_handler):
                await self._peer.notify("schedule.ack", {"runId": rid, "finished": True})
            return None
        if method == "document.send":
            if self._document_handler:
                res = self._document_handler(params or {})
                if inspect.isawaitable(res):
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
        if method == "conversation.message":
            if not self._conversation_message_handler:
                raise RuntimeError("Conversation messages are not supported by this server")
            res = self._conversation_message_handler(params or {})
            return await res if inspect.isawaitable(res) else res
        if method == "project.coordination.evidence":
            if not self._project_coordination_evidence_handler:
                raise RuntimeError("Project coordination evidence is not supported by this server")
            res = self._project_coordination_evidence_handler(params or {})
            if inspect.isawaitable(res):
                res = await res
            return res
        if method == "project.coordination":
            if not self._project_coordination_handler:
                raise RuntimeError("Project coordination is not supported by this server")
            res = self._project_coordination_handler(params or {})
            return await res if inspect.isawaitable(res) else res
        if method == "conversation.workflow":
            if not self._conversation_workflow_handler:
                raise RuntimeError("Conversation workflows are not supported by this server")
            res = self._conversation_workflow_handler(params or {})
            return await res if inspect.isawaitable(res) else res
        if method == "conversation.board":
            if not self._conversation_board_handler:
                raise RuntimeError("Conversation boards are not supported by this server")
            res = self._conversation_board_handler(params or {})
            return await res if asyncio.iscoroutine(res) else res
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

    def __init__(self, host: str = "127.0.0.1", port: int = 0, authenticate: Optional[Authenticate] = None, *, allow_anonymous: bool = False) -> None:
        if authenticate is not None and not callable(authenticate):
            raise TypeError("authenticate must be callable or None")
        self._host = host
        self._port = port
        self._authenticate = authenticate
        self._allow_anonymous = allow_anonymous
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
        if self._authenticate is not None and not callable(self._authenticate):
            raise TypeError("authenticate must be callable or None")
        if self._authenticate is None and self._allow_anonymous is not True and self._host not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError(
                "PhononServer refuses to listen on non-loopback host without authenticate(); "
                "provide authenticate or set allow_anonymous=True (A5)"
            )
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
                if self._authenticate is not None:
                    tenant = await self._authenticate(device_id, device_key)
                else:
                    tenant = f"tenant-{device_id}"
                if tenant is None:
                    raise PermissionError("unauthorized")
                device = PhononDevice(device_id, tenant, peer, ws.close)
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
