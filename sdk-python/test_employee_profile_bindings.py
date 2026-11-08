import unittest

from agent_phonon.server import PhononDevice


class EmployeeProfileBindings(unittest.IsolatedAsyncioTestCase):
    async def test_optional_profile_binding_is_forwarded_without_changing_identity(self):
        class Peer:
            async def request(self, method, params):
                self.method, self.params = method, params
                return {"state": "ready", "employeeId": params["employeeId"]}

        peer = Peer()
        device = PhononDevice("device", "owner", peer)
        for binding in [{"kind": "harness"}, {"kind": "employee", "employeeId": "source"}]:
            result = await device.employee_profile_apply(employeeId="second", profileBinding=binding)
            self.assertEqual(peer.method, "employee.profile.apply")
            self.assertIs(peer.params["profileBinding"], binding)
            self.assertEqual(result["employeeId"], "second")
