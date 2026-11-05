import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry, OpenClawAdapter, OpenClawGatewayAdapter, PhononStore, GatewayClient } from "@agent-phonon/core";
import { METHODS, OpenClawScheduleListResult, OpenClawScheduleGetResult } from "@agent-phonon/protocol";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { TestConn } from "./harness.js";

const nativeJob = {
  id: "vendor-job", displayName: "Native reminder", enabled: false, agentId: "main",
  effectiveAgentId: "main", declarationKey: "reminder",
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai", staggerMs: 200 },
  sessionTarget: "isolated", sessionKey: "agent:main:cron:vendor-job", wakeMode: "now",
  payload: { kind: "agentTurn", message: "PRIVATE_PROMPT", token: "PAYLOAD_SECRET" },
  delivery: { mode: "announce", channel: "feishu", to: "ou_opaque_target", password: "DELIVERY_SECRET" },
  state: { nextRunAtMs: 10000, lastRunAtMs: 9000, lastRunStatus: "error", lastDeliveryStatus: "not-delivered",
    lastDelivered: false, lastFailureNotificationDeliveryStatus: "delivered", consecutiveErrors: 2,
    lastError: "timeout token=NATIVE_SECRET", ignored: "STATE_SECRET" },
  gateway: { token: "GATEWAY_SECRET" },
};

