import unittest
from agent_phonon.server import PhononDevice


class WorkflowResultTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_source_versions_and_utf16_offset_are_forwarded_once(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"omitted": True}

        device = PhononDevice("device", "owner", Peer())
        result = await device.workflow_result("original", node_id="worker", offset=15999,
                                              version="a" * 64, known_version="a" * 64)
        self.assertEqual(result, {"omitted": True})
        self.assertEqual(calls, [("workflow.result", {"workflowId": "original", "nodeId": "worker",
                         "offset": 15999, "version": "a" * 64, "knownVersion": "a" * 64})])
        await device.workflow_result("original")
        self.assertEqual(calls[-1], ("workflow.result", {"workflowId": "original", "offset": 0}))
