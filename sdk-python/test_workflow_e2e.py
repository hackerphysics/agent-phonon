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

    # 5. v0.7 HITL —— workflow.human_review + interaction.request 反向调用 走 Python SDK
    review_received: list[dict] = []
    async def on_interaction(params: dict) -> dict:
        review_received.append(params)
        # 模拟 reviewer approve + 带 feedback
        return {"values": {"approved": True, "feedback": "shipped by python SDK", "reviewer": "alice"}}
    device.set_interaction_handler(on_interaction)

    # 先重起一个 phonon，让它的 executor 能 emit workflow.human_review directive。
    # MockAdapter 默认 reply 是 echo:…，不会 emit directive；需要临时启个能发 directive 的 phonon。
    HR_NODE_CLIENT = r"""
import { AdapterRegistry, PhononClient } from "%s/packages/core/dist/index.js";
import { MockAdapter } from "%s/packages/test-server/dist/harness.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const [url, deviceId] = process.argv.slice(2);
const reg = new AdapterRegistry();
reg.register(new MockAdapter({
  name:"mock",
  agentIds:["mock:exec","mock:w"],
  models:["m1"],
  reply:(input) => {
    if (input.includes("EXECUTOR of a multi-agent workflow")) {
      return [
        "need review",
        "```phonon.workflow.human_review",
        JSON.stringify({ title:"Approve?", summary:"plan A", timeoutSeconds: 30 }),
        "```",
      ].join("\n");
    }
    return "worker out";
  },
}));
const cwd = mkdtempSync(join(tmpdir(),"py-wf-hr-"));
const client = new PhononClient({ serverUrl:url, deviceId, registry:reg, trustLocal:true, workspaceRoot:cwd, resolveProjectCwd:()=>cwd });
await client.connect();
console.error("CONNECTED " + deviceId);
process.on("SIGTERM", ()=>{ client.close(); process.exit(0); });
await new Promise(()=>{});
""" % (REPO, REPO)

    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as f:
        f.write(HR_NODE_CLIENT)
        hr_script = f.name
    hr_proc = await asyncio.create_subprocess_exec(
        "node", hr_script, f"ws://127.0.0.1:{port}", "py-hr-dev",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    while True:
        line = await hr_proc.stderr.readline()
        if not line:
            raise RuntimeError("hr phonon failed to connect")
        sys.stderr.write(f"[hr-phonon-stderr] {line.decode(errors='replace').rstrip()}\n")
        if b"CONNECTED" in line:
            break
    hr_fut = devices_ready.setdefault("py-hr-dev", asyncio.get_event_loop().create_future())
    hr_device = await hr_fut
    hr_device.set_interaction_handler(on_interaction)

    hr_proj = await hr_device.project_create(name="hr", git=False)
    hr_pid = hr_proj["project"]["projectId"]
    hr_run = await hr_device.workflow_run(
        project=hr_pid,
        input="do",
        plan={
            "mode": "graph",
            "executor": {"nodeId": "exec", "agent": "mock:exec", "model": "m1"},
            "workers": [{"nodeId": "w", "agent": "mock:w", "model": "m1", "role": "worker"}],
            "communicationGraph": {"edges": [{"from": "exec", "to": "w"}], "maxIterations": 3},
        },
    )
    hr_wfid = hr_run["workflowId"]
    for _ in range(100):
        st_hr = await hr_device.workflow_status(hr_wfid)
        if st_hr["status"] in ("completed", "failed", "cancelled", "timeout"):
            break
        await asyncio.sleep(0.1)
    assert st_hr["status"] == "completed", f"HITL workflow failed: {st_hr}"
    assert "shipped by python SDK" in (st_hr.get("finalText") or ""), \
        f"finalText should carry reviewer feedback, got: {st_hr.get('finalText')!r}"
    assert len(review_received) >= 1, "interaction.request should have been delivered to Python SDK handler"
    print(f"[py] ✅ HITL approved via Python SDK, finalText={st_hr.get('finalText')[:60]!r}")

    # 6. workflow.resume —— 击 Python SDK 的 workflow_resume 入口。
    # 这里只验证 SDK 能调通协议（对一个不存在的 workflowId 调用应报 invalid params）。
    try:
        await hr_device.workflow_resume(workflow_id="wf-does-not-exist", strategy="failed_node")
        raise AssertionError("workflow_resume on missing wf should have raised")
    except Exception as e:
        msg = str(e)
        assert "has no resumable checkpoint" in msg or "errInvalidParams" in msg or "invalid" in msg.lower(), \
            f"unexpected error from workflow_resume: {msg}"
        print("[py] ✅ workflow_resume RPC reachable (correctly errored on missing wf)")

    hr_proc.terminate()
    await hr_proc.wait()

    proc.terminate()
    await proc.wait()
    await server.close()
    print("[py] ✅ Python L3 workflow e2e PASSED")


if __name__ == "__main__":
    asyncio.run(main())