function rpcError(code: string, message?: RegExp) {
  return (error: unknown) => {
    const response = error as { data?: { appCode: string }; message: string };
    assert.equal(response.data?.appCode, code);
    if (message) assert.match(response.message, message);
    assert.doesNotMatch(JSON.stringify(error), /TRANSPORT_SECRET/);
    return true;
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "phonon-openclaw-schedules-"));
  const store = new PhononStore(join(root, "state.db"));
  const adapter = new OpenClawGatewayAdapter({ gateway: { baseUrl: "ws://127.0.0.1:1", token: "synthetic" } });
  adapter.discoverAgents = async () => []; // No inference, session, or unrelated native probing.
  const calls: Array<{ method: string; params: unknown }> = [];
  const gateway = (adapter as unknown as { gw: GatewayClient }).gw;
  let response: unknown = { jobs: [nativeJob] }, failure: Error | undefined, connectFailure = false;
  gateway.connect = async () => { if (connectFailure) throw new Error("password=TRANSPORT_SECRET"); };
  gateway.rpc = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, "cron.list", "Only the vendor list read is allowed");
    assert.deepEqual(params, { includeDisabled: true });
    if (failure) throw failure;
    return response as Record<string, unknown>;
  };
  const registry = new AdapterRegistry(); registry.register(adapter);
  const connections: TestConn[] = [];
  const actor = (policy?: ConstructorParameters<typeof TestConn>[0]["policy"]) => {
    const conn = new TestConn({ registry, store, workspaceRoot: root, tenantId: "owner", policy });
    connections.push(conn); return conn;
  };
  return { calls, registry, adapter, actor,
    respond(value: unknown) { response = value; }, fail(message: string) { failure = new Error(message); },
    disconnect() { connectFailure = true; },
    async close() {
      for (const conn of connections) await conn.conn.dispose();
      adapter.close(); store.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}

test("OpenClaw list/get normalize trigger, binding and receipt without vendor writes or L4 jobs", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    const listed = OpenClawScheduleListResult.parse(await conn.call("openclaw.schedule.list", {}));
    assert.equal(listed.schedules.length, 1);
    const job = listed.schedules[0]!;
    assert.deepEqual(job.trigger, nativeJob.schedule);
    assert.equal(job.id, nativeJob.id); assert.equal(job.name, nativeJob.displayName); assert.equal(job.enabled, false);
    assert.equal(job.agentId, "main"); assert.equal(job.effectiveAgentId, "main");
    assert.deepEqual(job.session, { sessionTarget: "isolated", sessionKey: nativeJob.sessionKey, wakeMode: "now", payloadKind: "agentTurn" });
    assert.deepEqual(job.delivery, { mode: "announce", channel: "feishu", to: "ou_opaque_target",
      lastDeliveryStatus: "not-delivered", lastDelivered: false, lastFailureNotificationDeliveryStatus: "delivered" });
    assert.equal(job.state.lastError, "timeout token=[redacted]");
    assert.equal(job.state.nextRunAtMs, 10000); assert.equal(job.state.lastRunAtMs, 9000);
    assert.equal(job.state.lastRunStatus, "error"); assert.equal(job.state.consecutiveErrors, 2);
    assert.doesNotMatch(JSON.stringify(listed), /PRIVATE_PROMPT|SECRET|password|ignored/);
    const detail = OpenClawScheduleGetResult.parse(await conn.call("openclaw.schedule.get", { id: nativeJob.id }));
    assert.deepEqual(detail.schedule, job);
    const info = await conn.call("device.info", {}) as { capabilities: string[] };
    assert.ok(info.capabilities.includes("openclaw_schedule_discover_v1"));
    await assert.rejects(() => conn.call("openclaw.schedule.get", { id: "missing" }), rpcError("errInvalidParams", /not found or not permitted/));
    assert.deepEqual(await conn.call("schedule.list", {}), { schedules: [] });
    f.respond({ jobs: [] });
    assert.deepEqual(await conn.call("openclaw.schedule.list", {}), { schedules: [] });
    assert.ok((await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    assert.ok(f.calls.length >= 5); assert.ok(f.calls.every(call => call.method === "cron.list"));
    assert.deepEqual(Object.keys(METHODS).filter(method => method.startsWith("openclaw.schedule.")), ["openclaw.schedule.list", "openclaw.schedule.get"]);
  } finally { await f.close(); }
});

test("OpenClaw normalizes interval/at, unknown trigger kinds and nullable optional vendor fields", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    for (const trigger of [{ kind: "every", everyMs: 60000, anchorMs: 500 }, { kind: "at", at: "2026-11-06T00:00:00Z" }, { kind: "vendor-future" }]) {
      f.respond([{ id: "interval", enabled: true, schedule: trigger, state: { lastError: null }, delivery: null, agentId: null }]);
      const { schedules } = OpenClawScheduleListResult.parse(await conn.call("openclaw.schedule.list", {}));
      assert.deepEqual(schedules[0]!.trigger, trigger);
      assert.deepEqual(schedules[0]!.delivery, {}); assert.deepEqual(schedules[0]!.state, {});
      assert.deepEqual(schedules[0]!.session, {}); assert.equal(schedules[0]!.agentId, undefined);
    }
    f.respond({ jobs: [{ ...nativeJob, delivery: { mode: "webhook", to: "https://user:password@example.test/hook?token=target_secret" } }] });
    const result = await conn.call("openclaw.schedule.list", {});
    assert.doesNotMatch(JSON.stringify(result), /user:password|target_secret/);
    f.respond({ jobs: [{ ...nativeJob, id: "token=opaque-id", state: { lastError: '{"token":"private_credential"} Bearer bearer_credential' } }] });
    const detail = OpenClawScheduleGetResult.parse(await conn.call("openclaw.schedule.get", { id: "token=opaque-id" }));
    assert.equal(detail.schedule.id, "token=opaque-id");
    assert.doesNotMatch(JSON.stringify(detail), /private_credential|bearer_credential/);
  } finally { await f.close(); }
});

