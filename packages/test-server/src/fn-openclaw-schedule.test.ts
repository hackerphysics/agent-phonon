import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterRegistry, OpenClawAdapter, OpenClawGatewayAdapter, PhononStore, GatewayClient } from "@agent-phonon/core";
import { METHODS, OpenClawScheduleListResult, OpenClawScheduleGetResult } from "@agent-phonon/protocol";
import { PhononDevice } from "@agent-phonon/server-sdk";
import { readOpenClawSchedules } from "../../core/dist/adapters/openclaw-schedule.js";
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

const crossingWhitespaceCases = ['"', "'"].flatMap(quote => [256, 512].map(length => {
  const opposite = quote === '"' ? "'" : '"';
  return {
    label: `HOLD25 crossing ${quote} with ${length} trailing spaces`,
    input: `token=${quote}prefix password=${opposite}HIDE ${quote} LEAK_ME${opposite}` + " ".repeat(length) + "public",
    expected: `token=${quote}[redacted]${quote}`, secrets: /HIDE|LEAK_ME|prefix/,
  };
}));

for (const { label, input, expected, secrets } of crossingWhitespaceCases) {
  test(`OpenClaw redacts ${label} without blocking the event loop`, async () => {
    for (let iteration = 0; iteration < 6; iteration++) {
      const start = performance.now();
      const [job] = await readOpenClawSchedules(async () => [{
        ...nativeJob, name: input, state: { lastError: input }, delivery: { ...nativeJob.delivery, to: input },
      }]);
      const elapsed = performance.now() - start;
      // Cold budget absorbs CI variance; warm stays far below the pre-HOLD25 multi-second path.
      const budget = iteration === 0 ? 250 : 100;
      assert.ok(elapsed < budget, `${label} iteration ${iteration} took ${elapsed.toFixed(1)}ms (budget ${budget}ms)`);
      for (const value of [job!.name, job!.state.lastError, job!.delivery.to]) {
        assert.equal(value, expected);
        assert.doesNotMatch(value!, secrets);
      }
    }
  });
}

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
  ...crossingWhitespaceCases,
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
  { label: "HOLD10 nonempty token before spaced password", input: 'token="alpha",password= "PRIVATE SUFFIX"',
    expected: 'token="[redacted]",password= "[redacted]"', secrets: /alpha|PRIVATE|SUFFIX|PRIVATE SUFFIX/ },
  { label: "HOLD10 nonempty API key before spaced token", input: 'api_key="v",token= "ALPHA BETA"',
    expected: 'api_key="[redacted]",token= "[redacted]"', secrets: /ALPHA|BETA|ALPHA BETA/ },
  { label: "HOLD10 nonempty JSON credential pairs", input: '{"token":"alpha","password":"PRIVATE SUFFIX"}',
    expected: '{"token":"[redacted]","password":"[redacted]"}', secrets: /alpha|PRIVATE|SUFFIX|PRIVATE SUFFIX/ },
  { label: "HOLD10 nonempty single-quoted token before spaced password", input: "token='alpha',password= 'PRIVATE SUFFIX'",
    expected: "token='[redacted]',password= '[redacted]'", secrets: /alpha|PRIVATE|SUFFIX|PRIVATE SUFFIX/ },
  { label: "HOLD10 nonempty single-quoted credential pairs", input: "{'token':'alpha','password':'PRIVATE SUFFIX'}",
    expected: "{'token':'[redacted]','password':'[redacted]'}", secrets: /alpha|PRIVATE|SUFFIX|PRIVATE SUFFIX/ },
  { label: "HOLD10 semicolon and flexible next assignment", input: `token='alpha';API-Key" : "ALPHA BETA"`,
    expected: `token='[redacted]';API-Key" : "[redacted]"`, secrets: /alpha|ALPHA|BETA|ALPHA BETA/ },
  { label: "HOLD10 glued suffix before next assignment", input: `secret='alpha'PRIVATE_SUFFIX,password= "ALPHA BETA"`,
    expected: `secret='[redacted]',password= "[redacted]"`, secrets: /alpha|PRIVATE|SUFFIX|ALPHA|BETA|ALPHA BETA/ },
  { label: "HOLD10 query parameter boundaries", input: 'https://example.test?token="alpha",password= "PRIVATE SUFFIX"&keep=public',
    expected: 'https://example.test?token="[redacted]",password= "[redacted]"&keep=public', secrets: /alpha|PRIVATE|SUFFIX|PRIVATE SUFFIX/ },
  { label: "HOLD10 whitespace-separated assignments", input: 'token="alpha" password= "PRIVATE SUFFIX" keep=public',
    expected: 'token="[redacted]" password= "[redacted]" keep=public', secrets: /alpha|PRIVATE|SUFFIX|PRIVATE SUFFIX/ },
  ...["old_password", "notpassword", "my_password", "prepassword", "admin_token", "apitoken", "notsecret"].flatMap(key => [
    { label: `HOLD11 double-quoted sticky embedded ${key}`, input: `token="alpha",${key}=VISIBLE,password= "HIDE ME"`,
      expected: 'token="[redacted]",password= "[redacted]"', secrets: /alpha|HIDE|ME|HIDE ME/ },
    { label: `HOLD11 single-quoted sticky embedded ${key}`, input: `token='alpha',${key}=VISIBLE,password= 'HIDE ME'`,
      expected: "token='[redacted]',password= '[redacted]'", secrets: /alpha|HIDE|ME|HIDE ME/ },
    { label: `HOLD11 empty single-pair embedded ${key}`, input: `password='',${key}=VISIBLE,password= "HIDE ME"`,
      expected: 'password=[redacted],password= "[redacted]"', secrets: /HIDE|ME|HIDE ME/ },
    { label: `HOLD11 empty double-pair embedded ${key}`, input: `password="",${key}=VISIBLE,password= 'HIDE ME'`,
      expected: "password=[redacted],password= '[redacted]'", secrets: /HIDE|ME|HIDE ME/ },
  ]),
  { label: "HOLD11 embedded key with query boundaries", input: 'https://example.test?token="alpha",old_password=VISIBLE,password= "HIDE ME"&keep=public',
    expected: 'https://example.test?token="[redacted]",password= "[redacted]"&keep=public', secrets: /alpha|HIDE|ME|HIDE ME/ },
  { label: "HOLD11 embedded key with whitespace boundaries", input: "password='',notsecret=VISIBLE,password= 'HIDE ME' keep=public",
    expected: "password=[redacted],password= '[redacted]' keep=public", secrets: /HIDE|ME|HIDE ME/ },
  ...["api_key", "api-key"].map(key => ({ label: `HOLD12 unquoted next ${key}`,
    input: `token="alpha",${key}=VISIBLE,password= "HIDE ME"`,
    expected: `token="[redacted]",${key}=[redacted],password= "[redacted]"`, secrets: /alpha|VISIBLE|HIDE|ME|HIDE ME/ })),
  { label: "HOLD12 unquoted token chain", input: 'secret=FIRST,token=SECOND,password= "HIDE ME"',
    expected: 'secret=[redacted],token=[redacted],password= "[redacted]"', secrets: /FIRST|SECOND|HIDE|ME|HIDE ME/ },
  { label: "HOLD12 unquoted password chain", input: "api_key=FIRST,password=SECOND,token= 'ALPHA BETA'",
    expected: "api_key=[redacted],password=[redacted],token= '[redacted]'", secrets: /FIRST|SECOND|ALPHA|BETA|ALPHA BETA/ },
  { label: "HOLD12 unquoted quoted next key", input: 'secret=FIRST,"token"=SECOND,"password"= "HIDE ME"',
    expected: 'secret=[redacted],"token"=[redacted],"password"= "[redacted]"', secrets: /FIRST|SECOND|HIDE|ME|HIDE ME/ },
  { label: "HOLD12 unquoted semicolon next key", input: "secret=FIRST;token=SECOND;password= 'HIDE ME'",
    expected: "secret=[redacted];token=[redacted];password= '[redacted]'", secrets: /FIRST|SECOND|HIDE|ME|HIDE ME/ },
  ...["x-password", "my-api-key", "pre-token", "foo-secret", "user-password"].flatMap(key => [
    { label: `HOLD12 double-quoted sticky hyphenated ${key}`, input: `token="alpha",${key}=VISIBLE,password= "HIDE ME"`,
      expected: 'token="[redacted]",password= "[redacted]"', secrets: /alpha|HIDE|ME|HIDE ME/ },
    { label: `HOLD12 single-quoted sticky hyphenated ${key}`, input: `token='alpha',${key}=VISIBLE,password= 'HIDE ME'`,
      expected: "token='[redacted]',password= '[redacted]'", secrets: /alpha|HIDE|ME|HIDE ME/ },
    { label: `HOLD12 empty single-pair hyphenated ${key}`, input: `password='',${key}=VISIBLE,password= "HIDE ME"`,
      expected: 'password=[redacted],password= "[redacted]"', secrets: /HIDE|ME|HIDE ME/ },
    { label: `HOLD12 empty double-pair hyphenated ${key}`, input: `password="",${key}=VISIBLE,password= 'HIDE ME'`,
      expected: "password=[redacted],password= '[redacted]'", secrets: /HIDE|ME|HIDE ME/ },
    { label: `HOLD12 unquoted hyphenated ${key}`, input: `token=FIRST,${key}=VISIBLE,password= "HIDE ME"`,
      expected: 'token=[redacted],password= "[redacted]"', secrets: /FIRST|HIDE|ME|HIDE ME/ },
  ]),
  { label: "HOLD12 unquoted query boundaries", input: 'https://example.test?token="alpha",api_key=VISIBLE,password= "HIDE ME"&keep=public',
    expected: 'https://example.test?token="[redacted]",api_key=[redacted],password= "[redacted]"&keep=public', secrets: /alpha|VISIBLE|HIDE|ME|HIDE ME/ },
  { label: "HOLD12 unquoted whitespace boundaries", input: "secret=FIRST token=SECOND,password= 'HIDE ME' keep=public",
    expected: "secret=[redacted] token=[redacted],password= '[redacted]' keep=public", secrets: /FIRST|SECOND|HIDE|ME|HIDE ME/ },
  { label: "HOLD12 hyphenated key with query boundaries", input: 'https://example.test?token="alpha",x-password=VISIBLE,password= "HIDE ME"&keep=public',
    expected: 'https://example.test?token="[redacted]",password= "[redacted]"&keep=public', secrets: /alpha|HIDE|ME|HIDE ME/ },
  { label: "HOLD12 hyphenated key with whitespace boundaries", input: "password='',my-api-key=VISIBLE,password= 'HIDE ME' keep=public",
    expected: "password=[redacted],password= '[redacted]' keep=public", secrets: /HIDE|ME|HIDE ME/ },
  ...["x-password", "my-api-key", "pre-token", "foo-secret", "user-password"].flatMap(key => [
    { prefix: 'token="alpha"', redacted: 'token="[redacted]"' },
    { prefix: "token='alpha'", redacted: "token='[redacted]'" },
    { prefix: "password=''", redacted: "password=[redacted]" },
    { prefix: 'password=""', redacted: "password=[redacted]" },
    { prefix: "token=FIRST", redacted: "token=[redacted]" },
  ].flatMap(({ prefix, redacted }) => ['"', "'"].map(quote => ({
    label: `HOLD13 ${prefix} before hyphenated ${key} with spaced ${quote} quotes`,
    input: `${prefix},${key}= ${quote}HIDE ME${quote}`,
    expected: `${redacted},${key}= ${quote}[redacted]${quote}`, secrets: /alpha|FIRST|HIDE|ME|HIDE ME/,
  })))),
  { label: "HOLD13 hyphenated spaced quotes with query boundaries", input: 'https://example.test?token="alpha",x-password= "HIDE ME"&keep=public',
    expected: 'https://example.test?token="[redacted]",x-password= "[redacted]"&keep=public', secrets: /alpha|HIDE|ME|HIDE ME/ },
  { label: "HOLD13 hyphenated semicolon, tabs and colon", input: "password='';my-api-key:\t 'ALPHA BETA' keep=public",
    expected: "password=[redacted];my-api-key:\t '[redacted]' keep=public", secrets: /ALPHA|BETA|ALPHA BETA/ },
  { label: "HOLD13 quoted hyphenated key", input: '{"token":"alpha","user-password": "HIDE ME"}',
    expected: '{"token":"[redacted]","user-password": "[redacted]"}', secrets: /alpha|HIDE|ME|HIDE ME/ },
  { label: "HOLD13 hyphenated escaped quote and sticky suffix", input: String.raw`token="alpha",foo-secret= "HIDE \"ME"PRIVATE_SUFFIX`,
    expected: 'token="[redacted]",foo-secret= "[redacted]"', secrets: /alpha|HIDE|ME|PRIVATE_SUFFIX/ },
  { label: "HOLD13 hyphenated unterminated quoted value", input: 'token="alpha",pre-token= "HIDE ME',
    expected: 'token="[redacted]",pre-token= "[redacted]"', secrets: /alpha|HIDE|ME|HIDE ME/ },
  { label: "HOLD13 hyphenated spaced quoted chain", input: 'token="alpha",x-password= "HIDE ME",my-api-key= \'ALPHA BETA\'',
    expected: 'token="[redacted]",x-password= "[redacted]",my-api-key= \'[redacted]\'', secrets: /alpha|HIDE|ME|HIDE ME|ALPHA|BETA|ALPHA BETA/ },
  ...[
    { prefix: "token=TOPSECRET", expected: "token=[redacted]" },
    { prefix: "api_key=TOPSECRET", expected: "api_key=[redacted]" },
    { prefix: "password=TOPSECRET", expected: "password=[redacted]" },
    { prefix: 'token="OUTER"TOPSECRET', expected: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", expected: "token='[redacted]'" },
    { prefix: "password=''TOPSECRET", expected: "password=[redacted]" },
    { prefix: 'password=""TOPSECRET', expected: "password=[redacted]" },
  ].flatMap(({ prefix, expected }) => ["password", "x-password", "api-key", "api_key", "secret"].flatMap(key =>
    ['"', "'"].map(quote => ({
      label: `HOLD14 glued ${prefix}-${key} with ${quote} quotes`,
      input: `${prefix}-${key}=${quote}alpha${quote}`, expected, secrets: /TOPSECRET|OUTER|alpha/,
    })))),
  ...[
    { prefix: "token=TOPSECRET", expected: "token=[redacted]" },
    { prefix: "api_key=TOPSECRET", expected: "api_key=[redacted]" },
    { prefix: "password=TOPSECRET", expected: "password=[redacted]" },
    { prefix: 'token="OUTER"TOPSECRET', expected: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", expected: "token='[redacted]'" },
    { prefix: "password=''TOPSECRET", expected: "password=[redacted]" },
    { prefix: 'password=""TOPSECRET', expected: "password=[redacted]" },
    { prefix: "token=VISIBLE", expected: "token=[redacted]" },
  ].flatMap(({ prefix, expected }) => ["password", "x-password", "api-key", "api_key", "secret"].flatMap(key =>
    ['"', "'"].flatMap(quote => ["", " "].map(space => ({
      label: `HOLD15 spaced glued ${prefix}-${key}=${space}${quote} body`,
      input: `${prefix}-${key}=${space}${quote}HIDE ME${quote}`, expected, secrets: /TOPSECRET|VISIBLE|OUTER|HIDE|ME|HIDE ME/,
    }))))),
  { label: "HOLD15 glued escaped double quote and sticky suffix", input: String.raw`token=TOPSECRET-password= "HIDE \"ME"PRIVATE_SUFFIX`,
    expected: "token=[redacted]", secrets: /TOPSECRET|HIDE|ME|PRIVATE_SUFFIX/ },
  { label: "HOLD15 glued escaped single quote and sticky suffix", input: String.raw`token='OUTER'TOPSECRET-x-password= 'HIDE \'ME'PRIVATE_SUFFIX`,
    expected: "token='[redacted]'", secrets: /OUTER|TOPSECRET|HIDE|ME|PRIVATE_SUFFIX/ },
  { label: "HOLD15 glued unterminated double quote", input: 'token=TOPSECRET-password= "HIDE ME',
    expected: "token=[redacted]", secrets: /TOPSECRET|HIDE|ME/ },
  { label: "HOLD15 glued unterminated single quote with trailing escape", input: "password=''TOPSECRET-secret='HIDE ME" + "\\",
    expected: "password=[redacted]", secrets: /TOPSECRET|HIDE|ME/ },
  { label: "HOLD15 glued quoted query boundary", input: 'https://example.test?api_key=TOPSECRET-api-key= "HIDE & ME"&keep=public',
    expected: "https://example.test?api_key=[redacted]&keep=public", secrets: /TOPSECRET|HIDE|ME/ },
  { label: "HOLD15 glued quoted value before structural brace", input: '{"token":"OUTER"TOPSECRET-password="HIDE } ME"}',
    expected: '{"token":"[redacted]"}', secrets: /OUTER|TOPSECRET|HIDE|ME/ },
  { label: "HOLD15 glued quoted value before whitespace boundary", input: "token=VISIBLE-password= 'HIDE ME' keep=public",
    expected: "token=[redacted] keep=public", secrets: /VISIBLE|HIDE|ME/ },
  { label: "HOLD15 glued quoted value before next credential", input: 'token=TOPSECRET-password= "HIDE ME",api_key= "alpha beta"',
    expected: 'token=[redacted],api_key= "[redacted]"', secrets: /TOPSECRET|HIDE|ME|alpha|beta/ },
  { label: "HOLD15 glued quoted value before hyphenated next credential", input: 'password=""TOPSECRET-secret= "HIDE ME",x-password= "alpha beta"',
    expected: 'password=[redacted],x-password= "[redacted]"', secrets: /TOPSECRET|HIDE|ME|alpha|beta/ },
  { label: "HOLD15 glued case-insensitive key with colon and tabs", input: "token=TOPSECRET-X-API-Key:\t 'HIDE ME' keep=public",
    expected: "token=[redacted] keep=public", secrets: /TOPSECRET|HIDE|ME/ },
  ...[
    ...["token", "password", "api_key", "api-key", "secret"].map(key => ({
      prefix: `${key}=OUTER`, redacted: `${key}=[redacted]`,
    })),
    { prefix: 'token="OUTER"TOPSECRET', redacted: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", redacted: "token='[redacted]'" },
    { prefix: "password=''OUTER", redacted: "password=[redacted]" },
    { prefix: 'password=""OUTER', redacted: "password=[redacted]" },
  ].flatMap(({ prefix, redacted }) => ["token", "password", "api_key", "api-key", "secret"].flatMap(key =>
    ['"', "'"].flatMap(quote => ["HIDE ME", "part TOPSECRET"].map(body => ({
      label: `HOLD16 overlapping glued ${prefix} with embedded ${key} and ${quote}${body}${quote}`,
      input: `${prefix}-password=${quote}X ${key}= ${quote}${body}${quote}`,
      expected: `${redacted} ${key}= ${quote}[redacted]${quote}`, secrets: /OUTER|TOPSECRET|HIDE|ME/,
    }))))),
  { label: "HOLD16 overlapping glued case-insensitive quoted key with colon and tabs",
    input: 'token=OUTER-password="X API-Key" :\t "part TOPSECRET"',
    expected: 'token=[redacted] API-Key" :\t "[redacted]"', secrets: /OUTER|TOPSECRET/ },
  { label: "HOLD16 overlapping glued escaped body prefix and sticky secret suffix",
    input: String.raw`token=OUTER-password="X \"Y token= "HIDE ME"PRIVATE_SUFFIX`,
    expected: String.raw`token=[redacted] \"Y token= "[redacted]"`, secrets: /OUTER|HIDE|ME|PRIVATE_SUFFIX/ },
  ...[
    { prefix: "token=OUTER", redacted: "token=[redacted]" },
    { prefix: "api_key=OUTER", redacted: "api_key=[redacted]" },
    { prefix: 'token="OUTER"TOPSECRET', redacted: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", redacted: "token='[redacted]'" },
    { prefix: "password=''OUTER", redacted: "password=[redacted]" },
    { prefix: 'password=""OUTER', redacted: "password=[redacted]" },
  ].flatMap(({ prefix, redacted }) => ['"', "'"].flatMap(quote => [
    ...["Xnotsecret= HIDE ME", "Xapitoken= HIDE ME", "Xabcsecret= HIDE ME", "X secret= HIDE ME", "Xtoken=HIDE ME",
      `Xtoken= ${quote === '"' ? "'HIDE ME'" : '"HIDE ME"'}`].map(body => ({
      label: `HOLD17 benign glued quoted interior ${prefix} ${quote}${body}${quote}`,
      input: `${prefix}-password=${quote}${body}${quote}PRIVATE_SUFFIX`,
      expected: redacted, secrets: /OUTER|TOPSECRET|HIDE|ME|PRIVATE_SUFFIX/,
    })),
    ...["token", "password", "api_key", "api-key", "secret"].flatMap(key => ["", " "].map(space => ({
      label: `HOLD17 adjacent overlap ${prefix}-password=${space}${quote}X${key}`,
      input: `${prefix}-password=${space}${quote}X${key}= ${quote}HIDE ME${quote}PRIVATE_SUFFIX`,
      expected: `${redacted}${key}= ${quote}[redacted]${quote}`, secrets: /OUTER|TOPSECRET|HIDE|ME|PRIVATE_SUFFIX/,
    }))),
  ])),
  { label: "HOLD17 benign glued quoted interior without sticky suffix", input: 'token=OUTER-password="Xnotsecret= HIDE ME"',
    expected: "token=[redacted]", secrets: /OUTER|HIDE|ME/ },
  { label: "HOLD17 adjacent overlap with quoted key, colon and tabs", input: 'token=OUTER-password="XAPI-Key" :\t "HIDE ME"',
    expected: 'token=[redacted]API-Key" :\t "[redacted]"', secrets: /OUTER|HIDE|ME/ },
  { label: "HOLD17 nested hyphen assignment stays glued", input: 'token=OUTER-password="X-api_key= "HIDE ME"',
    expected: "token=[redacted]", secrets: /OUTER|HIDE|ME/ },
  { label: "HOLD17 escaped interior opener is not an overlap", input: String.raw`token=OUTER-password="Xtoken= \"HIDE ME\""PRIVATE_SUFFIX`,
    expected: "token=[redacted]", secrets: /OUTER|HIDE|ME|PRIVATE_SUFFIX/ },
  ...[
    ...["token", "password", "secret", "api_key", "api-key"].map(key => ({
      prefix: `${key}=OUTER`, redacted: `${key}=[redacted]`,
    })),
    { prefix: 'token="OUTER"TOPSECRET', redacted: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", redacted: "token='[redacted]'" },
    { prefix: "password=''OUTER", redacted: "password=[redacted]" },
    { prefix: 'password=""OUTER', redacted: "password=[redacted]" },
    ...["token=", "token=''", 'token=""'].map(prefix => ({ prefix, redacted: "token=[redacted]" })),
  ].flatMap(({ prefix, redacted }) => ["token", "password", "secret", "api_key", "api-key"].flatMap(key =>
    ['"', "'"].flatMap(quote => ["", " "].map(space => {
      const opposite = quote === '"' ? "'" : '"';
      return {
        label: `HOLD18 mixed-quote crossing ${prefix}-password=${space}${quote} with ${key}`,
        input: `${prefix}-password=${space}${quote}X ${key}= ${opposite}HIDE ${quote} LEAK_ME${opposite}PRIVATE_SUFFIX`,
        expected: `${redacted} ${key}= ${opposite}[redacted]${opposite}`,
        secrets: /OUTER|TOPSECRET|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/,
      };
    })))),
  ...['"', "'"].flatMap(quote => {
    const opposite = quote === '"' ? "'" : '"';
    return [
      { label: `HOLD18 adjacent mixed-quote crossing ${quote}`,
        input: `token=OUTER-password=${quote}Xtoken= ${opposite}HIDE ${quote} LEAK_ME${opposite}PRIVATE_SUFFIX`,
        expected: `token=[redacted]token= ${opposite}[redacted]${opposite}`,
        secrets: /OUTER|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/ },
      { label: `HOLD18 mixed-quote crossing with escaped interior quote ${quote}`,
        input: `token=OUTER-password=${quote}X secret= ${opposite}HIDE \\${quote} ME ${quote} LEAK_ME${opposite}PRIVATE_SUFFIX`,
        expected: `token=[redacted] secret= ${opposite}[redacted]${opposite}`,
        secrets: /OUTER|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/ },
      { label: `HOLD18 contained opposite quotes with escaped glued quote ${quote}`,
        input: `token=OUTER-password=${quote}Xtoken= ${opposite}HIDE \\${quote} ME${opposite}${quote}PRIVATE_SUFFIX`,
        expected: "token=[redacted]", secrets: /OUTER|HIDE|ME|PRIVATE_SUFFIX/ },
    ];
  }),
  ...[
    ...["token", "password", "secret", "api_key", "api-key"].map(key => ({
      prefix: `${key}=OUTER`, redacted: `${key}=[redacted]`,
    })),
    { prefix: 'token="OUTER"TOPSECRET', redacted: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", redacted: "token='[redacted]'" },
    { prefix: "password=''OUTER", redacted: "password=[redacted]" },
    { prefix: 'password=""OUTER', redacted: "password=[redacted]" },
    ...["token=", "token=''", 'token=""'].map(prefix => ({ prefix, redacted: "token=[redacted]" })),
  ].flatMap(({ prefix, redacted }) => ["token", "password", "secret", "api_key", "api-key"].flatMap(key =>
    ['"', "'"].flatMap(quote => ["PRIVATE_PREFIX", "KEEP_ME something", "api_key=KEEP_ME something"].map(interior => {
      const opposite = quote === '"' ? "'" : '"';
      return {
        label: `HOLD19 multiword prefix ${prefix}-password=${quote}X ${interior} before ${key}`,
        input: `${prefix}-password=${quote}X ${interior} ${key}= ${opposite}HIDE ${quote}TAIL${opposite}PRIVATE_SUFFIX`,
        expected: `${redacted} ${key}= ${opposite}[redacted]${opposite}`,
        secrets: /PRIVATE_PREFIX|KEEP_ME|something|OUTER|TOPSECRET|HIDE|TAIL|LEAK_ME|PRIVATE_SUFFIX|ME/,
      };
    })))),
  ...['"', "'"].flatMap(quote => {
    const opposite = quote === '"' ? "'" : '"';
    return [
      { label: `HOLD19 multiword prefix with spaced glued opener and escaped quote ${quote}`,
        input: `token=OUTER-password= ${quote}X \\${quote} PRIVATE_PREFIX KEEP_ME secret= ${opposite}HIDE ${quote} LEAK_ME${opposite}PRIVATE_SUFFIX`,
        expected: `token=[redacted] secret= ${opposite}[redacted]${opposite}`,
        secrets: /PRIVATE_PREFIX|KEEP_ME|OUTER|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/ },
      { label: `HOLD19 multiword prefix before quoted key, colon and tabs ${quote}`,
        input: `token=OUTER-password=${quote}X PRIVATE_PREFIX KEEP_ME API-Key${opposite} :\t ${opposite}HIDE ${quote}TAIL${opposite}PRIVATE_SUFFIX`,
        expected: `token=[redacted] API-Key${opposite} :\t ${opposite}[redacted]${opposite}`,
        secrets: /PRIVATE_PREFIX|KEEP_ME|OUTER|HIDE|TAIL|PRIVATE_SUFFIX|ME/ },
    ];
  }),
  ...[
    ...["token", "password", "secret", "api_key", "api-key"].map(key => ({
      prefix: `${key}=OUTER`, redacted: `${key}=[redacted]`,
    })),
    { prefix: 'token="OUTER"TOPSECRET', redacted: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", redacted: "token='[redacted]'" },
    { prefix: "password=''OUTER", redacted: "password=[redacted]" },
    { prefix: 'password=""OUTER', redacted: "password=[redacted]" },
    ...["token=", "token=''", 'token=""'].map(prefix => ({ prefix, redacted: "token=[redacted]" })),
  ].flatMap(({ prefix, redacted }) => ["token", "password", "secret", "api_key", "api-key"].flatMap(key =>
    ['"', "'"].flatMap(quote => ["", "PRIVATE_PREFIX ", "KEEP_ME something ", "api_key=KEEP_ME something "].map(interior => {
      const opposite = quote === '"' ? "'" : '"';
      return {
        label: `HOLD20 first quoted opener ${prefix}-password=${quote}X ${interior}${key}`,
        input: `${prefix}-password=${quote}X ${interior}${key}=${opposite}secret=${opposite}${quote} ${key}=${opposite}HIDE LEAK_ME${opposite}PRIVATE_SUFFIX`,
        expected: `${redacted} ${key}=${opposite}[redacted]${opposite} ${key}=${opposite}[redacted]${opposite}`,
        secrets: /PRIVATE_PREFIX|KEEP_ME|something|OUTER|TOPSECRET|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/,
      };
    })))),
  ...['"', "'"].flatMap(quote => {
    const opposite = quote === '"' ? "'" : '"';
    return [
      ...["token", "password", "api_key", "api-key"].flatMap(valueKey => ["", " "].map(space => ({
        label: `HOLD20 first quoted opener before embedded ${valueKey}= with ${quote} and spacing ${JSON.stringify(space)}`,
        input: `token=OUTER-password=${space}${quote}X PRIVATE_PREFIX token=${space}${opposite}${valueKey}=${opposite}${quote} password=${space}${opposite}HIDE LEAK_ME${opposite}PRIVATE_SUFFIX`,
        expected: `token=[redacted] token=${space}${opposite}[redacted]${opposite} password=${space}${opposite}[redacted]${opposite}`,
        secrets: /PRIVATE_PREFIX|OUTER|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/,
      }))),
      { label: `HOLD20 first quoted opener with quoted key, colon and tabs ${quote}`,
        input: `token=OUTER-password=${quote}X PRIVATE_PREFIX KEEP_ME API-Key${opposite} :\t ${opposite}secret=${opposite}${quote} secret=${opposite}HIDE LEAK_ME${opposite}PRIVATE_SUFFIX`,
        expected: `token=[redacted] API-Key${opposite} :\t ${opposite}[redacted]${opposite} secret=${opposite}[redacted]${opposite}`,
        secrets: /PRIVATE_PREFIX|KEEP_ME|OUTER|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/ },
    ];
  }),
  ...[
    ...["token", "password", "secret", "api_key", "api-key"].map(key => ({
      prefix: `${key}=OUTER`, redacted: `${key}=[redacted]`,
    })),
    { prefix: 'token="OUTER"TOPSECRET', redacted: 'token="[redacted]"' },
    { prefix: "token='OUTER'TOPSECRET", redacted: "token='[redacted]'" },
    { prefix: "password=''OUTER", redacted: "password=[redacted]" },
    { prefix: 'password=""OUTER', redacted: "password=[redacted]" },
    ...["token=", "token=''", 'token=""'].map(prefix => ({ prefix, redacted: "token=[redacted]" })),
  ].flatMap(({ prefix, redacted }) => ["token", "password", "secret", "api_key"].flatMap(key =>
    ['"', "'"].flatMap(quote => ["PRIVATE_PREFIX KEEP_ME", "KEEP_ME something", "api_key=KEEP_ME something"].flatMap(mid => {
      const opposite = quote === '"' ? "'" : '"';
      const contained = `${prefix}-password=${quote}X ${key}=${opposite}secret=${opposite} ${mid}`;
      const secrets = /PRIVATE_PREFIX|KEEP_ME|something|OUTER|TOPSECRET|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/;
      return [
        { label: `HOLD21 mid-body ${prefix} ${quote} ${key} ${mid}`,
          input: `${contained} ${key}=${opposite}HIDE ${quote} LEAK_ME${opposite}PRIVATE_SUFFIX`,
          expected: `${redacted} ${key}=${opposite}[redacted]${opposite}`, secrets },
        { label: `HOLD21 contained-trailing ${prefix} ${quote} ${key} ${mid}`,
          input: `${contained}${quote}`, expected: redacted, secrets },
      ];
    })))),
  ...['"', "'"].flatMap(quote => {
    const opposite = quote === '"' ? "'" : '"';
    return ["token", "password", "secret", "api_key", "api-key"].flatMap(valueKey => ["", " "].flatMap(space => {
      const contained = `token=OUTER-password=${space}${quote}X token=${space}${opposite}${valueKey}=${opposite} PRIVATE_PREFIX KEEP_ME`;
      const secrets = /PRIVATE_PREFIX|KEEP_ME|OUTER|HIDE|LEAK_ME|PRIVATE_SUFFIX|ME/;
      return [
        { label: `HOLD21 opaque ${valueKey}= mid-body ${quote} ${JSON.stringify(space)}`,
          input: `${contained} password=${space}${opposite}HIDE ${quote} LEAK_ME${opposite}PRIVATE_SUFFIX`,
          expected: `token=[redacted] password=${space}${opposite}[redacted]${opposite}`, secrets },
        { label: `HOLD21 opaque ${valueKey}= contained-trailing ${quote} ${JSON.stringify(space)}`,
          input: `${contained}${quote}`, expected: "token=[redacted]", secrets },
      ];
    }));
  }),
  ...["token", "api_key", "secret", "password", "api-key"].flatMap(key => ['"', "'"].flatMap(quote => {
    const opposite = quote === '"' ? "'" : '"';
    return [
      ...["prefix", "X"].flatMap(prefix => ["", "PRIVATE_SUFFIX", quote, `${quote}PRIVATE_SUFFIX`].map(suffix => ({
        label: `HOLD22 top-level quoted ${key} crossing ${quote} with ${prefix} and suffix ${JSON.stringify(suffix)}`,
        input: `${key}=${quote}${prefix} password=${opposite}HIDE ${quote} LEAK_ME${opposite}${suffix}`,
        expected: `${key}=${quote}[redacted]${quote}`, secrets: /LEAK_ME|PRIVATE_SUFFIX|HIDE|prefix|X/,
      }))),
      { label: `HOLD22 glued top-level quoted ${key} crossing ${quote} control`,
        input: `${key}=${quote}prefix password=${opposite}HIDE ${quote}LEAK_ME${opposite}${quote}`,
        expected: `${key}=${quote}[redacted]${quote}`, secrets: /LEAK_ME|HIDE|prefix/ },
    ];
  })),
  ...["token", "password", "secret", "api_key", "api-key"].flatMap(outer =>
    ["token", "password", "secret", "api_key", "api-key"].flatMap(next => ['"', "'"].flatMap(quote => {
      const opposite = quote === '"' ? "'" : '"';
      const crossing = `${outer}=${quote}prefix password=${opposite}HIDE ${quote} LEAK_ME${opposite}`;
      const redacted = `${outer}=${quote}[redacted]${quote}`;
      const secrets = /prefix|HIDE|LEAK_ME|PRIVATE_SUFFIX|FIRST_PRIVATE|SECOND_PRIVATE|ONLYONE/;
      return [
        ...[" ", ",", ";", "&"].flatMap(separator =>
          ["", "PRIVATE_SUFFIX", " PRIVATE_SUFFIX", "PRIVATE_SUFFIX PRIVATE_SUFFIX"].map(suffix => ({
            label: `HOLD23 top-level ${outer} crossing ${quote} before ${next} with separator ${JSON.stringify(separator)} and suffix ${JSON.stringify(suffix)}`,
            input: `${crossing}${suffix}${separator}${next}=${quote}FIRST_PRIVATE SECOND_PRIVATE${quote}`,
            expected: `${redacted}${separator}${next}=${quote}[redacted]${quote}`, secrets,
          }))),
        { label: `HOLD23 top-level ${outer} crossing ${quote} before single-word ${next}`,
          input: `${crossing} ${next}=${quote}ONLYONE${quote}`,
          expected: `${redacted} ${next}=${quote}[redacted]${quote}`, secrets },
        { label: `HOLD23 top-level ${outer} crossing ${quote} with outer closer before ${next}`,
          input: `${crossing}${quote} ${next}=${quote}FIRST_PRIVATE SECOND_PRIVATE${quote}`,
          expected: `${redacted} ${next}=${quote}[redacted]${quote}`, secrets },
        { label: `HOLD23 top-level ${outer} crossing ${quote} before opposite-quoted ${next}`,
          input: `${crossing}PRIVATE_SUFFIX ${next}=${opposite}FIRST_PRIVATE SECOND_PRIVATE${opposite}`,
          expected: `${redacted} ${next}=${opposite}[redacted]${opposite}`, secrets },
        { label: `HOLD23 top-level ${outer} crossing ${quote} before unquoted ${next}`,
          input: `${crossing}PRIVATE_SUFFIX ${next}=ONLYONE`,
          expected: `${redacted} ${next}=[redacted]`, secrets },
      ];
    }))),
  ...["token", "password", "secret", "api_key", "api-key"].flatMap(outer =>
    ["x-password", "x-token", "x-secret", "x-api_key", "x-api-key"].flatMap(next => ['"', "'"].flatMap(quote => {
      const opposite = quote === '"' ? "'" : '"';
      const crossing = `${outer}=${quote}prefix password=${opposite}HIDE ${quote} LEAK_ME${opposite}`;
      const redacted = `${outer}=${quote}[redacted]${quote}`;
      const secrets = /prefix|alpha|HIDE|LEAK_ME|PRIVATE_SUFFIX|FIRST_PRIVATE|SECOND_PRIVATE|ONLYONE/;
      return [
        ...[", ", "; ", ",\t", ";\t"].flatMap(separator =>
          ["", "PRIVATE_SUFFIX", " PRIVATE_SUFFIX", "PRIVATE_SUFFIX PRIVATE_SUFFIX"].map(suffix => ({
            label: `HOLD24 top-level ${outer} crossing ${quote} before ${next} with separator ${JSON.stringify(separator)} and suffix ${JSON.stringify(suffix)}`,
            input: `${crossing}${suffix}${separator}${next}=${quote}FIRST_PRIVATE SECOND_PRIVATE${quote}`,
            expected: `${redacted}${separator}${next}=${quote}[redacted]${quote}`, secrets,
          }))),
        ...(outer === "token" && next === "x-password" ? [", ", "; ", ",\t", ";\t"].flatMap(separator => [
          ...['"', "'"].map(keyQuote => ({
            label: `HOLD24 top-level ${outer} crossing ${quote} before ${keyQuote}${next}${keyQuote} with separator ${JSON.stringify(separator)}`,
            input: `${crossing}PRIVATE_SUFFIX${separator}${keyQuote}${next}${keyQuote}=${quote}FIRST_PRIVATE SECOND_PRIVATE${quote}`,
            expected: `${redacted}${separator}${keyQuote}${next}${keyQuote}=${quote}[redacted]${quote}`, secrets,
          })),
          { label: `HOLD24 non-crossing ${outer} ${quote} before ${next} with separator ${JSON.stringify(separator)}`,
            input: `${outer}=${quote}alpha${quote}${separator}${next}=${quote}FIRST_PRIVATE SECOND_PRIVATE${quote}`,
            expected: `${redacted}${separator}${next}=${quote}[redacted]${quote}`, secrets },
          { label: `HOLD24 top-level ${outer} crossing ${quote} before single-word ${next} with separator ${JSON.stringify(separator)}`,
            input: `${crossing}${separator}${next}=${quote}ONLYONE${quote}`,
            expected: `${redacted}${separator}${next}=${quote}[redacted]${quote}`, secrets },
        ]) : []),
        ...[",", ";"].map(separator => ({
          label: `HOLD24 no-space ${outer} crossing ${quote} before ${next} with separator ${JSON.stringify(separator)}`,
          input: `${crossing}${separator}${next}=${quote}FIRST_PRIVATE SECOND_PRIVATE${quote}`,
          expected: `${redacted}${separator}${next}=${quote}[redacted]${quote}`, secrets,
        })),
      ];
    }))),
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
