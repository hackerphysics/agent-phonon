import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, OpenClawGatewayAdapter, PhononClient } from "@agent-phonon/core";
import { PhononTestServer } from "@agent-phonon/test-server";

/**
 * A 阶段验收 e2e：完整链路 project.create → skill.install → session.create(绑项目)
 * → send → 流式 → compress → switchModel → terminate。全程经 test-server 驱动真实 Gateway。
 */
test("e2e-full: project + skill + session full lifecycle", { timeout: 240000 }, async () => {
  const token = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf8")).gateway.auth.token;
  process.env.PHONON_PROJECTS_ROOT = join(tmpdir(), "phonon-full-" + Date.now());

  const server = new PhononTestServer({ assignTenant: () => "tenant-FULL" });
  const port = await server.listen();
  const registry = new AdapterRegistry();
  const gwAdapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://127.0.0.1:18789", token }, defaultAgent: "phonon" });
  registry.register(gwAdapter);
  const client = new PhononClient({ serverUrl: `ws://127.0.0.1:${port}`, deviceId: "dev-full", registry, trustLocal: true });
  await client.connect();
  const device = await server.firstDevice();

  // 1) discovery 枚举多 agent
  const disco = (await device.peer.requestRaw("discovery.list", {})) as { agents: Array<{ agentId: string }> };
  assert.ok(disco.agents.some((a) => a.agentId === "openclaw:phonon"), "should enumerate openclaw:phonon");

  // 2) project.create（目录 + git）
  const proj = (await device.peer.requestRaw("project.create", { name: "e2e-demo", git: true })) as { project: { projectId: string; path: string; git: boolean } };
  assert.ok(proj.project.projectId);
  assert.equal(proj.project.git, true);

  // 3) skill.install (project scope → <project>/skills)
  const skill = (await device.peer.requestRaw("skill.install", {
    agent: "openclaw:phonon", name: "demo-skill", scope: "project", projectId: proj.project.projectId,
    source: { kind: "inline", files: { "SKILL.md": "# Demo Skill" } },
  })) as { skill: { installedPath: string } };
  assert.ok(skill.skill.installedPath.startsWith(join(proj.project.path, ".agent", "skills")), "project skill under project/skills");

  // 4) skill.list
  const skills = (await device.peer.requestRaw("skill.list", { projectId: proj.project.projectId })) as { skills: unknown[] };
  assert.equal(skills.skills.length, 1);

  // 5) session.create 绑定该 project
  const created = (await device.peer.requestRaw("session.create", {
    project: proj.project.projectId, agent: "openclaw:phonon", model: "github-copilot/claude-opus-4.8", verbosity: "messages",
  })) as { sessionId: string };

  // 6) send + 流式
  const ack = (await device.peer.requestRaw("session.send", { sessionId: created.sessionId, input: "Reply with exactly: FULL_OK" })) as { turnId: string };
  const result = await device.waitForTurnEnd(ack.turnId);
  assert.equal((result as { type: string }).type, "result");

  // 7) compress (native)
  const comp = (await device.peer.requestRaw("session.compress", { sessionId: created.sessionId, mode: "native" })) as { mode: string };
  assert.equal(comp.mode, "native");

  // 8) switchModel
  const sw = (await device.peer.requestRaw("session.switchModel", { sessionId: created.sessionId, model: "github-copilot/gpt-5.5" })) as { model: string; previousModel: string };
  assert.equal(sw.model, "github-copilot/gpt-5.5");

  // 9) terminate
  const term = (await device.peer.requestRaw("session.terminate", { sessionId: created.sessionId })) as { status: string };
  assert.equal(term.status, "terminated");

  // 10) project.remove（无 active session 了）
  const rm = (await device.peer.requestRaw("project.remove", { projectId: proj.project.projectId, deleteFiles: true })) as { removed: boolean };
  assert.equal(rm.removed, true);

  client.close();
  gwAdapter.close();
  await server.close();
});