const credentialCases = [
  { label: "fully double-quoted value", input: 'password="alpha"',
    expected: 'password="[redacted]"', secrets: /alpha/ },
  { label: "fully single-quoted value", input: "password='alpha'",
    expected: "password='[redacted]'", secrets: /alpha/ },
  { label: "HOLD leading quoted whitespace", input: 'reminder password=" alpha"',
    expected: 'reminder password="[redacted]"', secrets: /alpha/ },
  { label: "HOLD internal quoted whitespace", input: 'failed password="alpha beta gamma"',
    expected: 'failed password="[redacted]"', secrets: /alpha|beta|gamma/ },
  { label: "HOLD escaped double quote", input: String.raw`password="SUPER\"SECRET"`,
    expected: 'password="[redacted]"', secrets: /SUPER|SECRET/ },
  { label: "HOLD Basic authorization", input: "Authorization: Basic dXNlcjpwYXNz",
    expected: "Authorization: Basic [redacted]", secrets: /dXNlcjpwYXNz/ },
  { label: "single quotes and whitespace", input: String.raw`secret=' alpha \'SECRET\' beta '`,
    expected: "secret='[redacted]'", secrets: /alpha|SECRET|beta/ },
  { label: "escaped backslash and common escapes", input: String.raw`api_key="ALPHA\\\t\n\r\"SECRET"`,
    expected: 'api_key="[redacted]"', secrets: /ALPHA|SECRET/ },
  { label: "multiple quoted assignments", input: String.raw`{"token":"ALPHA\"SECRET"} password='BETA VALUE'`,
    expected: '{"token":"[redacted]"} password=\'[redacted]\'', secrets: /ALPHA|SECRET|BETA|VALUE/ },
  { label: "unterminated quoted scalar", input: String.raw`password="ALPHA \"SECRET` + "\\",
    expected: 'password="[redacted]"', secrets: /ALPHA|SECRET/ },
  { label: "case-insensitive Basic with flexible whitespace", input: "authorization:\t bAsIc \t basic_credential",
    expected: "authorization:\t bAsIc \t [redacted]", secrets: /basic_credential/ },
  { label: "unquoted credential keys", input: "password=p_credential token=t_credential secret=s_credential api_key=ak_credential api-key=ah_credential",
    expected: "password=[redacted] token=[redacted] secret=[redacted] api_key=[redacted] api-key=[redacted]", secrets: /[a-z]+_credential/ },
  { label: "HOLD4 leading comma", input: "password=,FULL_PRIVATE",
    expected: "password=[redacted]", secrets: /FULL_PRIVATE/ },
  { label: "HOLD4 mid-value comma", input: "password=left,PRIVATE",
    expected: "password=[redacted]", secrets: /left|PRIVATE/ },
  { label: "HOLD4 mid-value semicolon", input: "password=left;PRIVATE",
    expected: "password=[redacted]", secrets: /left|PRIVATE/ },
  { label: "HOLD4 leading semicolon", input: "password=;FULL_PRIVATE",
    expected: "password=[redacted]", secrets: /FULL_PRIVATE/ },
  { label: "HOLD4 query parameter boundaries", input: "https://example.test?password=,FULL_PRIVATE&token=left;PRIVATE&keep=public",
    expected: "https://example.test?password=[redacted]&token=[redacted]&keep=public", secrets: /FULL_PRIVATE|left|PRIVATE/ },
  { label: "HOLD4 whitespace-separated assignments", input: "password=left,PRIVATE token=;FULL_PRIVATE keep=public",
    expected: "password=[redacted] token=[redacted] keep=public", secrets: /left|PRIVATE|FULL_PRIVATE/ },
  { label: "HOLD5 leading brace", input: "password=}FULL_PRIVATE",
    expected: "password=[redacted]", secrets: /FULL_PRIVATE/ },
  { label: "HOLD5 mid-value brace", input: "password=prefix}PRIVATE_SUFFIX",
    expected: "password=[redacted]", secrets: /prefix|PRIVATE_SUFFIX/ },
  { label: "HOLD5 query parameter boundaries", input: "https://example.test?password=}FULL_PRIVATE&token=prefix}PRIVATE_SUFFIX&keep=public",
    expected: "https://example.test?password=[redacted]&token=[redacted]&keep=public", secrets: /FULL_PRIVATE|prefix|PRIVATE_SUFFIX/ },
  { label: "HOLD5 whitespace-separated assignments", input: "password=prefix}PRIVATE_SUFFIX token=}FULL_PRIVATE keep=public",
    expected: "password=[redacted] token=[redacted] keep=public", secrets: /prefix|PRIVATE_SUFFIX|FULL_PRIVATE/ },
  { label: "HOLD6 mid-value single quote", input: "password=prefix'SECRET_SUFFIX",
    expected: "password=[redacted]", secrets: /prefix|SECRET_SUFFIX/ },
  { label: "HOLD6 mid-value double quote", input: 'password=prefix"SECRET_SUFFIX',
    expected: "password=[redacted]", secrets: /prefix|SECRET_SUFFIX/ },
  { label: "HOLD6 query parameter boundaries", input: `https://example.test?password=prefix'SECRET_SUFFIX&token=prefix"SECRET_SUFFIX&keep=public`,
    expected: "https://example.test?password=[redacted]&token=[redacted]&keep=public", secrets: /prefix|SECRET_SUFFIX/ },
  { label: "HOLD6 whitespace-separated assignments", input: `password=prefix'SECRET_SUFFIX token=prefix"SECRET_SUFFIX keep=public`,
    expected: "password=[redacted] token=[redacted] keep=public", secrets: /prefix|SECRET_SUFFIX/ },
  { label: "HOLD7 leading empty single-quote pair", input: "password=''PRIVATE_SUFFIX",
    expected: "password=[redacted]", secrets: /PRIVATE_SUFFIX/ },
  { label: "HOLD7 leading empty double-quote pair", input: 'password=""PRIVATE_SUFFIX',
    expected: "password=[redacted]", secrets: /PRIVATE_SUFFIX/ },
  { label: "HOLD7 mid-value empty single-quote pair", input: "password=prefix''PRIVATE_SUFFIX",
    expected: "password=[redacted]", secrets: /prefix|PRIVATE_SUFFIX/ },
  { label: "HOLD7 mid-value empty double-quote pair", input: 'password=prefix""PRIVATE_SUFFIX',
    expected: "password=[redacted]", secrets: /prefix|PRIVATE_SUFFIX/ },
  { label: "HOLD7 repeated leading empty quote pairs", input: `password=''""''PRIVATE_SUFFIX`,
    expected: "password=[redacted]", secrets: /PRIVATE_SUFFIX/ },
  { label: "HOLD7 query parameter boundaries", input: `https://example.test?password=''PRIVATE_SUFFIX&token=""PRIVATE_SUFFIX&keep=public`,
    expected: "https://example.test?password=[redacted]&token=[redacted]&keep=public", secrets: /PRIVATE_SUFFIX/ },
  { label: "HOLD7 whitespace-separated assignments", input: `password=''PRIVATE_SUFFIX token=""PRIVATE_SUFFIX keep=public`,
    expected: "password=[redacted] token=[redacted] keep=public", secrets: /PRIVATE_SUFFIX/ },
  { label: "HOLD8 empty single-quote pair before comma and next key", input: "password='',secret='PRIVATE SUFFIX'",
    expected: "password=[redacted],secret='[redacted]'", secrets: /PRIVATE|SUFFIX/ },
  { label: "HOLD8 empty double-quote pair before comma and next key", input: 'password="",secret="PRIVATE SUFFIX"',
    expected: 'password=[redacted],secret="[redacted]"', secrets: /PRIVATE|SUFFIX/ },
  { label: "HOLD8 empty token before API key", input: "token='',api_key='ALPHA BETA'",
    expected: "token=[redacted],api_key='[redacted]'", secrets: /ALPHA|BETA/ },
  { label: "HOLD8 empty pair immediately before next key", input: "password=''secret='LEAK ME'",
    expected: "password=[redacted]secret='[redacted]'", secrets: /LEAK|ME/ },
  { label: "HOLD8 semicolon and flexible next assignment", input: `password='';API-Key" : "ALPHA BETA"`,
    expected: `password=[redacted];API-Key" : "[redacted]"`, secrets: /ALPHA|BETA/ },
  { label: "HOLD8 brace before next key", input: "password=''}secret='PRIVATE SUFFIX'",
    expected: "password=[redacted]secret='[redacted]'", secrets: /PRIVATE|SUFFIX/ },
  { label: "HOLD8 repeated empty pairs before next key", input: `password=''""'';secret='PRIVATE SUFFIX'`,
    expected: "password=[redacted];secret='[redacted]'", secrets: /PRIVATE|SUFFIX/ },
  { label: "HOLD8 query parameter boundaries", input: "https://example.test?password='',secret='PRIVATE SUFFIX'&keep=public",
    expected: "https://example.test?password=[redacted],secret='[redacted]'&keep=public", secrets: /PRIVATE|SUFFIX/ },
  { label: "HOLD8 whitespace-separated assignments", input: "password='' secret='PRIVATE SUFFIX' keep=public",
    expected: "password=[redacted] secret='[redacted]' keep=public", secrets: /PRIVATE|SUFFIX/ },
  { label: "HOLD9 quoted next key with sticky suffix", input: "password=''secret='alpha'PRIVATE_SUFFIX",
    expected: "password=[redacted]secret='[redacted]'", secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "HOLD9 comma before quoted next key with sticky suffix", input: "password='',secret='alpha'PRIVATE_SUFFIX",
    expected: "password=[redacted],secret='[redacted]'", secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "HOLD9 quoted prefix before sticky suffix", input: "password=''secret='prefix'PRIVATE_SUFFIX",
    expected: "password=[redacted]secret='[redacted]'", secrets: /prefix|PRIVATE_SUFFIX/ },
  { label: "HOLD9 double-quoted next key with sticky suffix", input: 'password=""secret="alpha"PRIVATE_SUFFIX',
    expected: 'password=[redacted]secret="[redacted]"', secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "HOLD9 quoted API key with spaces and sticky suffix", input: "token='',api_key='ALPHA BETA'TRAIL_SECRET",
    expected: "token=[redacted],api_key='[redacted]'", secrets: /ALPHA|BETA|TRAIL_SECRET/ },
  { label: "HOLD9 query parameter boundaries", input: "https://example.test?password='',secret='alpha'PRIVATE_SUFFIX&keep=public",
    expected: "https://example.test?password=[redacted],secret='[redacted]'&keep=public", secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "HOLD9 whitespace-separated assignments", input: "password='' secret='alpha'PRIVATE_SUFFIX token=\"BETA\"TRAIL_SECRET keep=public",
    expected: "password=[redacted] secret='[redacted]' token=\"[redacted]\" keep=public", secrets: /alpha|PRIVATE_SUFFIX|BETA|TRAIL_SECRET/ },
  { label: "HOLD9 single-quoted value with sticky suffix", input: "secret='alpha'PRIVATE_SUFFIX",
    expected: "secret='[redacted]'", secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "HOLD9 double-quoted value with sticky suffix", input: 'secret="alpha"PRIVATE_SUFFIX',
    expected: 'secret="[redacted]"', secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "HOLD9 brace inside sticky suffix", input: "password=''secret='alpha'}PRIVATE_SUFFIX",
    expected: "password=[redacted]secret='[redacted]'", secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "HOLD9 sticky suffix before structural brace", input: '{"token":"alpha"PRIVATE_SUFFIX}',
    expected: '{"token":"[redacted]"}', secrets: /alpha|PRIVATE_SUFFIX/ },
  { label: "Bearer", input: "Bearer bearer_credential",
    expected: "Bearer [redacted]", secrets: /bearer_credential/ },
  { label: "URL userinfo", input: "https://user:pass@example.test/hook",
    expected: "https://[redacted]@example.test/hook", secrets: /user:pass/ },
  { label: "HOLD postgres URL userinfo", input: "postgres://user:db_secret@example.test/database",
    expected: "postgres://[redacted]@example.test/database", secrets: /db_secret/ },
  { label: "HOLD mysql URL userinfo", input: "mysql://user:mysql_secret@example.test/database",
    expected: "mysql://[redacted]@example.test/database", secrets: /mysql_secret/ },
  { label: "HOLD empty-user redis URL userinfo", input: "redis://:redis_secret@example.test:6379/0",
    expected: "redis://[redacted]@example.test:6379/0", secrets: /redis_secret/ },
  { label: "HOLD mongodb URL userinfo", input: "mongodb://user:mongo_secret@example.test/database",
    expected: "mongodb://[redacted]@example.test/database", secrets: /mongo_secret/ },
  { label: "HOLD ftp URL userinfo", input: "ftp://user:ftp_secret@example.test/file",
    expected: "ftp://[redacted]@example.test/file", secrets: /ftp_secret/ },
  { label: "file URL userinfo", input: "file://user:file_secret@example.test/share/file",
    expected: "file://[redacted]@example.test/share/file", secrets: /file_secret/ },
  { label: "generic scheme URL userinfo", input: "Custom+db.v1-test://:custom_secret@example.test/database",
    expected: "Custom+db.v1-test://[redacted]@example.test/database", secrets: /custom_secret/ },
  { label: "HOLD multi-@ https URL userinfo", input: "https://user:alpha@beta@example.test/path",
    expected: "https://[redacted]@example.test/path", secrets: /user:|alpha|beta/ },
  { label: "multi-@ postgres URL userinfo", input: "postgres://user:alpha@beta@example.test:5432/database",
    expected: "postgres://[redacted]@example.test:5432/database", secrets: /user:|alpha|beta/ },
  { label: "multi-@ username URL userinfo", input: "https://user@tenant:alpha@beta@example.test/path",
    expected: "https://[redacted]@example.test/path", secrets: /user|tenant|alpha|beta/ },
  { label: "credential URL authority boundaries", input: "https://user:uri_credential@example.test:443/path@segment?recipient=other@example.test#fragment@tail",
    expected: "https://[redacted]@example.test:443/path@segment?recipient=other@example.test#fragment@tail", secrets: /user:uri_credential/ },
];

