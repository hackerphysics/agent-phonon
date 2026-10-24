import asyncio
import unittest
from agent_phonon.server import PhononDevice


class ProjectCoordinationTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_handler_is_not_success(self):
        device = PhononDevice("device", "owner", object())
        with self.assertRaises(RuntimeError):
            await device._handle_inbound("project.coordination", {})
        with self.assertRaises(RuntimeError):
            await device._handle_inbound("project.coordination.evidence", {})

    async def test_evidence_handler_preserves_metadata_and_awaits_future(self):
        device = PhononDevice("device", "owner", object())
        source = {"version": 1, "reports": [{"deliveryId": "owned", "state": "context_hook"}]}
        result = {"version": 1, "receipts": [{"deliveryId": "owned", "status": "recorded", "state": "context_hook"}]}
        captured = []
        def handle(params):
            captured.append(params)
            future = asyncio.get_running_loop().create_future()
            asyncio.get_running_loop().call_soon(future.set_result, result)
            return future
        device.set_project_coordination_evidence_handler(handle)
        self.assertEqual(await device._handle_inbound("project.coordination.evidence", source), result)
        self.assertEqual(captured, [source])

    async def test_preserves_source_and_awaits_future(self):
        device = PhononDevice("device", "owner", object())
        source = {"sourceKind": "dev", "runId": "original", "sessionId": "session",
                  "turnId": "turn", "action": {"operation": "inbox"},
                  "receive": {"version": 1, "mode": "runtime_pending", "boundary": "after_tools",
                              "evidence": "context_hook", "visibility": "collapsed"}}
        captured = []

        def handle(params):
            captured.append(params)
            result = asyncio.get_running_loop().create_future()
            asyncio.get_running_loop().call_soon(result.set_result, {"messages": [], "receiveReporting": 1})
            return result

        device.set_project_coordination_handler(handle)
        self.assertEqual(await device._handle_inbound("project.coordination", source), {"messages": [], "receiveReporting": 1})
        self.assertEqual(captured, [source])
