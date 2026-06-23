"""Python SDK L3 workflow e2e — 跨语言验证 v0.5 typed workflow API"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from agent_phonon import PhononServer  # noqa: E402

REPO = str(Path(__file__).resolve().parents[1])

NODE_CLIENT = r"""
import { AdapterRegistry, PhononClient } from "%s/packages/core/dist/index.js";
import { MockAdapter } from "%s/packages/test-server/dist/harness.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const [url, deviceId] = process.argv.slice(2);
const reg = new AdapterRegistry();
reg.register(new MockAdapter({ name:"mock", agentIds:["mock:a","mock:b","mock:c","mock:exec"], models:["m1"], reply:(i)=>"echo:"+i.slice(0,40) }));
const cwd = mkdtempSync(join(tmpdir(),"py-wf-"));
const client = new PhononClient({ serverUrl:url, deviceId, registry:reg, trustLocal:true, workspaceRoot:cwd, resolveProjectCwd:()=>cwd });
await client.connect();
console.error("CONNECTED " + deviceId);
process.on("SIGTERM", ()=>{ client.close(); process.exit(0); });
await new Promise(()=>{});
""" % (REPO, REPO)


async def run_phonon(url: str, device_id: str) -> asyncio.subprocess.Process:
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as f:
        f.write(NODE_CLIENT)
        script = f.name
    proc = await asyncio.create_subprocess_exec(
        "node", script, url, device_id,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    import sys
    while True:
        line = await proc.stderr.readline()
        if not line:
            raise RuntimeError("phonon failed to connect")
        sys.stderr.write(f"[phonon-stderr] {line.decode(errors='replace').rstrip()}\n")
        if b"CONNECTED" in line:
            return proc


async def main() -> None:
    async def auth(did, key=None): return f"t-{did}"
    server = PhononServer(authenticate=auth)
    port = await server.listen()
    print(f"[py] listening on {port}")

    devices_ready: dict[str, asyncio.Future] = {}
    async def on_device(device):
        f = devices_ready.setdefault(device.device_id, asyncio.get_event_loop().create_future())
        if not f.done(): f.set_result(device)
    server.on_device(on_device)

    proc = await run_phonon(f"ws://127.0.0.1:{port}", "py-wf-dev")
    fut = devices_ready.setdefault("py-wf-dev", asyncio.get_event_loop().create_future())
    device = await fut

    # 创建 project
    proj = await device.project_create(name="wf", git=False)
    project_id = proj["project"]["projectId"]

    # 1. DAG with policy + sharedContext
    events: list[dict] = []
    device.set_workflow_event_handler(lambda ev: events.append(ev))

    run = await device.workflow_run(
        project=project_id,
        input="ROOT",
        plan={
            "mode": "dag",
            "nodes": [
                {"nodeId": "a", "agent": "mock:a", "model": "m1", "input": "A"},
                {"nodeId": "b", "agent": "mock:b", "model": "m1", "dependsOn": ["a"], "input": "B"},
            ],
            "finalNodeId": "b",
        },
        policy={"onNodeFailure": "fail_workflow", "maxParallel": 2},
        shared_context={"text": "Be concise", "placement": "append"},
    )
    wfid = run["workflowId"]

    # 等结束
    for _ in range(50):
        st = await device.workflow_status(wfid)
        if st["status"] in ("completed", "failed", "cancelled", "timeout"):
            break
        await asyncio.sleep(0.1)
    assert st["status"] == "completed", f"DAG failed: {st}"
    print(f"[py] ✅ DAG completed, finalText={st.get('finalText', '')[:80]!r}")

    # 2. Discussion
    run2 = await device.workflow_run(
        project=project_id,
        plan={
            "mode": "discussion",
            "topic": "Pick a database",
            "participants": [
                {"nodeId": "p1", "agent": "mock:a", "model": "m1", "role": "advocate"},
                {"nodeId": "p2", "agent": "mock:b", "model": "m1", "role": "skeptic"},
                {"nodeId": "chair", "agent": "mock:exec", "model": "m1", "role": "chairman"},
            ],
            "chairman": "chair",
            "termination": {"chairmanSignal": "NEVER", "maxRounds": 1},
        },
    )
    wfid2 = run2["workflowId"]
    for _ in range(50):
        st2 = await device.workflow_status(wfid2)
        if st2["status"] in ("completed", "failed", "cancelled", "timeout"):
            break
        await asyncio.sleep(0.1)
    assert st2["status"] == "completed", f"Discussion failed: {st2}"
    print(f"[py] ✅ Discussion completed, mode={st2['mode']}, nodes={len(st2['nodes'])}")

    # 3. List with filter
    listing = await device.workflow_list(status="completed", project_id=project_id)
    assert len(listing["workflows"]) >= 2, f"expected >=2 workflows, got {listing}"
    print(f"[py] ✅ workflow_list found {len(listing['workflows'])} completed workflows")

    # 4. workflow.event 自动 ack —— 应该收到至少 1 个 workflow.status=completed
    completed_events = [e for e in events if e.get("type") == "workflow.status" and e.get("status") == "completed"]
    assert len(completed_events) >= 1, "should have received completed event"
    print(f"[py] ✅ received {len(events)} workflow events including {len(completed_events)} completed")

    proc.terminate()
    await proc.wait()
    await server.close()
    print("[py] ✅ Python L3 workflow e2e PASSED")


if __name__ == "__main__":
    asyncio.run(main())
