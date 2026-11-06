import unittest
from agent_phonon.server import PhononDevice


class HermesScheduleTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_reads_are_profile_scoped(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"native": True}

        device = PhononDevice("device", "owner", Peer())
        self.assertEqual(await device.hermes_schedule_list(), {"native": True})
        await device.hermes_schedule_get("opaque", profile="team")
        self.assertEqual(calls, [("hermes.schedule.list", {}),
                                 ("hermes.schedule.get", {"id": "opaque", "profile": "team"})])

    async def test_native_failures_propagate(self):
        class Peer:
            async def request(self, method, params):
                raise RuntimeError("errAgentUnavailable")

        device = PhononDevice("device", "owner", Peer())
        with self.assertRaisesRegex(RuntimeError, "errAgentUnavailable"):
            await device.hermes_schedule_list()
        with self.assertRaisesRegex(RuntimeError, "errAgentUnavailable"):
            await device.hermes_schedule_get("missing")
