import unittest

from agent_phonon.server import PhononDevice, PhononSession


class SessionOptions(unittest.IsolatedAsyncioTestCase):
    async def test_cursor_bound_resume_preserves_the_original_plan_and_client_identity(self):
        class Peer:
            async def request(self, method, params):
                self.method, self.params = method, params
                return {"workflowId": "original", "resumed": True}
        peer = Peer()
        device = PhononDevice("device", "owner", peer)
        plan = {"mode": "dag", "nodes": [{"nodeId": "original-node", "agent": "codex", "input": "Original instructions"}]}
        await device.workflow_run(plan=plan, project="original-workspace", client_request_id="frozen-resume", resume_from={"workflowId": "original", "strategy": "last_success_dependents", "expectedSeq": 7})
        self.assertEqual(peer.method, "workflow.run")
        self.assertEqual(peer.params["plan"], plan)
        self.assertEqual(peer.params["resumeFrom"]["expectedSeq"], 7)
        self.assertEqual(peer.params["clientRequestId"], "frozen-resume")

    async def test_dev_interaction_attribution_and_receipts_survive_the_sdk_boundary(self):
        request = {"requestId": "dev-review", "devRunId": "11111111-1111-4111-8111-111111111111", "workflowId": "original-workflow", "sessionId": "original-session", "turnId": "original-turn", "form": {"title": "Explicit human decision", "fields": []}}
        proof = {"requestId": request["requestId"], "devRunId": request["devRunId"], "state": "applied"}
        class Peer:
            async def request(self, method, params):
                self.method, self.params = method, params
                return proof
        peer = Peer()
        device = PhononDevice("device", "owner", peer)
        async def receive(params):
            self.assertIs(params, request)
            return {"requestId": params["requestId"], "action": "submit", "values": {"approved": False, "count": 0}}
        device.set_interaction_handler(receive)
        result = await device._handle_inbound("interaction.request", request)
        self.assertEqual(result["values"], {"approved": False, "count": 0})
        self.assertIs(await device.interaction_status(request["requestId"]), proof)
        self.assertEqual(peer.method, "interaction.status")

    async def test_cancel_and_status_preserve_native_stop_proof_without_claiming_settlement(self):
        proof = {"version": 1, "state": "unknown", "targets": [{"sessionId": "session", "turnId": "turn", "state": "unknown"}]}
        class Peer:
            async def request(self, method, params):
                return {"status": "cancelled", "nativeStop": proof}
        device = PhononDevice("device", "tenant", Peer())
        for result in [await device.workflow_cancel("workflow"), await device.workflow_cancel_dispatch("native-one", "owned"), await device.workflow_status("workflow")]:
            self.assertIs(result["nativeStop"], proof)
            self.assertEqual(result["nativeStop"]["state"], "unknown")

    async def test_recovery_forwards_identity_without_task_input(self):
        class Device:
            async def call(self, method, params):
                self.method, self.params = method, params
                return {"status": "idle", "worktreeId": "original-worktree"}
        device = Device()
        result = await PhononSession(device, "retained").recover(project="owned", agent="codex", model="model")
        self.assertEqual(result, {"status": "idle", "worktreeId": "original-worktree"})
        self.assertEqual(device.method, "session.recover")
        self.assertEqual(device.params, {"sessionId": "retained", "project": "owned", "agent": "codex", "model": "model"})

    async def test_proactive_stream_provenance_is_preserved_before_cumulative_ack(self):
        class Peer:
            def __init__(self): self.sent = []
            async def notify(self, method, params): self.sent.append((method, params))
        peer = Peer()
        device = PhononDevice("device", "tenant", peer)
        event = {"type": "message", "sessionId": "retained", "seq": 5, "origin": "unsolicited", "sourceEventId": "cron-native", "nativeProactive": {"anchorRunId": "anchor", "employeeId": "employee", "upstreamId": "cron-native"}}
        async def consume(value):
            self.assertEqual(value, event)
            self.assertEqual(peer.sent, [])
            return {"ackSeq": 6}
        device.set_stream_event_handler(consume)
        await device._handle_inbound("stream.event", event)
        self.assertEqual(peer.sent, [("stream.ack", {"sessionId": "retained", "lastSeq": 6})])
    async def test_closed_rpc_rejects_retained_calls_and_late_inbound_work(self):
        import asyncio
        import json
        from agent_phonon.rpc import RpcPeer
        sent, handled = [], []
        async def send(value):
            sent.append(value)
        async def handler(method, params):
            handled.append(method)
        peer = RpcPeer(send, handler)
        pending = asyncio.create_task(peer.request("info", {}))
        await asyncio.sleep(0)
        peer.reject_all("device disconnected")
        with self.assertRaisesRegex(ConnectionError, "disconnected"):
            await pending
        with self.assertRaisesRegex(ConnectionError, "disconnected"):
            await peer.request("info", {})
        with self.assertRaisesRegex(ConnectionError, "disconnected"):
            await peer.notify("stream.ack", {})
        await peer.handle(json.dumps({"jsonrpc": "2.0", "id": 999, "method": "execute"}))
        self.assertEqual(handled, [])
        self.assertEqual(len(sent), 1)

    async def test_proactive_frames_do_not_fall_back_to_ordinary_session_acks(self):
        class Peer:
            def __init__(self): self.sent = []
            async def notify(self, method, params): self.sent.append((method, params))
        class Session:
            def _on_stream(self, event): raise AssertionError("uncommitted proactive frame")
        peer = Peer()
        device = PhononDevice("device", "tenant", peer)
        device._sessions["retained"] = Session()
        await device._handle_inbound("stream.event", {"sessionId": "retained", "seq": 5, "nativeProactive": {}})
        self.assertEqual(peer.sent, [])
        device.set_stream_event_handler(lambda event: {"ackSeq": 4})
        with self.assertRaisesRegex(ValueError, "invalid cumulative"):
            await device._handle_inbound("stream.event", {"sessionId": "retained", "seq": 5, "nativeProactive": {}})
        self.assertEqual(peer.sent, [])

    async def test_failed_rpc_send_cleans_pending_and_closed_handler_cannot_reply(self):
        import asyncio
        import json
        from agent_phonon.rpc import RpcPeer
        async def fail(value):
            raise OSError("send failed")
        async def noop(method, params):
            return None
        peer = RpcPeer(fail, noop)
        with self.assertRaisesRegex(OSError, "send failed"):
            await peer.request("info", {})
        self.assertEqual(peer._pending, {})
        sent, release = [], asyncio.Event()
        async def send(value):
            sent.append(value)
        async def handler(method, params):
            await release.wait()
            return {"ok": True}
        peer = RpcPeer(send, handler)
        active = asyncio.create_task(peer.handle(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "execute"})))
        await asyncio.sleep(0)
        peer.reject_all("closed")
        release.set()
        await active
        self.assertEqual(sent, [])

    async def test_document_handler_awaits_futures_without_fabricated_delivery(self):
        import asyncio
        device = PhononDevice("device", "tenant", object())
        expected = {"delivered": [{"name": "output.bin", "ok": True, "serverRef": "native-file:test"}]}
        def handle(params):
            self.assertEqual(params["nativeRunId"], "native-source")
            future = asyncio.get_running_loop().create_future()
            future.set_result(expected)
            return future
        device.set_document_handler(handle)
        self.assertIs(await device._handle_inbound("document.send", {"nativeRunId": "native-source"}), expected)

    async def test_conversation_message_handler_is_explicit_and_awaits_futures(self):
        import asyncio
        device = PhononDevice("device", "tenant", object())
        with self.assertRaisesRegex(RuntimeError, "not supported"):
            await device._handle_inbound("conversation.message", {"operation": "members"})
        result = {"status": "members", "enabled": False}
        def handle(params):
            self.assertEqual(params["operation"], "members")
            future = asyncio.get_running_loop().create_future()
            future.set_result(result)
            return future
        device.set_conversation_message_handler(handle)
        self.assertIs(await device._handle_inbound("conversation.message", {"operation": "members"}), result)
        payload = {"operation": "send", "requestId": "frozen-request", "text": "Review", "mentionIDs": ["member"], "mode": "queue", "attachmentIDs": ["native-file:existing-file"]}
        async def message_with_files(params):
            self.assertEqual(params, payload)
            return {"status": "recorded", "messageID": "message"}
        device.set_conversation_message_handler(message_with_files)
        self.assertEqual(await device._handle_inbound("conversation.message", payload), {"status": "recorded", "messageID": "message"})

    async def test_conversation_workflow_handler_is_explicit_and_awaited(self):
        device = PhononDevice("device", "tenant", object())
        with self.assertRaisesRegex(RuntimeError, "not supported"):
            await device._handle_inbound("conversation.workflow", {"operation": "catalog"})
        async def handle(params):
            return {"status": "catalog", "data": params}
        device.set_conversation_workflow_handler(handle)
        self.assertEqual(await device._handle_inbound("conversation.workflow", {"operation": "catalog"}), {"status": "catalog", "data": {"operation": "catalog"}})
        payload = {"operation": "execute", "requestId": "retained-request", "delivery": "detached", "plan": {"review": "request", "nodes": [{"id": "review", "attachmentIDs": ["native-file:retained"], "artifactSources": ["producer"]}]}}
        self.assertEqual(await device._handle_inbound("conversation.workflow", payload), {"status": "catalog", "data": payload})

    async def test_reasoning_is_per_turn_and_default_is_explicit(self):
        class Device:
            def __init__(self): self.calls = []
            async def call(self, method, params):
                self.calls.append((method, params))
                return {"turnId": "turn"}
        device = Device()
        session = PhononSession(device, "session")
        await session.send("task", reasoning={"level": "standard"})
        await session.send("default", reasoning={"level": None})
        await session.send("maximum", reasoning={"level": "max"})
        self.assertEqual(device.calls, [
            ("session.send", {"sessionId": "session", "input": "task", "reasoning": {"level": "standard"}}),
            ("session.send", {"sessionId": "session", "input": "default", "reasoning": {"level": None}}),
            ("session.send", {"sessionId": "session", "input": "maximum", "reasoning": {"level": "max"}}),
        ])

    async def test_compression_request_identity_and_status_are_forwarded(self):
        class Device:
            def __init__(self):
                self.calls = []

            async def call(self, method, params):
                self.calls.append((method, params))
                return {}

        device = Device()
        session = PhononSession(device, "session")
        await session.compress("custom", clientRequestId="operation", strategy="dropToolIO", keepRecentToolCalls=2, background=True)
        await session.compression_status("operation")
        self.assertEqual(device.calls, [
            ("session.compress", {"sessionId": "session", "mode": "custom", "clientRequestId": "operation", "strategy": "dropToolIO", "keepRecentToolCalls": 2, "background": True}),
            ("session.compression.status", {"sessionId": "session", "operationId": "operation"}),
        ])

    async def test_conversation_board_handler_is_explicit_and_awaited(self):
        device = PhononDevice("device", "tenant", object())
        with self.assertRaisesRegex(RuntimeError, "not supported"):
            await device._handle_inbound("conversation.board", {"operation": "read"})
        result = {"status": "ok", "board": {"revision": 0}}

        async def handle(params):
            self.assertEqual(params["operation"], "read")
            return result

        device.set_conversation_board_handler(handle)
        self.assertIs(await device._handle_inbound("conversation.board", {"operation": "read"}), result)

    async def test_explicit_modes_and_turn_identity_are_forwarded_without_fallback(self):
        class Device:
            async def call(self, method, params):
                self.method, self.params = method, params
                return {"turnId": "active", "disposition": "injected"}

        device = Device()
        session = PhononSession(device, "session")
        result = await session.send("steer", whenBusy="inject", turnId="active", clientRequestId="message-one")
        self.assertEqual(result["turnId"], "active")
        self.assertEqual(device.method, "session.send")
        self.assertEqual(device.params, {"sessionId": "session", "input": "steer", "whenBusy": "inject", "turnId": "active", "clientRequestId": "message-one"})
        await session.send("explicit", whenBusy="inject", fallback="queue")
        self.assertEqual(device.params["fallback"], "queue")

    async def test_session_creation_forwards_role_context_and_agent_configuration(self):
        class Peer:
            async def request(self, method, params):
                self.method, self.params = method, params
                return {"sessionId": "created"}

        peer = Peer()
        device = PhononDevice("device", "tenant", peer)
        session = await device.create_session("project", "agent", "model", initialContext=[{"role": "system", "content": "Review"}], agentConfig={"thinking": "high"}, clientTag="native")
        self.assertEqual(session.session_id, "created")
        self.assertEqual(peer.params["initialContext"], [{"role": "system", "content": "Review"}])
        self.assertEqual(peer.params["agentConfig"], {"thinking": "high"})
        self.assertEqual(peer.params["clientTag"], "native")

    async def test_bounded_replay_and_dispatch_cancellation_match_typescript(self):
        class Peer:
            def __init__(self):
                self.calls = []

            async def request(self, method, params):
                self.calls.append((method, params))
                return {}

        peer = Peer()
        device = PhononDevice("device", "tenant", peer)
        await device.replay_stream("session", fromSeq=7, limit=20)
        await device.workflow_cancel_dispatch("native-one", "owned", reason="Stop")
        await device.interaction_status("review")
        await device.employee_profile_apply(employeeId="employee", revision=1, agent="hermes:base")
        await device.employee_profile_status("employee")
        self.assertEqual(peer.calls, [
            ("stream.replay", {"sessionId": "session", "fromSeq": 7, "limit": 20}),
            ("workflow.dispatch.cancel", {"dispatchKey": "native-one", "project": "owned", "reason": "Stop"}),
            ("interaction.status", {"requestId": "review"}),
            ("employee.profile.apply", {"employeeId": "employee", "revision": 1, "agent": "hermes:base"}),
            ("employee.profile.status", {"employeeId": "employee"}),
        ])


if __name__ == "__main__":
    unittest.main()