for (const { label, input, expected, secrets } of credentialCases) {
  test(`OpenClaw list/get redact ${label} in name, lastError and delivery.to`, async () => {
    const f = fixture();
    try {
      const conn = f.actor();
      const id = "token=opaque-id", declarationKey = "token=opaque-declaration";
      f.respond({ jobs: [
        { ...nativeJob, id, declarationKey, name: input, state: { lastError: input },
          delivery: { ...nativeJob.delivery, to: input } },
        { ...nativeJob, id: "feishu-target" },
      ] });
      const listed = OpenClawScheduleListResult.parse(await conn.call("openclaw.schedule.list", {}));
      const detail = OpenClawScheduleGetResult.parse(await conn.call("openclaw.schedule.get", { id }));
      for (const result of [listed, detail]) assert.doesNotMatch(JSON.stringify(result), secrets);
      for (const job of [listed.schedules[0]!, detail.schedule]) {
        assert.equal(job.name, expected);
        assert.equal(job.state.lastError, expected);
        assert.equal(job.delivery.to, expected);
        assert.equal(job.id, id);
        assert.equal(job.declarationKey, declarationKey);
      }
      assert.equal(listed.schedules[1]!.delivery.to, "ou_opaque_target");
      const target = OpenClawScheduleGetResult.parse(await conn.call("openclaw.schedule.get", { id: "feishu-target" }));
      assert.equal(target.schedule.delivery.to, "ou_opaque_target");
    } finally { await f.close(); }
  });
}

