import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  METHOD_NAMES,
  METHODS,
  parseParams,
  parseResult,
  StreamEvent,
  HookFiredParams,
  HookResolveParams,
  JsonRpcError,
  JSON_RPC_CODES,
} from "../index.js";

test("protocol version present", () => {
  assert.equal(typeof PROTOCOL_VERSION, "string");
});

test("method registry has all expected methods", () => {
  assert.ok(METHOD_NAMES.includes("session.create"));
  assert.ok(METHOD_NAMES.includes("discovery.list"));
  assert.ok(METHOD_NAMES.includes("stream.event"));
  assert.ok(METHOD_NAMES.includes("hook.fired"));
});

test("session.create binds agent + model (D15)", () => {
  const p = parseParams("session.create", { project: "proj1", agent: "openclaw", model: "claude-opus-4.8" });
  assert.equal(p.project, "proj1");
  assert.equal(p.agent, "openclaw");
  assert.equal(p.model, "claude-opus-4.8");
  assert.equal(p.verbosity, "messages"); // default
});

test("session.create without agent is rejected", () => {
  assert.throws(() => parseParams("session.create", { project: "p", model: "m" }));
});

test("session.create without model is rejected", () => {
  assert.throws(() => parseParams("session.create", { project: "p", agent: "openclaw" }));
});

test("session.create without project is rejected (D23)", () => {
  assert.throws(() => parseParams("session.create", { agent: "openclaw", model: "m" }));
});

test("discovery.list round-trips with capabilities", () => {
  const r = parseResult("discovery.list", {
    agents: [
      {
        agentId: "openclaw",
        displayName: "OpenClaw",
        adapter: "openclaw",
        available: true,
        models: [{ id: "claude-opus-4.8", available: true }],
        capabilities: {
          nativeSession: true,
          nativeCompression: true,
          contextInjection: true,
          proactiveOutput: true,
          modelSwitch: true,
          interrupt: true,
          injectMidTurn: true,
          skillManagement: true,
          hooks: ["pre_tool"],
          streaming: true,
        },
      },
    ],
  });
  assert.equal(r.agents[0]!.capabilities.nativeCompression, true);
});

test("stream event discriminated union", () => {
  const ev = StreamEvent.parse({
    type: "result",
    sessionId: "s1",
    turnId: "t1",
    seq: 1,
    at: new Date().toISOString(),
    text: "done",
    final: true,
  });
  assert.equal(ev.type, "result");
  assert.equal(ev.origin, "solicited"); // default
});

test("unsolicited stream event (OpenClaw cron self-output)", () => {
  const ev = StreamEvent.parse({
    type: "message",
    sessionId: "s1",
    turnId: "auto-1",
    origin: "unsolicited",
    source: "cron",
    seq: 7,
    at: new Date().toISOString(),
    text: "定时任务触发：每日巡检完成",
  });
  assert.equal(ev.origin, "unsolicited");
  assert.equal(ev.source, "cron");
});

test("hook fired/resolve pairing", () => {
  const f = HookFiredParams.parse({
    sessionId: "s1",
    hookId: "h1",
    hookType: "pre_command",
    payload: { command: "rm -rf /" },
    at: new Date().toISOString(),
  });
  assert.equal(f.hookType, "pre_command");
  const r = HookResolveParams.parse({ sessionId: "s1", hookId: "h1", action: "abort" });
  assert.equal(r.action, "abort");
});

test("jsonrpc error carries appCode", () => {
  const e = JsonRpcError.parse({
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: JSON_RPC_CODES.applicationError,
      message: "cross tenant",
      data: { appCode: "errSessionNotInTenant" },
    },
  });
  assert.equal(e.error.data!.appCode, "errSessionNotInTenant");
});

test("method directions are correct", () => {
  assert.equal(METHODS["session.create"].direction, "s2p");
  assert.equal(METHODS["session.switchModel"].direction, "s2p");
  assert.equal(METHODS["stream.event"].direction, "p2s");
  assert.equal(METHODS["stream.event"].kind, "notification");
  assert.equal(METHODS["hook.fired"].direction, "p2s");
  assert.equal(METHODS["hook.fired"].kind, "request");
});

