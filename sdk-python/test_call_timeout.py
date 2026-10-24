import asyncio
import json
import unittest

from agent_phonon.rpc import RpcError, RpcPeer
from agent_phonon.server import PhononDevice


class DeviceCallTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_forwards_seconds_and_preserves_the_existing_default(self):
        calls = []

        class Peer:
            async def request(self, method, params, timeout=600.0):
                calls.append((method, params, timeout))
                return {"status": "idle"}

        device = PhononDevice("device", "tenant", Peer())
        await device.call("session.status", {"sessionId": "retained"}, timeout=12.0)
        await device.call("session.status", {"sessionId": "retained"})
        self.assertEqual(calls, [
            ("session.status", {"sessionId": "retained"}, 12.0),
            ("session.status", {"sessionId": "retained"}, 600.0),
        ])

    async def test_timeout_cleans_pending_and_late_response_cannot_poison_the_next_call(self):
        sent = []

        async def send(data):
            sent.append(json.loads(data))

        async def handler(method, params):
            return None

        peer = RpcPeer(send, handler)
        device = PhononDevice("device", "tenant", peer)
        with self.assertRaises(asyncio.TimeoutError):
            await device.call("session.status", {"sessionId": "retained"}, timeout=0.01)
        self.assertEqual(peer._pending, {})
        await peer.handle(json.dumps({"id": sent[0]["id"], "result": {"stale": True}}))
        next_call = asyncio.create_task(device.call("session.status", {"sessionId": "retained"}, timeout=1.0))
        await asyncio.sleep(0)
        await peer.handle(json.dumps({"id": sent[1]["id"], "result": {"status": "idle"}}))
        self.assertEqual(await next_call, {"status": "idle"})
        self.assertEqual(peer._pending, {})

    async def test_remote_errors_are_preserved_and_control_timeout_does_not_resubmit(self):
        sent = []

        async def send(data):
            sent.append(json.loads(data))

        async def handler(method, params):
            return None

        peer = RpcPeer(send, handler)
        device = PhononDevice("device", "tenant", peer)
        read = asyncio.create_task(device.call("session.status", {"sessionId": "retained"}, timeout=1.0))
        await asyncio.sleep(0)
        remote = {"code": -32000, "message": "device disconnected", "data": {"appCode": "errUnauthorized"}}
        await peer.handle(json.dumps({"id": sent[0]["id"], "error": remote}))
        with self.assertRaises(RpcError) as result:
            await read
        self.assertEqual(result.exception.error, remote)
        with self.assertRaises(asyncio.TimeoutError):
            await device.call("workflow.run", {"clientRequestId": "original-receipt"}, timeout=0.01)
        self.assertEqual(len(sent), 2)
        self.assertEqual(peer._pending, {})


if __name__ == "__main__":
    unittest.main()
