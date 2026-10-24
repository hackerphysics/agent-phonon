import unittest
from uuid import uuid4
from agent_phonon.server import PhononDevice


class SkillIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_skill_helpers_preserve_original_retry_identity_and_scope(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"observed": True}

        device = PhononDevice("device", "owner", Peer())
        source = {"kind": "inline", "files": {"SKILL.md": "Exact bytes"}}
        await device.skill_install("mock:default", "fixed", "project", source, "owned", client_request_id="original\0identity")
        await device.skill_uninstall("mock:default", "fixed", "project", "owned", client_request_id="original\0identity")
        await device.skill_install_status("mock:default", "fixed", "project", "original\0identity", "owned")
        self.assertEqual(calls, [
            ("skill.install", {"agent": "mock:default", "name": "fixed", "scope": "project", "projectId": "owned", "source": source, "clientRequestId": "original\0identity"}),
            ("skill.uninstall", {"agent": "mock:default", "name": "fixed", "scope": "project", "projectId": "owned", "clientRequestId": "original\0identity"}),
            ("skill.install.status", {"agent": "mock:default", "name": "fixed", "scope": "project", "projectId": "owned", "clientRequestId": "original\0identity"}),
        ])

    async def test_optional_fields_are_absent_not_protocol_nulls(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {}

        device = PhononDevice("device", "owner", Peer())
        source = {"kind": "inline", "files": {"SKILL.md": "Data"}}
        await device.skill_install("mock:default", "fixed", "global", source)
        await device.skill_uninstall("mock:default", "fixed", "global")
        for _, params in calls:
            self.assertNotIn("projectId", params)
            self.assertNotIn("clientRequestId", params)

    async def test_immutable_publication_uses_separate_methods_with_original_base_and_identity(self):
        calls = []
        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {}
        device = PhononDevice("device", "owner", Peer())
        source = {"kind": "inline", "files": {"SKILL.md": "Original bytes"}}
        await device.skill_publish("mock:default", "selected", "owned", source, None, "original-publish")
        await device.skill_unpublish("mock:default", "selected", "owned", "a" * 64, "original-unpublish")
        self.assertEqual(calls, [
            ("skill.publish", {"agent": "mock:default", "name": "selected", "scope": "project", "projectId": "owned", "source": source, "baseRevision": None, "clientRequestId": "original-publish"}),
            ("skill.unpublish", {"agent": "mock:default", "name": "selected", "scope": "project", "projectId": "owned", "baseRevision": "a" * 64, "clientRequestId": "original-unpublish"}),
        ])

    async def test_pinned_receiver_and_opted_in_status_preserve_the_exact_receipt(self):
        calls = []
        receiver = str(uuid4())
        receipt = {"receiverID": receiver, "state": "confirmed"}

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return receipt

        device = PhononDevice("device", "owner", Peer())
        source = {"kind": "inline", "files": {"SKILL.md": "Exact original bytes"}}
        self.assertEqual(await device.skill_publish("mock:default", "selected", "owned", source, None, "pinned", expected_receiver_id=receiver), receipt)
        self.assertEqual(await device.skill_install_status("mock:default", "selected", "project", "pinned", "owned", include_receiver_identity=True), receipt)
        self.assertEqual(calls, [
            ("skill.publish", {"agent": "mock:default", "name": "selected", "scope": "project", "projectId": "owned", "source": source, "baseRevision": None, "clientRequestId": "pinned", "expectedReceiverID": receiver}),
            ("skill.install.status", {"agent": "mock:default", "name": "selected", "scope": "project", "projectId": "owned", "clientRequestId": "pinned", "includeReceiverIdentity": True}),
        ])

    async def test_recovery_context_and_fence_never_synthesize_success_or_publish_another_tree(self):
        calls = []
        receiver = str(uuid4())
        receipt = {"outcomeKnown": False, "targetLocked": True}

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return receipt

        device = PhononDevice("device", "owner", Peer())
        self.assertEqual(await device.skill_install_status("mock:default", "fixed", "project", "original", "owned", include_recovery_context=True), receipt)
        self.assertEqual(await device.skill_install_fence("mock:default", "fixed", "owned", "original", receiver, "a" * 64, "human-fence"), receipt)
        self.assertEqual(calls, [
            ("skill.install.status", {"agent": "mock:default", "name": "fixed", "scope": "project", "projectId": "owned", "clientRequestId": "original", "includeRecoveryContext": True}),
            ("skill.install.fence", {"agent": "mock:default", "name": "fixed", "scope": "project", "projectId": "owned", "originalRequestId": "original", "expectedReceiverID": receiver, "baseRecoveryRevision": "a" * 64, "clientRequestId": "human-fence"}),
        ])
