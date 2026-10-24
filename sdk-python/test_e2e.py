"""Python SDK e2e：Python PhononServer 编排真实 phonon（Node core PhononClient）。
验证跨语言协议互通 + 多设备。"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from agent_phonon import PhononServer  # noqa: E402
from agent_phonon.rpc import RpcError  # noqa: E402

REPO = str(Path(__file__).resolve().parents[1])

# 一个最小 Node phonon client（用 core + mock adapter 拨入指定 server）
NODE_CLIENT = r"""
import { AdapterRegistry, PhononClient } from "%s/packages/core/dist/index.js";
import { MockAdapter } from "%s/packages/test-server/dist/harness.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const [url, deviceId] = process.argv.slice(2);
const reg = new AdapterRegistry();
reg.register(new MockAdapter({ name:"mock", agentIds:["mock:default"], reply:(i)=>"py-echo:"+i }));
const cwd = mkdtempSync(join(tmpdir(),"pyphonon-"));
const client = new PhononClient({ serverUrl:url, deviceId, registry:reg, trustLocal:true, workspaceRoot:cwd });
await client.connect();
console.error("CONNECTED " + deviceId);
process.on("SIGTERM", ()=>{ client.close(); process.exit(0); });
await new Promise(()=>{});
""" % (REPO, REPO)


async def run_phonon(url: str, device_id: str) -> asyncio.subprocess.Process:
    f = tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False)
    f.write(NODE_CLIENT)
    f.close()
    proc = await asyncio.create_subprocess_exec(
        "node", f.name, url, device_id,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    # 等 CONNECTED；必须异步读 stderr，不能用阻塞 readline 卡住 event loop。
    lines: list[str] = []
    for _ in range(100):
        assert proc.stderr is not None
        try:
            raw = await asyncio.wait_for(proc.stderr.readline(), timeout=0.2)
        except asyncio.TimeoutError:
            if proc.returncode is not None:
                break
            continue
        if not raw:
            if proc.returncode is not None:
                raise RuntimeError(f"phonon {device_id} exited before connect; code={proc.returncode}; stderr={lines[-20:]}")
            continue
        line = raw.decode(errors="replace").strip()
        lines.append(line)
        if "CONNECTED" in line:
            return proc
    if proc.returncode is None:
        proc.terminate()
        await proc.wait()
    raise RuntimeError(f"phonon {device_id} did not connect; code={proc.returncode}; stderr={lines[-20:]}")


async def main() -> None:
    results: dict[str, str] = {}
    errors: list[Exception] = []
    completed = asyncio.Event()
    completed_count = 0

    server = PhononServer(authenticate=lambda did, key: asyncio.sleep(0, result=f"t-{did}"))
    port = await server.listen()
    print(f"[py-server] listening on {port}")

    devices_seen: list[str] = []

    async def on_device(device):
        devices_seen.append(device.device_id)
        agents = await device.discover()
        assert any(a["agentId"] == "mock:default" for a in agents), "discover failed"
        info = await device.info()
        assert info["os"]["platform"], "device info failed"
        resources = await device.resources()
        assert resources["memory"]["totalBytes"] > 0, "resources failed"
        proj = await device.project_create("p", git=False)
        project_id = proj["project"]["projectId"]
        await device.env_set("global", "PY_SDK_TOKEN", "secret-value")
        envs = await device.env_list()
        assert any(v["name"] == "PY_SDK_TOKEN" and v["redacted"] for v in envs["variables"]), "env list failed"
        if {"secure_file_broker_linux_v1", "secure_file_transfer_darwin_v1"}.intersection(info.get("capabilities", [])):
            await device.file_write(project_id, "hello.txt", "from-python")
            file_read = await device.file_read(project_id, "hello.txt")
            assert file_read["data"] == "from-python", "file read/write failed"
        else:
            try:
                await device.file_write(project_id, "hello.txt", "from-python")
            except RpcError as error:
                assert error.app_code == "errPolicyDenied" and "unsupported" in str(error), str(error)
            else:
                raise AssertionError("Unadvertised secure file write unexpectedly succeeded")
            print(f"[py-server] {device.device_id}: unsupported file broker rejection verified")
        session = await device.create_session(project_id, "mock:default", "m1")
        await session.send("hello from python")
        text = ""
        async for ev in session.stream():
            if ev.get("type") == "message":
                text += ev.get("text", "")
        results[device.device_id] = text
        await session.terminate()

    async def checked_device(device):
        nonlocal completed_count
        try:
            await on_device(device)
        except Exception as error:
            errors.append(error)
        finally:
            completed_count += 1
            if completed_count >= 2:
                completed.set()

    server.on_device(checked_device)
    procs = []
    try:
        started = await asyncio.gather(
            run_phonon(f"ws://127.0.0.1:{port}", "py-dev-1"),
            run_phonon(f"ws://127.0.0.1:{port}", "py-dev-2"),
            return_exceptions=True,
        )
        procs = [process for process in started if isinstance(process, asyncio.subprocess.Process)]
        for process in started:
            if isinstance(process, BaseException):
                raise process
        await asyncio.wait_for(completed.wait(), timeout=30)
    finally:
        for process in procs:
            if process.returncode is None:
                process.terminate()
        await server.close()
        for process in procs:
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    # 断言
    assert len(devices_seen) == 2, f"expected 2 devices, got {devices_seen}"
    assert not errors, f"device callback failed: {errors!r}"
    assert set(results) == {"py-dev-1", "py-dev-2"}, f"missing device results: {results}"
    assert all("py-echo:hello from python" in t for t in results.values()), f"stream mismatch: {results}"
    print(f"[py-server] ✅ MULTI-DEVICE OK: {list(results.keys())}")
    print(f"[py-server] streamed: {results}")


if __name__ == "__main__":
    asyncio.run(main())
