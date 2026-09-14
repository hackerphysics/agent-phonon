"""A5 behavioral tests: actual loopback sockets, mock-only wildcard bind and Node core interop."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import websockets
from agent_phonon import PhononServer

REPO = Path(__file__).resolve().parents[1]


class AsyncAuthenticator:
    def __init__(self, tenant):
        self.tenant = tenant
        self.calls = []

    async def __call__(self, device_id, key):
        await asyncio.sleep(0)
        self.calls.append((device_id, key))
        return self.tenant


class FalseyBoolAuthenticator(AsyncAuthenticator):
    def __bool__(self):
        return False


class FalseyLenAuthenticator(AsyncAuthenticator):
    def __len__(self):
        return 0


class AuthenticationTests(unittest.IsolatedAsyncioTestCase):
    async def test_noncallable_auth_rejected_at_construction_without_bind(self):
        with patch("agent_phonon.server.websockets.serve", new_callable=AsyncMock) as serve:
            for auth in (False, 0, "", [], {}, True, 1, "not-a-callback"):
                for opt in (False, True):
                    for host in ("0.0.0.0", "127.0.0.1"):
                        with self.subTest(auth=auth, opt=opt, host=host):
                            with self.assertRaisesRegex(TypeError, "authenticate must be callable or None"):
                                PhononServer(host=host, authenticate=auth, allow_anonymous=opt)
            serve.assert_not_called()

    async def test_noncallable_auth_rejected_at_listen_before_bind(self):
        fake = Mock()
        fake.sockets = [Mock()]
        fake.sockets[0].getsockname.return_value = ("0.0.0.0", 12345)
        with patch("agent_phonon.server.websockets.serve", new_callable=AsyncMock, return_value=fake) as serve:
            for auth in (False, 0, "", [], {}, True, 1, "not-a-callback"):
                for opt in (False, True):
                    with self.subTest(auth=auth, opt=opt):
                        server = PhononServer(host="0.0.0.0", allow_anonymous=opt)
                        # Defensive check if an embedding caller changes the stored callback.
                        server._authenticate = auth
                        with self.assertRaisesRegex(TypeError, "authenticate must be callable or None"):
                            await server.listen()
            serve.assert_not_called()

    async def _check_falsey_async_auth(self, tenant):
        for factory in (FalseyBoolAuthenticator, FalseyLenAuthenticator):
            for opt in (False, True):
                with self.subTest(falsey=factory.__name__, opt=opt, tenant=tenant):
                    auth = factory(tenant)
                    self.assertTrue(callable(auth))
                    self.assertFalse(auth)
                    server = PhononServer(authenticate=auth, allow_anonymous=opt)
                    try:
                        port = await server.listen()
                        self.assertEqual(server._server.sockets[0].getsockname()[0], "127.0.0.1")
                        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                            await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "connect.hello", "params": {
                                "deviceId": "fixture", "auth": {"deviceKey": "fixture-only"}}}))
                            reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
                            self.assertEqual(auth.calls, [("fixture", "fixture-only")])
                            if tenant is None:
                                self.assertNotIn("result", reply)
                                self.assertIn("unauthorized", reply["error"]["message"])
                                self.assertEqual(server.list_devices(), [])
                            else:
                                self.assertEqual(reply["result"]["tenantId"], tenant)
                                self.assertIsNotNone(server.get_device("fixture"))
                    finally:
                        await server.close()

    async def test_falsey_async_auth_none_rejects_with_and_without_anonymous_opt_in(self):
        await self._check_falsey_async_auth(None)

    async def test_falsey_async_auth_tenant_accepts_with_and_without_anonymous_opt_in(self):
        await self._check_falsey_async_auth("tenant-falsey-auth")

    async def test_default_bind_and_local_anonymous_hello(self):
        server = PhononServer()
        try:
            port = await server.listen()
            self.assertEqual(server._server.sockets[0].getsockname()[0], "127.0.0.1")
            async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "connect.hello", "params": {"deviceId": "local"}}))
                reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
                self.assertEqual(reply["result"]["tenantId"], "tenant-local")
        finally:
            await server.close()

    async def test_nonloopback_anonymous_rejected_before_bind(self):
        with patch("agent_phonon.server.websockets.serve", new_callable=AsyncMock) as serve:
            for host in ("0.0.0.0", "::", "192.0.2.1", "", None):
                for opt in (False, "True", 1):
                    with self.subTest(host=host, opt=opt):
                        with self.assertRaisesRegex(ValueError, "without authenticate"):
                            await PhononServer(host=host, allow_anonymous=opt).listen()
            serve.assert_not_called()

    async def test_explicit_exception_and_auth_use_exact_bind_host_without_real_socket(self):
        fake = Mock()
        fake.sockets = [Mock()]
        fake.sockets[0].getsockname.return_value = ("0.0.0.0", 12345)
        async def auth(_id, _key):
            return "fixture"
        with patch("agent_phonon.server.websockets.serve", new_callable=AsyncMock, return_value=fake) as serve:
            for options in ({"allow_anonymous": True}, {"authenticate": auth}):
                server = PhononServer(host="0.0.0.0", **options)
                self.assertEqual(await server.listen(), 12345)
                self.assertEqual(serve.call_args.args[1:], ("0.0.0.0", 0))
            self.assertEqual(serve.await_count, 2)

    async def test_async_auth_rejects_wrong_identity_and_key_over_real_ws(self):
        calls = []
        async def auth(device_id, key):
            await asyncio.sleep(0)
            calls.append((device_id, key))
            return "tenant-fixture" if device_id == "fixture" and key == "fixture-only" else None
        # Opt-in must never bypass a supplied authentication callback.
        server = PhononServer(authenticate=auth, allow_anonymous=True)
        try:
            port = await server.listen()
            for device_id, key, accepted in [("fixture", None, False), ("fixture", "wrong", False), ("wrong", "fixture-only", False), ("fixture", "fixture-only", True)]:
                async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "connect.hello", "params": {"deviceId": device_id, "auth": {"deviceKey": key}}}))
                    reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
                    if accepted:
                        self.assertEqual(reply["result"]["tenantId"], "tenant-fixture")
                    else:
                        self.assertIn("unauthorized", reply["error"]["message"])
                        self.assertEqual(server.list_devices(), [])
            self.assertEqual(len(calls), 4)
        finally:
            await server.close()

    async def test_node_core_auth_and_expected_tenant_cross_language(self):
        async def auth(device_id, key):
            await asyncio.sleep(0)
            return "tenant-fixture" if device_id == "fixture" and key == "fixture-only" else None
        server = PhononServer(authenticate=auth)
        port = await server.listen()
        script = r'''
import assert from "node:assert/strict";
import { AdapterRegistry, PhononClient } from "__CORE__";
const url = process.argv[2];
for (const [deviceId, deviceKey, expectedTenantId, expectedError] of [
  ["fixture", undefined, "tenant-fixture", "unauthorized"],
  ["fixture", "wrong", "tenant-fixture", "unauthorized"],
  ["wrong", "fixture-only", "tenant-fixture", "unauthorized"],
  ["fixture", "fixture-only", "wrong-tenant", "identity check"],
  ["fixture", "fixture-only", "tenant-fixture", null],
]) {
  const client = new PhononClient({ serverUrl: url, deviceId, deviceKey, expectedTenantId,
    registry: new AdapterRegistry(), workspaceRoot: process.argv[3] });
  try {
    if (expectedError) await assert.rejects(client.connect(), e => e.message.includes(expectedError));
    else assert.deepEqual(await client.connect(), { tenantId: "tenant-fixture" });
  } finally { client.close(); }
}
console.log("cross-language auth and identity: PASS");
'''.replace("__CORE__", (REPO / "packages/core/dist/index.js").as_uri())
        proc = None
        try:
            with tempfile.TemporaryDirectory(prefix="phonon-py-auth-") as directory:
                path = Path(directory) / "client.mjs"
                path.write_text(script)
                proc = await asyncio.create_subprocess_exec("node", str(path), f"ws://127.0.0.1:{port}", directory,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                stdout, stderr = await asyncio.wait_for(proc.communicate(), 20)
                self.assertEqual(proc.returncode, 0, stderr.decode())
                self.assertIn(b"cross-language auth and identity: PASS", stdout)
        finally:
            if proc and proc.returncode is None:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), 5)
            await server.close()


if __name__ == "__main__":
    unittest.main()