for (const input of ["person@example.test", "ou_opaque_target", "https://user@example.test:443/path",
  "https://example.test/user:pass@segment", "https://example.test?recipient=user:pass@example.test",
  "https://example.test#user:pass@example.test"]) {
  test(`OpenClaw list/get preserve non-credential text ${input}`, async () => {
    const f = fixture();
    try {
      const conn = f.actor();
      f.respond({ jobs: [{ ...nativeJob, name: input, state: { lastError: input },
        delivery: { ...nativeJob.delivery, to: input } }] });
      const listed = OpenClawScheduleListResult.parse(await conn.call("openclaw.schedule.list", {}));
      const detail = OpenClawScheduleGetResult.parse(await conn.call("openclaw.schedule.get", { id: nativeJob.id }));
      for (const job of [listed.schedules[0]!, detail.schedule]) {
        assert.equal(job.name, input);
        assert.equal(job.state.lastError, input);
        assert.equal(job.delivery.to, input);
      }
    } finally { await f.close(); }
  });
}

for (const scheme of ["https", "http"]) {
  for (const method of ["list", "get"] as const) {
    for (const field of ["name", "lastError", "delivery.to"]) {
      test(`OpenClaw ${method} redacts HOLD empty-user ${scheme} URL password in ${field}`, async () => {
        const f = fixture();
        try {
          const conn = f.actor();
          const input = `${scheme}://:local_secret@example.test/request`;
          const expected = `${scheme}://[redacted]@example.test/request`;
          f.respond({ jobs: [{ ...nativeJob,
            ...(field === "name" ? { name: input }
              : field === "lastError" ? { state: { lastError: input } }
                : { delivery: { ...nativeJob.delivery, to: input } }),
          }] });
          const result = await conn.call(`openclaw.schedule.${method}`, method === "get" ? { id: nativeJob.id } : {});
          const job = method === "list" ? OpenClawScheduleListResult.parse(result).schedules[0]!
            : OpenClawScheduleGetResult.parse(result).schedule;
          assert.equal(field === "name" ? job.name : field === "lastError" ? job.state.lastError : job.delivery.to, expected);
          assert.doesNotMatch(JSON.stringify(result), /local_secret/);
        } finally { await f.close(); }
      });
    }
  }
}

