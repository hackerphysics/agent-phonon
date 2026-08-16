import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AdapterRegistry, buildChildProcessEnvironment, DANGEROUS_CHILD_ENV_NAMES, isDangerousChildEnvName, PhononStore } from "@agent-phonon/core";
import type { TenantPolicy } from "@agent-phonon/protocol";
import { MockAdapter, TestConn } from "./harness.js";

function setup(opts: {
  tenantId?: string;
  trustLocal?: boolean;
  policy?: Partial<TenantPolicy>;
  store?: PhononStore;
  workspaceRoot?: string;
} = {}) {
  const adapter = new MockAdapter({ name: "mock", agentIds: ["mock:default"] });
  const r = new AdapterRegistry();
  r.register(adapter);
  const root = opts.workspaceRoot ?? mkdtempSync(join(tmpdir(), "phonon-env-"));
  const tc = new TestConn({
    registry: r,
    workspaceRoot: root,
    tenantId: opts.tenantId,
    trustLocal: opts.trustLocal ?? true,
    policy: opts.policy,
    store: opts.store,
  });
  return { tc, adapter, root };
}

test("strict policy rejects env.set/delete while env.list remains available", async () => {
  const { tc } = setup({ trustLocal: false });
  assert.deepEqual(await tc.call("env.list", {}), { variables: [] });
  await assert.rejects(
    () => tc.call("env.set", { scope: "global", name: "API_KEY", value: "secret" }),
    (e: any) => e?.data?.appCode === "errPolicyDenied",
  );
  await assert.rejects(
    () => tc.call("env.delete", { scope: "global", name: "API_KEY" }),
    (e: any) => e?.data?.appCode === "errPolicyDenied",
  );
});

test("trustLocal explicitly permits env writes but not reveal", async () => {
  const { tc } = setup({ trustLocal: true });
  await tc.call("env.set", { scope: "global", name: "LOCAL_TOKEN", value: "secret" });
  await assert.rejects(() => tc.call("env.list", { reveal: true }), (e: any) => e?.data?.appCode === "errPolicyDenied");
  assert.deepEqual(await tc.call("env.delete", { scope: "global", name: "LOCAL_TOKEN" }), { deleted: true, name: "LOCAL_TOKEN" });
});

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
  await tc.call("env.set", { scope: "skill", projectId, agent: "mock:default", skillName: "s1", name: "SHARED", value: "skill" });
  await tc.call("env.set", { scope: "skill", projectId, agent: "mock:default", skillName: "s1", name: "SKILL_TOKEN", value: "skill-token" });
  await tc.call("env.set", { scope: "global", name: "API_KEY", value: "ordinary-key" });
  const created = await tc.call("session.create", { project: projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
  const ack = await tc.call("session.send", { sessionId: created.sessionId, input: "hi", skills: ["s1"] }) as { turnId: string };
  await tc.waitTurnEnd(ack.turnId);
  assert.equal(adapter.lastSession?.lastEnvironment?.SHARED, "skill");
  assert.equal(adapter.lastSession?.lastEnvironment?.SKILL_TOKEN, "skill-token");
  assert.equal(adapter.lastSession?.lastEnvironment?.API_KEY, "ordinary-key");
});

test("dangerous remote env names are rejected and filtered before MockAdapter execution", async () => {
  const tenantId = "tenant-danger";
  const store = new PhononStore(":memory:");
  const { tc, adapter } = setup({ tenantId, store });
  const dangerousNames = [...DANGEROUS_CHILD_ENV_NAMES, "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"];
  for (const name of dangerousNames) {
    await assert.rejects(
      () => tc.call("env.set", { scope: "global", name, value: "attacker" }),
      (e: any) => e?.data?.appCode === "errInvalidParams" && String(e?.message).includes("dangerous env var"),
      `${name} must be rejected explicitly`,
    );
  }

  // Simulate tenant-owned rows written by an older implementation/direct DB tool.
  const updatedAt = new Date().toISOString();
  for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "PATH", "HOME"]) {
    store.envSet({ tenantId, scope: "global", name, value: `remote-${name}`, updatedAt });
  }
  store.envSet({ tenantId, scope: "global", name: "API_KEY", value: "safe-key", updatedAt });

  const proj = await tc.call("project.create", { name: "danger-filter", git: false }) as { project: { projectId: string } };
  const created = await tc.call("session.create", { project: proj.project.projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
  const ack = await tc.call("session.send", { sessionId: created.sessionId, input: "hi" }) as { turnId: string };
  await tc.waitTurnEnd(ack.turnId);
  assert.equal(adapter.lastSession?.lastEnvironment?.NODE_OPTIONS, undefined);
  assert.equal(adapter.lastSession?.lastEnvironment?.LD_PRELOAD, undefined);
  assert.equal(adapter.lastSession?.lastEnvironment?.PATH, undefined);
  assert.equal(adapter.lastSession?.lastEnvironment?.HOME, undefined);
  assert.equal(adapter.lastSession?.lastEnvironment?.API_KEY, "safe-key");
});

test("dangerous env matching is case-insensitive on Windows", () => {
  assert.equal(isDangerousChildEnvName("node_options", "win32"), true);
  assert.equal(isDangerousChildEnvName("ld_preload", "win32"), true);
  assert.equal(isDangerousChildEnvName("DyLd_Insert_Libraries", "win32"), true);
  assert.equal(isDangerousChildEnvName("node_options", "linux"), false);
  assert.equal(isDangerousChildEnvName("GIT_CONFIG_COUNT"), true);
  assert.equal(isDangerousChildEnvName("GIT_CONFIG_KEY_0"), true);
  assert.equal(isDangerousChildEnvName("GIT_EXEC_PATH"), true);
  assert.equal(isDangerousChildEnvName("userprofile", "win32"), true);
});

