import unittest
import asyncio
from copy import deepcopy
from agent_phonon import PhononDevice, PhononSession, SkillReference


class SkillSelectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_inbound_canonical_workflow_preserves_catalog_target_and_exact_project_pins(self):
        device = PhononDevice("device", "owner", object())
        async def handle(params):
            return {"status": "status", "data": params}
        device.set_conversation_workflow_handler(handle)
        selected = {key: value for key, value in self.pin().items() if key != "scope"}
        identity = "11111111-1111-4111-8111-111111111111"
        source = {"nativeRunId": identity, "workflowId": "original", "sessionId": "session", "turnId": "turn"}
        inputs = [dict(source, operation="catalog", projectID=identity, skillTarget={"agentID": identity, "bindingID": identity}),
                  dict(source, operation="execute", requestId=identity, plan={"projectID": identity, "title": "Work", "goal": "Original selection", "review": "request",
                       "nodes": [{"id": "work", "title": "Work", "agentID": identity, "bindingID": identity, "input": "Work", "skills": [selected],
                                  "canvasSkill": {"productID": "product", "deviceBindingID": "association", "baseBindingRevision": identity, "operationID": identity}}]})]
        for params in inputs:
            with self.subTest(operation=params["operation"]):
                self.assertEqual(await device._handle_inbound("conversation.workflow", params), {"status": "status", "data": params})

    async def test_structured_selection_retains_scope_version_force_and_original_identity(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {}

        device = PhononDevice("device", "owner", Peer())
        session = PhononSession(device, "session")
        selected: SkillReference = {"name": "selected", "version": "1.2.3", "scope": "project", "force": False}
        skills = ["plain", selected, {"name": "other", "scope": "global", "force": True}]
        await session.send("Original task", skills=skills, clientRequestId="exact-source", turnId="turn", whenBusy="queue")
        self.assertEqual(calls, [("session.send", {"sessionId": "session", "input": "Original task", "skills": skills,
                                                "clientRequestId": "exact-source", "turnId": "turn", "whenBusy": "queue"})])

    async def test_absent_skills_are_not_sent_as_null(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {}

        session = PhononSession(PhononDevice("device", "owner", Peer()), "session")
        await session.send("Original task")
        self.assertNotIn("skills", calls[0][1])
        await session.send("Empty selection", skills=[])
        self.assertEqual(calls[1][1]["skills"], [])

    def device(self, flags=None):
        calls = []
        capabilities = ["workflow_skill_selection_v1", "pinned_skill_selection_v1"] if flags is None else flags

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"capabilities": capabilities} if method == "device.info" else {}

        return PhononDevice("device", "owner", Peer()), calls

    def pin(self):
        return {"name": "selected", "version": "1.2.3", "scope": "project", "revision": "a" * 64,
                "installationId": "11111111-1111-4111-8111-111111111111"}

    async def test_pinned_session_preserves_exact_fields_after_capability_read(self):
        device, calls = self.device()
        await PhononSession(device, "s").send("Owned task", skills=[self.pin()], clientRequestId="fixed", turnId="turn")
        self.assertEqual([method for method, _ in calls], ["device.info", "session.send"])
        self.assertEqual(calls[1][1]["skills"], [self.pin()])

    async def test_every_workflow_mode_preserves_node_skill_selections(self):
        node = lambda identity: {"nodeId": identity, "agent": "mock:a", "model": "m", "skills": [self.pin()]}
        plans = [{"mode": "dag", "nodes": [node("n")]},
                 {"mode": "graph", "executor": node("exec"), "workers": [node("worker")], "communicationGraph": {"edges": []}},
                 {"mode": "discussion", "topic": "Owned", "participants": [node("one"), node("two")], "chairman": "one"}]
        for plan in plans:
            with self.subTest(mode=plan["mode"]):
                device, calls = self.device()
                await device.workflow_run(project="owned", plan=plan, client_request_id="fixed")
                self.assertEqual([method for method, _ in calls], ["device.info", "workflow.run"])
                self.assertEqual(calls[1][1], {"project": "owned", "plan": plan, "clientRequestId": "fixed"})

    async def test_missing_or_malformed_capabilities_never_dispatch_requested_work(self):
        plan = {"mode": "dag", "nodes": [{"nodeId": "n", "agent": "mock:a", "model": "m", "skills": [self.pin()]}]}
        for flags in [[], ["workflow_skill_selection_v1"], ["pinned_skill_selection_v1"], "workflow_skill_selection_v1", False]:
            with self.subTest(flags=flags):
                device, calls = self.device(flags)
                with self.assertRaisesRegex(RuntimeError, "device_update_required"):
                    await device.workflow_run(project="owned", plan=plan)
                self.assertEqual([method for method, _ in calls], ["device.info"])

    async def test_request_is_snapshotted_before_capability_await(self):
        ready, release = asyncio.Event(), asyncio.Event()
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                if method == "device.info":
                    ready.set()
                    await release.wait()
                    return {"capabilities": ["workflow_skill_selection_v1", "pinned_skill_selection_v1"]}
                return {}

        device = PhononDevice("d", "owner", Peer())
        plan = {"mode": "dag", "nodes": [{"nodeId": "n", "agent": "mock:a", "model": "m", "skills": [self.pin()]}]}
        original = deepcopy(plan)
        work = asyncio.create_task(device.workflow_run(project="owned", plan=plan))
        await ready.wait()
        plan["nodes"][0]["skills"][0]["installationId"] = "22222222-2222-4222-8222-222222222222"
        release.set()
        await work
        self.assertEqual(calls[1][1]["plan"], original)

    async def test_schedules_gate_and_preserve_workflow_and_direct_pins(self):
        device, calls = self.device()
        target = {"runKind": "workflow", "project": "owned", "plan": {"mode": "dag", "nodes": [{"nodeId": "n", "agent": "mock:a", "model": "m", "skills": [self.pin()]}]}}
        await device.schedule_create(name="Owned", trigger={"kind": "manual"}, target=target)
        await device.schedule_update("original", target=target)
        self.assertEqual([method for method, _ in calls], ["device.info", "schedule.create", "device.info", "schedule.update"])
        self.assertEqual(calls[1][1]["target"], target)
        self.assertEqual(calls[3][1]["target"], target)
        old, denied = self.device([])
        with self.assertRaisesRegex(RuntimeError, "device_update_required"):
            await old.schedule_create(name="Owned", trigger={"kind": "manual"}, target=target)
        self.assertEqual([method for method, _ in denied], ["device.info"])

    async def test_legacy_workflow_and_label_update_do_not_probe_or_change_payload(self):
        device, calls = self.device([])
        plan = {"mode": "dag", "nodes": [{"nodeId": "n", "agent": "mock:a", "model": "m"}]}
        await device.workflow_run(plan=plan, project="owned")
        await device.schedule_update("old", name="New label")
        self.assertEqual([method for method, _ in calls], ["workflow.run", "schedule.update"])

    async def test_json_compatible_legacy_tuples_are_not_rejected_by_new_preflight(self):
        device, calls = self.device([])
        plan = {"mode": "dag", "nodes": ({"nodeId": "n", "agent": "mock:a", "model": "m"},)}
        await device.workflow_run(plan=plan, project="owned")
        await device.schedule_create(name="Owned", trigger={"kind": "manual"}, target={"project": "owned", "skills": ("plain",)})
        self.assertEqual([method for method, _ in calls], ["workflow.run", "schedule.create"])

    async def test_direct_pinned_schedule_needs_only_pin_support_and_probe_failure_never_mutates(self):
        device, calls = self.device(["pinned_skill_selection_v1"])
        await device.schedule_update("owned", target={"project": "owned", "skills": [self.pin()]})
        self.assertEqual([method for method, _ in calls], ["device.info", "schedule.update"])
        denied = []

        class Peer:
            async def request(self, method, params):
                denied.append(method)
                raise RuntimeError("controlled info unavailable")

        with self.assertRaisesRegex(RuntimeError, "info unavailable"):
            await PhononSession(PhononDevice("d", "owner", Peer()), "s").send("Owned", skills=[self.pin()])
        self.assertEqual(denied, ["device.info"])
