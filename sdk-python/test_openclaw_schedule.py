import unittest
from agent_phonon.server import PhononDevice


class OpenClawScheduleTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_reads_use_vendor_namespace_and_preserve_results(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"native": True}

        device = PhononDevice("device", "owner", Peer())
        self.assertEqual(await device.openclaw_schedule_list(), {"native": True})
        self.assertEqual(await device.openclaw_schedule_get("vendor-job"), {"native": True})
        self.assertEqual(calls, [("openclaw.schedule.list", {}),
                                 ("openclaw.schedule.get", {"id": "vendor-job"})])

    async def test_native_read_errors_propagate(self):
        class Peer:
            async def request(self, method, params):
                raise RuntimeError("errAgentUnavailable")

        device = PhononDevice("device", "owner", Peer())
        with self.assertRaisesRegex(RuntimeError, "errAgentUnavailable"):
            await device.openclaw_schedule_list()
        with self.assertRaisesRegex(RuntimeError, "errAgentUnavailable"):
            await device.openclaw_schedule_get("missing")