test("OpenClaw accepts only complete initial-page envelopes and legacy arrays", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    for (const response of [[nativeJob], { jobs: [nativeJob] }, { jobs: [nativeJob], hasMore: false },
      { jobs: [nativeJob], total: 1 }, { jobs: [nativeJob], offset: 0, limit: 1, hasMore: false },
      { jobs: [nativeJob], offset: 0, limit: 1, total: 1 },
      { jobs: [], offset: 0, limit: 0, total: 0, hasMore: false }]) {
      f.respond(response);
      const listed = OpenClawScheduleListResult.parse(await conn.call("openclaw.schedule.list", {}));
      assert.equal(listed.schedules.length, Array.isArray(response) ? response.length : response.jobs.length);
    }
    for (const pagination of [{ offset: 1, limit: 1, hasMore: false, total: 1 },
      { offset: 1 }, { offset: -1 }, { offset: 0 }, { limit: 1 }, { offset: 0, limit: 2 },
      { offset: 0, limit: 1, hasMore: true }, { offset: 0, limit: 1, total: 2 },
      { offset: 0, limit: 0, hasMore: false }, { offset: null }, { limit: null }]) {
      f.respond({ jobs: [nativeJob], ...pagination });
      await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errCapabilityUnsupported"));
      await assert.rejects(() => conn.call("openclaw.schedule.get", { id: nativeJob.id }), rpcError("errCapabilityUnsupported"));
      assert.ok(!(await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    }
  } finally { await f.close(); }
});

