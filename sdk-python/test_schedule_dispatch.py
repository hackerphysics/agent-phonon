import unittest
import asyncio
from agent_phonon.server import PhononDevice


class ScheduleDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_ack_waits_for_explicit_durable_awaitable_consumer(self):
        calls = []
        committed = False

        class Peer:
            async def notify(self, method, params):
                calls.append((method, params, committed))

        device = PhononDevice("device", "owner", Peer())
        event = {"run": {"id": "original", "controllerDispatch": True, "status": "success"}, "push": "status-only"}
        await device._handle_inbound("run.finished", event)
        self.assertEqual(calls, [])
        done = asyncio.get_running_loop().create_future()

        async def commit():
            nonlocal committed
            await asyncio.sleep(0)
            committed = True
            done.set_result(None)

        device.set_run_finished_handler(lambda _: done)
        task = asyncio.create_task(commit())
        await device._handle_inbound("run.finished", event)
        await task
        self.assertEqual(calls, [("schedule.ack", {"runId": "original", "finished": True}, True)])

    async def test_resolve_forwards_original_identity_and_result(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"run": {"id": "original", "status": "success"}}

        device = PhononDevice("device", "owner", Peer())
        dispatch = {"key": "automation", "revision": 3, "contentHash": "a" * 64}
        result = await device.run_resolve("original", dispatch, "success", result_text="actual result", client_request_id="same-key")
        self.assertEqual(result["run"]["status"], "success")
        self.assertEqual(calls, [("run.resolve", {"runId": "original", "dispatch": dispatch, "status": "success",
                                                "resultText": "actual result", "clientRequestId": "same-key"})])