test("session.switchModel round-trips (D16)", () => {
  const p = parseParams("session.switchModel", { sessionId: "s1", model: "gpt-5.5" });
  assert.equal(p.model, "gpt-5.5");
  const r = parseResult("session.switchModel", {
    sessionId: "s1",
    previousModel: "claude-opus-4.8",
    model: "gpt-5.5",
  });
  assert.equal(r.previousModel, "claude-opus-4.8");
});

test("session.send whenBusy defaults to queue (D18)", () => {
  const p = parseParams("session.send", { sessionId: "s1", input: "hi" });
  assert.equal(p.whenBusy, "queue");
});

test("session.send whenBusy modes (D18)", () => {
  for (const m of ["queue", "interrupt", "inject"]) {
    const p = parseParams("session.send", { sessionId: "s1", input: "x", whenBusy: m });
    assert.equal(p.whenBusy, m);
  }
  assert.throws(() => parseParams("session.send", { sessionId: "s1", input: "x", whenBusy: "bogus" }));
});

test("session.send ack disposition (D18)", () => {
  const ack = parseResult("session.send", {
    sessionId: "s1",
    turnId: "t1",
    accepted: true,
    disposition: "queued",
    queuePosition: 2,
  });
  assert.equal(ack.disposition, "queued");
  assert.equal(ack.queuePosition, 2);
});

test("session.interrupt (D18) keeps session alive", () => {
  const p = parseParams("session.interrupt", { sessionId: "s1", reason: "new msg" });
  assert.equal(p.sessionId, "s1");
  const r = parseResult("session.interrupt", {
    sessionId: "s1",
    interruptedTurnId: "t1",
    status: "idle",
  });
  assert.equal(r.status, "idle"); // 停一下回空闲，不是 terminated
});

test("session status enum: idle/running/paused/terminated (D19)", () => {
  const meta = parseResult("session.status", {
    sessionId: "s1",
    project: "proj1",
    agent: "openclaw",
    model: "claude-opus-4.8",
    status: "running",
    currentTurnId: "t9",
    verbosity: "messages",
    createdAt: new Date().toISOString(),
  });
  assert.equal(meta.status, "running");
  assert.equal(meta.project, "proj1");
  assert.equal(meta.currentTurnId, "t9");
  // 旧的 active 已废弃
  assert.throws(() =>
    parseResult("session.status", {
      sessionId: "s1", project: "p", agent: "x", model: "m", status: "active",
      verbosity: "messages", createdAt: new Date().toISOString(),
    }),
  );
});

test("project.create (D23) — dir + git", () => {
  const p = parseParams("project.create", { name: "agent-phonon", git: true });
  assert.equal(p.name, "agent-phonon");
  assert.equal(p.git, true);
  assert.equal(METHODS["project.create"].direction, "s2p");
});

test("project.remove defaults to NOT deleting files (D23 safety)", () => {
  const p = parseParams("project.remove", { projectId: "proj1" });
  assert.equal(p.deleteFiles, false);
});

test("skill.install global vs project scope (D24)", () => {
  const g = parseParams("skill.install", {
    agent: "openclaw", name: "my-skill", scope: "global",
    source: { kind: "inline", files: { "SKILL.md": "# hi" } },
  });
  assert.equal(g.scope, "global");
  // project scope requires projectId
  assert.throws(() => parseParams("skill.install", {
    agent: "openclaw", name: "x", scope: "project",
    source: { kind: "localPath", path: "/tmp/x" },
  }));
  const ok = parseParams("skill.install", {
    agent: "openclaw", name: "x", scope: "project", projectId: "proj1",
    source: { kind: "localPath", path: "/tmp/x" },
  });
  assert.equal(ok.projectId, "proj1");
});

test("worktree create from branch (D25)", () => {
  const p = parseParams("project.worktree.create", {
    projectId: "proj1", baseBranch: "main", newBranch: "feat/x",
  });
  assert.equal(p.baseBranch, "main");
  assert.equal(p.newBranch, "feat/x");
  assert.equal(METHODS["project.worktree.create"].direction, "s2p");
});

test("worktree remove + branch delete default safe (D25)", () => {
  const w = parseParams("project.worktree.remove", { projectId: "p", worktreeId: "wt1" });
  assert.equal(w.force, false); // 默认不强制
  const b = parseParams("project.git.deleteBranch", { projectId: "p", branch: "feat/x" });
  assert.equal(b.force, false); // 默认只删已合并
});