for (const reason of ["unknown method", "unauthorized token=TRANSPORT_SECRET", "Gateway disconnected"]) {
  test(`OpenClaw RPC failure is closed: ${reason.split(" ")[0]}`, async () => {
    const f = fixture();
    try {
      const conn = f.actor();
      assert.ok((await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
      f.fail(reason);
      await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errAgentUnavailable"));
      await assert.rejects(() => conn.call("openclaw.schedule.get", { id: nativeJob.id }));
      assert.ok(!(await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    } finally { await f.close(); }
  });
}

test("OpenClaw unreachable/missing adapter and malformed/partial inventories never succeed empty", async () => {
  const f = fixture();
  try {
    const conn = f.actor();
    for (const response of [{}, null, { jobs: [], error: "denied" }, { jobs: [], ok: false }, { jobs: [], hasMore: true },
      { jobs: [], total: 1 }, { jobs: [nativeJob, nativeJob] }, { jobs: [{ id: "bad" }] }]) {
      f.respond(response);
      await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errCapabilityUnsupported"));
      assert.ok(!(await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    }
    f.disconnect();
    await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errAgentUnavailable"));
    f.registry.unregister("openclaw");
    await assert.rejects(() => conn.call("openclaw.schedule.list", {}), rpcError("errCapabilityUnsupported"));
    assert.ok(!(await conn.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
  } finally { await f.close(); }
});

test("OpenClaw discovery respects method/agent policies and strict read-only params", async () => {
  const f = fixture();
  try {
    const denied = f.actor({ allowedMethods: ["device.info"] });
    await assert.rejects(() => denied.call("openclaw.schedule.list", {}), rpcError("errPolicyDenied", /allowedMethods/));
    assert.ok(!(await denied.call("device.info", {}) as { capabilities: string[] }).capabilities.includes("openclaw_schedule_discover_v1"));
    assert.equal(f.calls.length, 0);
    const allowed = f.actor({ allowedAgents: ["openclaw:main" as never] });
    f.respond({ jobs: [nativeJob, { ...nativeJob, id: "foreign", effectiveAgentId: "other" },
      { id: "unknown-agent", enabled: true, schedule: { kind: "every", everyMs: 1000 } }] });
    assert.equal(OpenClawScheduleListResult.parse(await allowed.call("openclaw.schedule.list", {})).schedules.length, 1);
    await assert.rejects(() => allowed.call("openclaw.schedule.get", { id: "foreign" }), rpcError("errInvalidParams", /not found or not permitted/));
    const before = f.calls.length;
    for (const params of [{ run: true }, { enable: true }]) await assert.rejects(() => allowed.call("openclaw.schedule.list", params), rpcError("errInvalidParams", /invalid params/));
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test("OpenClaw CLI reads only cron list --all --json and fails closed on missing binary/nonzero/invalid JSON", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "phonon-openclaw-cli-read-"));
  try {
    const executable = join(root, "openclaw-fixture"), calls = join(root, "calls.jsonl");
    const program = (body: string) => writeFileSync(executable, `#!${process.execPath}\nconst {appendFileSync} = require('node:fs');\nappendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n${body}`, { mode: 0o700 });
    const adapter = new OpenClawAdapter({ binPath: executable });
    program(`console.log(${JSON.stringify(JSON.stringify({ jobs: [nativeJob] }))});`);
    assert.equal((await adapter.openclawScheduleList())[0]!.id, nativeJob.id);
    for (const body of ["process.exit(1);", "console.log('not json');", "console.log('{}');"]) {
      program(body); await assert.rejects(() => adapter.openclawScheduleList());
    }
    const recorded = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(recorded.every(args => JSON.stringify(args) === JSON.stringify(["cron", "list", "--all", "--json"])));
    await assert.rejects(() => new OpenClawAdapter({ binPath: join(root, "missing") }).openclawScheduleList(), error => (error as { appCode: string }).appCode === "errAgentUnavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TypeScript native discovery wrappers use vendor namespace only", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const device = new PhononDevice("device", "owner", { request: async (method: string, params: unknown) => { calls.push({ method, params }); return { native: true }; } } as never);
  await device.openclaw.schedule.list(); await device.openclaw.schedule.get("vendor-job");
  assert.deepEqual(calls, [{ method: "openclaw.schedule.list", params: {} }, { method: "openclaw.schedule.get", params: { id: "vendor-job" } }]);
  assert.deepEqual(Object.keys(device.openclaw.schedule), ["list", "get"]);
});
