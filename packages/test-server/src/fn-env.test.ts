import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "@agent-phonon/core";
import { MockAdapter, TestConn } from "./harness.js";

function setup(opts?: { allowReveal?: boolean }) {
  const adapter = new MockAdapter({ name: "mock", agentIds: ["mock:default"] });
  const r = new AdapterRegistry();
  r.register(adapter);
  const root = mkdtempSync(join(tmpdir(), "phonon-env-"));
  const tc = new TestConn({ registry: r, workspaceRoot: root, trustLocal: true });
  return { tc, adapter };
}

test("env.set/list/delete: default list is redacted", async () => {
  const { tc } = setup();
  await tc.call("env.set", { scope: "global", name: "API_KEY", value: "secret-1234" });
  const listed = await tc.call("env.list", {}) as { variables: Array<{ name: string; value?: string; redacted: boolean }> };
  const v = listed.variables.find((x) => x.name === "API_KEY")!;
  assert.equal(v.value, "****1234");
  assert.equal(v.redacted, true);
  await assert.rejects(() => tc.call("env.list", { reveal: true }), (e: any) => e?.data?.appCode === "errPolicyDenied");
  const del = await tc.call("env.delete", { scope: "global", name: "API_KEY" }) as { deleted: boolean };
  assert.equal(del.deleted, true);
});

test("env variables are injected into session.send environment with precedence", async () => {
  const { tc, adapter } = setup();
  const proj = await tc.call("project.create", { name: "p", git: false }) as { project: { projectId: string } };
  const projectId = proj.project.projectId;
  await tc.call("env.set", { scope: "global", name: "SHARED", value: "global" });
  await tc.call("env.set", { scope: "project", projectId, name: "SHARED", value: "project" });
  await tc.call("env.set", { scope: "skill", projectId, agent: "mock:default", skillName: "s1", name: "SKILL_TOKEN", value: "skill-token" });
  const created = await tc.call("session.create", { project: projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
  const ack = await tc.call("session.send", { sessionId: created.sessionId, input: "hi", skills: ["s1"] }) as { turnId: string };
  await tc.waitTurnEnd(ack.turnId);
  assert.equal(adapter.lastSession?.lastEnvironment?.SHARED, "project");
  assert.equal(adapter.lastSession?.lastEnvironment?.SKILL_TOKEN, "skill-token");
});