test("session.send can specify skills at execution time (D26)", () => {
  const p = parseParams("session.send", {
    sessionId: "s1", input: "用 X 技能处理", skills: ["wechat-publisher"],
  });
  assert.deepEqual(p.skills, ["wechat-publisher"]);
  // 不传 skills 也合法
  const p2 = parseParams("session.send", { sessionId: "s1", input: "hi" });
  assert.equal(p2.skills, undefined);
});

test("session.create can bind a worktree (D25)", () => {
  const p = parseParams("session.create", {
    project: "proj1", worktreeId: "wt1", agent: "openclaw", model: "m",
  });
  assert.equal(p.worktreeId, "wt1");
});

test("document.send (D20) — phonon uploads after reading local file", () => {
  const p = parseParams("document.send", {
    documents: [
      { name: "report.md", kind: "document", content: { encoding: "utf8", data: "# hi" } },
    ],
    at: new Date().toISOString(),
  });
  assert.equal(p.documents[0]!.name, "report.md");
  assert.equal(METHODS["document.send"].direction, "p2s");
});

test("interaction.request (D21) — abstract form, server renders", () => {
  const p = parseParams("interaction.request", {
    requestId: "r1",
    form: {
      title: "选个风格",
      fields: [
        { key: "style", label: "风格", type: "select", required: true,
          options: [{ label: "写实", value: "real" }, { label: "动画", value: "anime" }] },
      ],
      submitLabel: "确认",
    },
    blocking: true,
    at: new Date().toISOString(),
  });
  assert.equal(p.form.fields[0]!.type, "select");
  const r = parseResult("interaction.request", {
    requestId: "r1", action: "submit", values: { style: "anime" },
  });
  assert.equal(r.values!.style, "anime");
  assert.equal(METHODS["interaction.request"].direction, "p2s");
});

// ============ P0-1: 本地 policy（D27）============
import { TenantPolicy, DEFAULT_TENANT_POLICY, isPathUnderRoots } from "../index.js";

test("P0-1 default policy is strictest (writes off, whitelists empty)", () => {
  assert.equal(DEFAULT_TENANT_POLICY.allowDeleteFiles, false);
  assert.equal(DEFAULT_TENANT_POLICY.allowUrlSkillInstall, false);
  assert.equal(DEFAULT_TENANT_POLICY.allowExternalDocuments, false);
  assert.equal(DEFAULT_TENANT_POLICY.allowGlobalSkillInstall, false);
  assert.ok(DEFAULT_TENANT_POLICY.denyPathPatterns.length > 0);
});

test("P0-1 isPathUnderRoots", () => {
  assert.equal(isPathUnderRoots("/home/u/proj/a.md", ["/home/u/proj"]), true);
  assert.equal(isPathUnderRoots("/home/u/secret/.ssh/id_rsa", ["/home/u/proj"]), false);
  assert.equal(isPathUnderRoots("/anything", []), false); // 空白名单 = 全拒
});

test("P0-1 policy parse fills defaults", () => {
  const p = TenantPolicy.parse({ allowedProjectRoots: ["/work"], allowDeleteFiles: true });
  assert.deepEqual(p.allowedProjectRoots, ["/work"]);
  assert.equal(p.allowDeleteFiles, true);
  assert.equal(p.allowUrlSkillInstall, false); // 未指定仍默认严格
});

// ============ P0-2: turn 终态事件 ============
test("P0-2 result event carries terminal status (default completed)", () => {
  const ev = StreamEvent.parse({
    type: "result", sessionId: "s1", turnId: "t1", seq: 5,
    at: new Date().toISOString(), text: "done", final: true,
  });
  assert.equal(ev.type === "result" && ev.status, "completed");
});

test("P0-2 interrupted turn emits result status=interrupted", () => {
  const ev = StreamEvent.parse({
    type: "result", sessionId: "s1", turnId: "t1", seq: 9,
    at: new Date().toISOString(), text: "", final: true, status: "interrupted",
  });
  assert.equal(ev.type === "result" && ev.status, "interrupted");
});

test("P0-2 error event carries terminal status", () => {
  const ev = StreamEvent.parse({
    type: "error", sessionId: "s1", turnId: "t1", seq: 3,
    at: new Date().toISOString(), message: "boom", final: true, status: "failed",
  });
  assert.equal(ev.type === "error" && ev.status, "failed");
});

