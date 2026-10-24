import unittest
from agent_phonon.server import PhononDevice


class WorkflowInputTests(unittest.IsolatedAsyncioTestCase):
    async def test_input_and_status_preserve_exact_target_and_do_not_retry(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"state": "unknown"}

        device = PhononDevice("device", "owner", Peer())
        receipt = await device.workflow_input("original", "worker", "session", "turn",
                                               "message", "Exact input \u4e2d\u6587")
        self.assertEqual(receipt, {"state": "unknown"})
        await device.workflow_input_status("original", "message")
        self.assertEqual(calls, [("workflow.input", {"workflowId": "original", "nodeId": "worker",
                          "sessionId": "session", "turnId": "turn", "inputId": "message",
                          "input": "Exact input \u4e2d\u6587"}),
                                ("workflow.input.status", {"workflowId": "original", "inputId": "message"})])

    async def test_transport_failure_never_reissues_an_insertion(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                raise ConnectionError("Owned transport failure")

        device = PhononDevice("device", "owner", Peer())
        with self.assertRaises(ConnectionError):
            await device.workflow_input("original", "worker", "session", "turn", "message", "input")
        self.assertEqual(len(calls), 1)
