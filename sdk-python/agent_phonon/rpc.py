"""双向 JSON-RPC 2.0 peer（asyncio）。每个 device 连接一个。"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Awaitable, Callable

RpcHandler = Callable[[str, Any], Awaitable[Any]]


class RpcPeer:
    def __init__(self, send: Callable[[str], Awaitable[None]], handler: RpcHandler) -> None:
        self._send = send
        self._handler = handler
        self._pending: dict[Any, asyncio.Future] = {}
        self._next_id = 1

    async def request(self, method: str, params: Any, timeout: float = 600.0) -> Any:
        rid = self._next_id
        self._next_id += 1
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        await self._send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    async def notify(self, method: str, params: Any) -> None:
        await self._send(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}))

    async def handle(self, data: str) -> None:
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            return
        # 响应
        if ("result" in msg or "error" in msg) and "id" in msg:
            fut = self._pending.get(msg["id"])
            if fut and not fut.done():
                if "error" in msg and msg["error"]:
                    fut.set_exception(RpcError(msg["error"]))
                else:
                    fut.set_result(msg.get("result"))
            return
        # 请求 / 通知
        method = msg.get("method")
        if isinstance(method, str):
            is_notification = "id" not in msg or msg.get("id") is None
            try:
                result = await self._handler(method, msg.get("params"))
                if not is_notification:
                    await self._send(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result if result is not None else None}))
            except Exception as e:  # noqa: BLE001
                if not is_notification:
                    await self._send(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": str(e)}}))

    def reject_all(self, reason: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError(reason))
        self._pending.clear()


class RpcError(Exception):
    def __init__(self, error: Any) -> None:
        self.error = error
        msg = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        self.app_code = (error.get("data") or {}).get("appCode") if isinstance(error, dict) else None
        super().__init__(msg)


def new_id() -> str:
    return str(uuid.uuid4())