// ============ P0-3: clientRequestId 幂等 ============
test("P0-3 session.send accepts clientRequestId", () => {
  const p = parseParams("session.send", { sessionId: "s1", input: "hi", clientRequestId: "req-1" });
  assert.equal(p.clientRequestId, "req-1");
});

test("P0-3 mutating creates accept clientRequestId", () => {
  const a = parseParams("session.create", { clientRequestId: "r1", project: "p", agent: "openclaw", model: "m" });
  assert.equal(a.clientRequestId, "r1");
  const b = parseParams("project.create", { clientRequestId: "r2", name: "x" });
  assert.equal(b.clientRequestId, "r2");
  const c = parseParams("project.worktree.create", { clientRequestId: "r3", projectId: "p", baseBranch: "main" });
  assert.equal(c.clientRequestId, "r3");
});

// ============ P0-4: stream.ack + reconnect resume ============
test("P0-4 stream.ack carries lastSeq", () => {
  const p = parseParams("stream.ack", { sessionId: "s1", lastSeq: 42 });
  assert.equal(p.lastSeq, 42);
  assert.equal(METHODS["stream.ack"].direction, "s2p");
  assert.equal(METHODS["stream.ack"].kind, "notification");
});

test("P0-4 connect.hello carries resumeFrom; welcome carries ackedSeqs", () => {
  const hello = parseParams("connect.hello", {
    protocolVersion: "0.1.0", deviceId: "dev1", at: new Date().toISOString(),
    resumeFrom: [{ sessionId: "s1", fromSeq: 10 }],
  });
  assert.equal(hello.resumeFrom![0]!.fromSeq, 10);
  const welcome = parseResult("connect.hello", {
    protocolVersion: "0.1.0", tenantId: "t1", at: new Date().toISOString(),
    ackedSeqs: [{ sessionId: "s1", lastSeq: 9 }],
  });
  assert.equal(welcome.ackedSeqs![0]!.lastSeq, 9);
});

// ============ P1-11 + P1-8 ============
test("P1-11 session.send fallback", () => {
  const p = parseParams("session.send", { sessionId: "s1", input: "x", whenBusy: "inject", fallback: "queue" });
  assert.equal(p.fallback, "queue");
});

test("P1-8 switchModel whenRunning default reject + warnings", () => {
  const p = parseParams("session.switchModel", { sessionId: "s1", model: "gpt-5.5" });
  assert.equal(p.whenRunning, "reject");
  const r = parseResult("session.switchModel", {
    sessionId: "s1", previousModel: "claude-opus-4.8", model: "gpt-5.5",
    warnings: ["tool schema may differ"], deferred: false,
  });
  assert.deepEqual(r.warnings, ["tool schema may differ"]);
});

// ============ P1-7 + P1-10 + Minimax#5 ============
test("P1-7 worktree.remove returns affectedSessions on force", () => {
  const p = parseParams("project.worktree.remove", { projectId: "p", worktreeId: "wt1", force: true });
  assert.equal(p.force, true);
  const r = parseResult("project.worktree.remove", { worktreeId: "wt1", removed: true, affectedSessions: ["s1"] });
  assert.deepEqual(r.affectedSessions, ["s1"]);
});

test("P1-7 deleteBranch returns affectedWorktrees", () => {
  const r = parseResult("project.git.deleteBranch", { branch: "feat/x", deleted: true, affectedWorktrees: ["wt2"] });
  assert.deepEqual(r.affectedWorktrees, ["wt2"]);
});

test("P1-10 terminate cleanWorktree", () => {
  const p = parseParams("session.terminate", { sessionId: "s1", cleanWorktree: true });
  assert.equal(p.cleanWorktree, true);
});

test("Minimax#5 project.remove whenActiveSessions default reject", () => {
  const p = parseParams("project.remove", { projectId: "p" });
  assert.equal(p.whenActiveSessions, "reject");
  assert.equal(p.deleteFiles, false);
});

