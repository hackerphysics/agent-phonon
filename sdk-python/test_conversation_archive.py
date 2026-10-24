import asyncio
import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from agent_phonon import PhononServer
from agent_phonon.server import PhononDevice

REPO = Path(__file__).resolve().parents[1]


class ConversationArchiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_wrappers_preserve_scope_frozen_data_and_proof_without_agent_calls(self):
        calls = []

        class Peer:
            async def request(self, method, params):
                calls.append((method, params))
                return {"persistent": True, "throughSequence": "9007199254740993", "headHash": "a" * 64}

        device = PhononDevice("device", "owner", Peer())
        params = {"conversationId": "original", "archiveEpoch": "epoch", "projectId": None}
        for method, invoke in [("conversation.archive.status", device.conversation_archive_status), ("conversation.archive.append", device.conversation_archive_append), ("conversation.archive.read", device.conversation_archive_read), ("conversation.archive.entities", device.conversation_archive_entities), ("conversation.archive.blob.write", device.conversation_archive_blob_write), ("conversation.archive.blob.status", device.conversation_archive_blob_status), ("conversation.archive.blob.read", device.conversation_archive_blob_read)]:
            result = await invoke(params)
            self.assertEqual(calls[-1][0], method)
            self.assertIs(calls[-1][1], params)
            self.assertTrue(result["persistent"])
            self.assertEqual(result["throughSequence"], "9007199254740993")
        self.assertEqual(len(calls), 7)
        photo = {**params, "blobId": str(uuid4()), "sizeBytes": 20 * 1024 * 1024, "sha256": "a" * 64}
        await device.conversation_archive_blob_status(photo)
        self.assertIs(calls[-1][1], photo)

    async def test_authenticated_node_archive_survives_restart_with_python_hash_and_paging(self):
        async def auth(device_id, key):
            return "archive-owner" if device_id.startswith("archive-fixture-") and key == "fixture-only" else None

        devices = asyncio.Queue()
        server = PhononServer(authenticate=auth)

        async def connected(device):
            await devices.put(device)

        server.on_device(connected)
        script = r'''
import { AdapterRegistry, PhononClient } from "__CORE__";
import { join } from "node:path";
const [url, directory, deviceId] = process.argv.slice(1);
const client = new PhononClient({serverUrl: url, deviceId,
  deviceKey: "fixture-only", expectedTenantId: "archive-owner",
  registry: new AdapterRegistry(), workspaceRoot: directory,
  dbPath: join(directory, "device.sqlite"), policy: {allowConversationArchives: true}});
process.on("SIGTERM", () => { client.close(); process.exit(0); });
await client.connect();
console.log("READY");
'''.replace("__CORE__", (REPO / "packages/core/dist/index.js").as_uri())
        target = {"conversationId": str(uuid4()), "archiveEpoch": str(uuid4()), "projectId": None}
        entries = [{"sequence": str(n), "recordId": str(uuid4()), "kind": "message", "entityId": str(uuid4()), "revision": "1",
                    "payloadJSON": json.dumps({"text": "original \u4e2d\u6587", "order": n}, ensure_ascii=False)} for n in (1, 2)]
        entries[1]["catalog"] = {"collection": "messages", "key": "second", "order": "9007199254740993", "version": "2", "part": 1, "parts": 1, "deleted": False}

        def digest(value):
            return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

        proc = None
        try:
            port = await server.listen()
            head = digest(["phonon-conversation-archive-v1", f"http://127.0.0.1:{port}", "archive-owner",
                           target["conversationId"], target["archiveEpoch"], None])
            with tempfile.TemporaryDirectory(prefix="phonon-py-archive-") as directory:
                try:
                    for attempt in range(2):
                        proc = await asyncio.create_subprocess_exec("node", "--input-type=module", "--eval", script,
                            f"ws://127.0.0.1:{port}", directory, f"archive-fixture-{attempt}",
                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                        self.assertEqual(await asyncio.wait_for(proc.stdout.readline(), 10), b"READY\n")
                        device = await asyncio.wait_for(devices.get(), 5)
                        state = await device.conversation_archive_status(target)
                        self.assertEqual(state["headHash"], head)
                        if attempt == 0:
                            self.assertFalse(state["found"])
                            receipt = await device.conversation_archive_append({**target, "afterSequence": "0", "afterHash": head, "entries": entries})
                            for entry in entries:
                                fields = ["phonon-conversation-archive-entry-v1", head, entry["sequence"], entry["recordId"], entry["kind"], entry["entityId"], entry["revision"], entry["payloadJSON"]]
                                if "catalog" in entry:
                                    index = entry["catalog"]
                                    fields.append(["phonon-conversation-entity-index-v1", index["collection"], index["key"], index["order"], index["version"], index["part"], index["parts"], index["deleted"]])
                                head = digest(fields)
                            self.assertEqual(receipt["committedHash"], head)
                        else:
                            self.assertTrue(state["persistent"])
                            self.assertEqual(state["throughSequence"], "2")
                        page = await device.conversation_archive_read({**target, "limit": 1})
                        self.assertEqual(page["entries"][0]["payloadJSON"], entries[0]["payloadJSON"])
                        self.assertEqual(page["nextAfterSequence"], "1")
                        last = await device.conversation_archive_read({**target, "afterSequence": page["nextAfterSequence"],
                            "afterHash": page["entries"][-1]["hash"], "throughSequence": page["throughSequence"]})
                        self.assertEqual(last["entries"][0]["recordId"], entries[1]["recordId"])
                        self.assertEqual(last["headHash"], head)
                        self.assertNotIn("nextAfterSequence", last)
                        self.assertEqual(await device.list_sessions(), {"sessions": []})
                        indexed = await device.conversation_archive_entities({**target, "collection": "messages"})
                        self.assertEqual(indexed["entities"][0]["key"], "second")
                        self.assertEqual(indexed["entities"][0]["order"], "9007199254740993")
                        binary = b"\x00\xff\x80original attachment"
                        blob = {**target, "blobId": target["conversationId"], "sha256": hashlib.sha256(binary).hexdigest(), "sizeBytes": len(binary)}
                        if attempt == 0:
                            self.assertFalse((await device.conversation_archive_blob_status(blob))["found"])
                            receipt = await device.conversation_archive_blob_write({**blob, "offset": 0, "data": base64.b64encode(binary).decode("ascii")})
                            self.assertTrue(receipt["complete"])
                        self.assertTrue((await device.conversation_archive_blob_status(blob))["complete"])
                        self.assertEqual(base64.b64decode((await device.conversation_archive_blob_read(blob))["data"]), binary)
                        proc.terminate()
                        _, stderr = await asyncio.wait_for(proc.communicate(), 5)
                        self.assertEqual(proc.returncode, 0, stderr.decode())
                finally:
                    if proc and proc.returncode is None:
                        proc.terminate()
                        await asyncio.wait_for(proc.communicate(), 5)
        finally:
            await server.close()


if __name__ == "__main__":
    unittest.main()
