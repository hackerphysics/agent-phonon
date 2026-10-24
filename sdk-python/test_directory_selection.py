import unittest
from agent_phonon import PhononDevice


class DirectorySelectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_native_fields_are_forwarded_after_capability_check(self):
        calls = []
        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                if method == "device.info":
                    return {"capabilities": ["workspace_directory_picker_v1"]}
                return {"project": {"directoryIdentity": "dir:1:2"}}
        device = PhononDevice("device", "owner", Peer())
        await device.fs_list(projectCandidates=True, directoryInput="C:\\Users\\Ow", limit=100)
        await device.project_create("Code", git=False, path="C:\\work", existingDirectoryIdentity="dir:1:2", clientRequestId="original")
        self.assertEqual([method for method, _ in calls], ["device.info", "device.fs.list", "device.info", "project.create"])
        self.assertEqual(calls[1][1], {"projectCandidates": True, "directoryInput": "C:\\Users\\Ow", "limit": 100})
        self.assertEqual(calls[3][1]["existingDirectoryIdentity"], "dir:1:2")

    async def test_legacy_device_cannot_silently_ignore_strict_selection(self):
        calls = []
        class Peer:
            async def request(self, method, params):
                calls.append(method)
                return {}
        device = PhononDevice("device", "owner", Peer())
        with self.assertRaisesRegex(RuntimeError, "device_update_required"):
            await device.project_create("Code", git=False, path="/work", existingDirectoryIdentity="dir:1:2")
        self.assertEqual(calls, ["device.info"])