// ============ P1-5: interaction lifecycle ============
test("P1-5 interaction.request timeout + status", () => {
  const p = parseParams("interaction.request", {
    requestId: "r1", form: { title: "fill", fields: [], submitLabel: "ok" },
    blocking: true, timeoutSeconds: 3600, at: new Date().toISOString(),
  });
  assert.equal(p.timeoutSeconds, 3600);
  const r = parseResult("interaction.request", { requestId: "r1", action: "timeout" });
  assert.equal(r.action, "timeout");
});

test("P1-5 interaction.cancel", () => {
  const p = parseParams("interaction.cancel", { requestId: "r1", reason: "superseded" });
  assert.equal(p.requestId, "r1");
  assert.equal(METHODS["interaction.cancel"].direction, "s2p");
});

// ============ P1-6: 大文件凭证上传 ============
test("P1-6 document.prepare_upload", () => {
  const p = parseParams("document.prepare_upload", {
    filename: "big.pdf", sizeBytes: 52428800, mimeType: "application/pdf",
    sha256: "abc", at: new Date().toISOString(),
  });
  assert.equal(p.sizeBytes, 52428800);
  const r = parseResult("document.prepare_upload", {
    uploadRef: "u1", uploadUrl: "https://s3/upload", method: "PUT",
  });
  assert.equal(r.uploadRef, "u1");
  assert.equal(METHODS["document.prepare_upload"].direction, "p2s");
});

// ============ P2-14 + P2-13 ============
test("P2-14 session.list pagination", () => {
  const p = parseParams("session.list", { limit: 50, cursor: "c1" });
  assert.equal(p.limit, 50);
  const r = parseResult("session.list", { sessions: [], nextCursor: "c2" });
  assert.equal(r.nextCursor, "c2");
});

test("P2-13 capabilities.limits optional", () => {
  const r = parseResult("discovery.get", {
    agent: {
      agentId: "openclaw", displayName: "OpenClaw", adapter: "openclaw", available: true,
      models: [{ id: "m", available: true }],
      capabilities: {
        nativeSession: true, nativeCompression: true, contextInjection: true,
        proactiveOutput: true, modelSwitch: true, interrupt: true, injectMidTurn: true,
        skillManagement: true, hooks: [], streaming: true,
        limits: { maxConcurrentSessions: 8, maxContextTokens: 1048576 },
      },
    },
  });
  assert.equal(r.agent.capabilities.limits!.maxConcurrentSessions, 8);
});

// ============ P2-16 + P2-12 + P2-15 ============
test("P2-16 FormField discriminated union by type", () => {
  // select 用 string default
  const sel = parseParams("interaction.request", {
    requestId: "r", at: new Date().toISOString(),
    form: { title: "t", submitLabel: "ok", fields: [
      { key: "s", label: "S", type: "select", options: [{label:"A",value:"a"}], defaultValue: "a" },
    ]},
  });
  assert.equal(sel.form.fields[0]!.type, "select");
  // multiselect 用 string[] default
  const ms = parseParams("interaction.request", {
    requestId: "r2", at: new Date().toISOString(),
    form: { title: "t", submitLabel: "ok", fields: [
      { key: "m", label: "M", type: "multiselect", options: [{label:"A",value:"a"}], defaultValue: ["a"] },
    ]},
  });
  assert.deepEqual((ms.form.fields[0] as any).defaultValue, ["a"]);
  // select 传 string[] 应失败（类型不符）
  assert.throws(() => parseParams("interaction.request", {
    requestId: "r3", at: new Date().toISOString(),
    form: { title: "t", submitLabel: "ok", fields: [
      { key: "s", label: "S", type: "number", defaultValue: "not-a-number" },
    ]},
  }));
});

test("P2-12 skill version/hash + structured send.skills", () => {
  const inst = parseParams("skill.install", {
    agent: "openclaw", name: "x", scope: "global",
    source: { kind: "url", url: "https://x/skill.zip", sha256: "deadbeef" },
  });
  assert.equal((inst.source as any).sha256, "deadbeef");
  // session.send skills 支持 name 或结构体
  const s1 = parseParams("session.send", { sessionId: "s", input: "x", skills: ["feishu-doc"] });
  assert.equal(s1.skills![0], "feishu-doc");
  const s2 = parseParams("session.send", { sessionId: "s", input: "x",
    skills: [{ name: "feishu-doc", version: "1.2.0", scope: "project", force: true }] });
  assert.equal((s2.skills![0] as any).version, "1.2.0");
});