test("child environment sanitizer preserves device PATH/HOME and blocks remote replacements", () => {
  const inherited: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_OPTIONS: "--inspect=127.0.0.1:0",
    LD_PRELOAD: "/device/untrusted.so",
  };
  const env = buildChildProcessEnvironment({
    PATH: "/remote/bin",
    HOME: "/remote/home",
    NODE_OPTIONS: "--definitely-invalid-node-option",
    LD_PRELOAD: "/remote/evil.so",
    API_KEY: "ordinary-key",
  }, inherited);
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({PATH:process.env.PATH,HOME:process.env.HOME,NODE_OPTIONS:process.env.NODE_OPTIONS,LD_PRELOAD:process.env.LD_PRELOAD,API_KEY:process.env.API_KEY}))"], {
    encoding: "utf8",
    env,
  });
  assert.equal(child.status, 0, child.stderr);
  const actual = JSON.parse(child.stdout) as Record<string, string | undefined>;
  assert.equal(actual.PATH, inherited.PATH);
  assert.equal(actual.HOME, inherited.HOME);
  assert.equal(actual.NODE_OPTIONS, undefined);
  assert.equal(actual.LD_PRELOAD, undefined);
  assert.equal(actual.API_KEY, "ordinary-key");
});

test("tenant A cannot list, reveal, delete, or inject tenant B env", async () => {
  const store = new PhononStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "phonon-env-tenants-"));
  const policy = { allowEnvWrite: true, allowEnvReveal: true };
  const a = setup({ tenantId: "tenant-a", store, workspaceRoot: root, policy });
  const b = setup({ tenantId: "tenant-b", store, workspaceRoot: root, policy });

  await a.tc.call("env.set", { scope: "global", name: "TENANT_SECRET", value: "a-only" });
  assert.deepEqual(await b.tc.call("env.list", {}), { variables: [] });
  assert.deepEqual(await b.tc.call("env.list", { reveal: true }), { variables: [] });
  await b.tc.call("env.set", { scope: "global", name: "TENANT_SECRET", value: "b-only" });
  const bVisible = await b.tc.call("env.list", { reveal: true }) as { variables: Array<{ name: string; value?: string }> };
  assert.equal(bVisible.variables.find((v) => v.name === "TENANT_SECRET")?.value, "b-only");
  await b.tc.call("env.delete", { scope: "global", name: "TENANT_SECRET" });
  const aVisible = await a.tc.call("env.list", { reveal: true }) as { variables: Array<{ name: string; value?: string }> };
  assert.equal(aVisible.variables.find((v) => v.name === "TENANT_SECRET")?.value, "a-only");

  const project = await a.tc.call("project.create", { name: "tenant-project", git: false }) as { project: { projectId: string } };
  const bSession = await b.tc.call("session.create", { project: project.project.projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
  const bTurn = await b.tc.call("session.send", { sessionId: bSession.sessionId, input: "hi" }) as { turnId: string };
  await b.tc.waitTurnEnd(bTurn.turnId);
  assert.equal(b.adapter.lastSession?.lastEnvironment?.TENANT_SECRET, undefined);

  const aSession = await a.tc.call("session.create", { project: project.project.projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
  const aTurn = await a.tc.call("session.send", { sessionId: aSession.sessionId, input: "hi" }) as { turnId: string };
  await a.tc.waitTurnEnd(aTurn.turnId);
  assert.equal(a.adapter.lastSession?.lastEnvironment?.TENANT_SECRET, "a-only");
});

test("legacy NULL-tenant rows remain invisible to remote list/delete/injection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-env-legacy-"));
  const dbPath = join(dir, "phonon.db");
  const store = new PhononStore(dbPath);
  const raw = new DatabaseSync(dbPath);
  raw.prepare("INSERT INTO env_vars(tenant_id,scope,project_id,agent_id,skill_name,name,value,secret,updated_at) VALUES(NULL,'global',NULL,NULL,NULL,'LEGACY_SECRET','legacy-value',1,?)")
    .run(new Date().toISOString());
  raw.close();

  const { tc, adapter } = setup({ tenantId: "tenant-new", store, policy: { allowEnvWrite: true, allowEnvReveal: true } });
  assert.deepEqual(await tc.call("env.list", { reveal: true }), { variables: [] });
  await tc.call("env.delete", { scope: "global", name: "LEGACY_SECRET" });
  const project = await tc.call("project.create", { name: "legacy-project", git: false }) as { project: { projectId: string } };
  const session = await tc.call("session.create", { project: project.project.projectId, agent: "mock:default", model: "m1" }) as { sessionId: string };
  const turn = await tc.call("session.send", { sessionId: session.sessionId, input: "hi" }) as { turnId: string };
  await tc.waitTurnEnd(turn.turnId);
  assert.equal(adapter.lastSession?.lastEnvironment?.LEGACY_SECRET, undefined);

  const verify = new DatabaseSync(dbPath);
  const row = verify.prepare("SELECT tenant_id FROM env_vars WHERE name='LEGACY_SECRET'").get() as { tenant_id: string | null };
  assert.equal(row.tenant_id, null);
  verify.close();
});
