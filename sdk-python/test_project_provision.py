import unittest
from agent_phonon import PhononDevice


class ProjectProvisionTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, info):
        calls = []
        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return info if method == "device.info" else {"state": "unknown"}
        return PhononDevice("device", "owner", Peer()), calls

    async def test_exact_receiver_retry_and_original_status_are_forwarded_without_automatic_reissue(self):
        receiver = "11111111-1111-4111-8111-111111111111"
        request = "22222222-2222-4222-8222-222222222222"
        device, calls = self.fixture({"capabilities": ["project_provision_v1"], "projectProvisionReceiverID": receiver})
        await device.project_provision(request, "Owned workspace", receiver)
        await device.project_provision_status(request, receiver)
        self.assertEqual(calls, [("device.info", {}), ("project.provision", {"clientRequestId": request, "name": "Owned workspace", "expectedReceiverID": receiver}),
                                 ("project.provision.status", {"clientRequestId": request, "expectedReceiverID": receiver})])

    async def test_missing_or_malformed_capabilities_and_wrong_receiver_never_mutate(self):
        receiver = "11111111-1111-4111-8111-111111111111"
        for info in [None, False, {}, {"capabilities": "project_provision_v1", "projectProvisionReceiverID": receiver},
                     {"capabilities": [], "projectProvisionReceiverID": receiver}, {"capabilities": ["project_provision_v1"], "projectProvisionReceiverID": "different"}]:
            with self.subTest(info=info):
                device, calls = self.fixture(info)
                with self.assertRaisesRegex(RuntimeError, "project_provision_device_update_required"):
                    await device.project_provision("request", "Owned", receiver)
                self.assertEqual(calls, [("device.info", {})])

    async def test_legacy_project_create_adds_no_capability_probe(self):
        device, calls = self.fixture({})
        await device.project_create("Legacy", git=False)
        self.assertEqual(calls, [("project.create", {"name": "Legacy", "git": False})])
