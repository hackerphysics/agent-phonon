import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import type {Socket} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CodexAdapter} from "@agent-phonon/core";
import type {StreamEvent} from "@agent-phonon/protocol";

const nativeID = "11111111-1111-4111-8111-111111111111";
const fixtureOptions = {skip: process.platform === "win32", timeout: 15000};

function fixture(providerOverride = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-codex-sandbox-")));
  const home = join(root, "home"), cwd = join(root, "workspace"), bin = join(root, "codex.cjs");
  mkdirSync(home); mkdirSync(cwd);
  const config = 'approval_policy = "on-request"\n[sandbox_workspace_write]\nnetwork_access = false\n';
  writeFileSync(join(home, "config.toml"), config);
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), input = fs.readFileSync(0, 'utf8');
const home = process.env.CODEX_HOME, id = ${JSON.stringify(nativeID)};
fs.appendFileSync(path.join(home, 'invocations.jsonl'), JSON.stringify({args, input, cwd: process.cwd()}) + '\\n');
const dir = path.join(home, 'sessions'); fs.mkdirSync(dir, {recursive: true});
if (!args.includes('resume')) fs.writeFileSync(path.join(dir, 'rollout-' + id + '.jsonl'), JSON.stringify({type: 'session_meta', payload: {id, cwd: process.cwd()}}) + '\\n');
for (const event of [{type: 'thread.started', thread_id: id}, {type: 'item.completed', item: {type: 'agent_message', text: 'done'}}, {type: 'turn.completed'}]) console.log(JSON.stringify(event));
`, {mode: 0o700});
  const env = {binPath: bin, codexHome: home, defaultModel: "fixture",
    ...(providerOverride ? {baseUrl: "http://127.0.0.1:12345/v1", apiKey: "fixture-key"} : {})};
  return {root, home, cwd, config, adapter: new CodexAdapter({env}),
    invocations: () => readFileSync(join(home, "invocations.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as {args: string[]; input: string; cwd: string}),
    close: () => rmSync(root, {recursive: true, force: true})};
}

function assertSandbox(args: string[]) {
  const overrides = args.flatMap((arg, index) => arg === "-c" ? [args[index + 1]!] : []);
  assert.deepEqual(overrides.filter(value => value.startsWith("sandbox_mode=")), ['sandbox_mode="workspace-write"']);
  assert.ok(!args.some(arg => /dangerously|--full-auto|--approve-for-me/.test(arg)));
  assert.ok(!overrides.some(value => /^(approval_policy|approvals_reviewer|sandbox_workspace_write\.|permissions\.)/.test(value)),
    "working-directory writes must not override native approvals, networking or additional writable roots");
  assert.ok(args.includes("--skip-git-repo-check"));
}

async function send(session: Awaited<ReturnType<CodexAdapter["createSession"]>>, input: string) {
  const events: StreamEvent[] = [];
  await session.send(input, {turnId: input, verbosity: "tools", emit: event => events.push(event)});
  const terminal = events.at(-1);
  assert.ok(terminal?.type === "result", JSON.stringify(events));
  assert.equal(terminal.status, "completed", JSON.stringify(events));
}

for (const providerOverride of [false, true]) {
  test(`Codex new and resumed turns explicitly allow workspace writes (provider override: ${providerOverride})`, fixtureOptions, async () => {
    const f = fixture(providerOverride);
    const session = await f.adapter.createSession({sessionId: "sandbox", agentId: "codex", model: "fixture", cwd: f.cwd});
    try {
      await send(session, "first"); await send(session, "second");
      const calls = f.invocations();
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0]!.args.slice(0, 3), ["exec", "-", "--json"]);
      assert.deepEqual(calls[1]!.args.slice(0, 3), ["exec", "resume", nativeID]);
      for (const call of calls) { assertSandbox(call.args); assert.equal(call.cwd, f.cwd); }
      assert.equal(readFileSync(join(f.home, "config.toml"), "utf8"), f.config);
    } finally { await session.terminate(); f.close(); }
  });
}

test("Codex recovery preserves its native identity and invalidates prior usage on new input", fixtureOptions, async () => {
  const f = fixture();
  const params = {sessionId: "sandbox", agentId: "codex", model: "default", cwd: f.cwd};
  const session = await f.adapter.createSession(params);
  let recovered: typeof session | undefined;
  try {
    await send(session, "first");
    const checkpoint = session.recoveryCheckpoint!()!;
    await session.terminate();
    recovered = await new CodexAdapter({env: {binPath: join(f.root, "codex.cjs"), codexHome: f.home, defaultModel: "default"}})
      .recoverSession({...params, reattach: true}, checkpoint);
    assert.equal(f.invocations().length, 1, "recovery must not send model input");
    assert.deepEqual(recovered.recoveryCheckpoint!(), checkpoint);
    await send(recovered, "after-restart");
    const call = f.invocations()[1]!;
    assert.deepEqual(call.args.slice(0, 3), ["exec", "resume", nativeID]);
    assertSandbox(call.args); assert.equal(call.cwd, f.cwd);
    assert.ok(!call.args.includes("--model"));
    const next = recovered.recoveryCheckpoint!()!;
    assert.deepEqual({...next, contextNotBefore: checkpoint.contextNotBefore}, checkpoint);
    assert.equal(typeof next.contextNotBefore, "number");
    assert.ok((next.contextNotBefore as number) >= (checkpoint.contextNotBefore as number));
    assert.equal(readFileSync(join(f.home, "config.toml"), "utf8"), f.config);
  } finally { await recovered?.terminate(); await session.terminate(); f.close(); }
});

test("installed Codex writes inside its workspace on new and resumed turns while outside writes stay denied", {
  skip: !process.env.PHONON_TEST_CODEX_BIN || process.platform === "win32", timeout: 60000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-native-codex-sandbox-")));
  const home = join(root, "home"), cwd = join(root, "workspace"), sockets = new Set<Socket>();
  mkdirSync(home); mkdirSync(cwd);
  // Neither the native user config nor personal credentials enter this fixture.
  const config = 'approval_policy = "never"\n[features]\nshell_snapshot = false\n[sandbox_workspace_write]\nnetwork_access = false\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\n';
  writeFileSync(join(home, "config.toml"), config, {mode: 0o600});
  let requests = 0, toolCalls = 0, waitingForTool = false;
  const outputs: string[] = [], providerErrors: string[] = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
    try {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const input = JSON.parse(body);
      assert.ok(++requests <= 4, "native execution must settle without inference retries");
      let item: Record<string, unknown>;
      if (!waitingForTool) {
        const names = (input.tools ?? []).map((tool: {name?: string}) => tool.name);
        const name = names.includes("exec_command") ? "exec_command" : "shell_command";
        assert.ok(names.includes(name), "installed Codex must expose a native command tool: " + names.join(", "));
        const index = ++toolCalls;
        const command = `printf workspace-${index} > marker-${index}.txt; while [ ! -f release-${index} ]; do sleep 0.01; done; if (printf escape > '${join(root, `outside-${index}.txt`)}') 2>/dev/null; then printf ESCAPED; else printf BLOCKED; fi`;
        item = {type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name,
          arguments: JSON.stringify(name === "exec_command" ? {cmd: command} : {command})};
        waitingForTool = true;
      } else {
        const result = input.input.findLast((entry: {type?: string}) => entry.type === "function_call_output");
        assert.ok(result, "native CLI must return the actual command output");
        outputs.push(String(result.output));
        item = {type: "message", id: `msg_${toolCalls}`, role: "assistant", status: "completed",
          content: [{type: "output_text", text: "workspace write verified", annotations: []}]};
        waitingForTool = false;
      }
      res.writeHead(200, {"content-type": "text/event-stream"});
      const event = (value: Record<string, unknown>) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      event({type: "response.created", response: {id: `resp_${requests}`, status: "in_progress", output: []}});
      event({type: "response.output_item.added", output_index: 0, item});
      event({type: "response.output_item.done", output_index: 0, item});
      event({type: "response.completed", response: {id: `resp_${requests}`, status: "completed", output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}});
      res.end();
    } catch (error) { providerErrors.push(String(error)); res.writeHead(500); res.end(); }
  });
  provider.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as {port: number}).port;
  const adapter = new CodexAdapter({env: {binPath: process.env.PHONON_TEST_CODEX_BIN!, codexHome: home,
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "isolated-fixture-not-a-real-key", defaultModel: "gpt-5.4"}});
  const session = await adapter.createSession({sessionId: "native-sandbox", agentId: "codex", model: "gpt-5.4", cwd});
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
  try {
    for (const index of [1, 2]) {
      const events: StreamEvent[] = [];
      const sending = session.send(`write marker ${index}`, {turnId: `turn-${index}`, verbosity: "tools", signal: controller.signal, emit: event => events.push(event)});
      const deadline = Date.now() + 15000;
      while (!events.some(event => event.type === "tool_call" && event.toolName === "command_execution")) {
        assert.ok(Date.now() < deadline, "Native command start must be observable before its return");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(events.filter(event => event.type === "tool_result").length, 0, "The held native command has not returned");
      writeFileSync(join(cwd, `release-${index}`), "release");
      await sending;
      assert.deepEqual(providerErrors, []);
      const terminal = events.at(-1);
      assert.ok(terminal?.type === "result" && terminal.status === "completed", JSON.stringify(events));
      assert.equal(readFileSync(join(cwd, `marker-${index}.txt`), "utf8"), `workspace-${index}`);
      assert.equal(existsSync(join(root, `outside-${index}.txt`)), false, "the parent directory must not become writable");
      const calls = events.filter((event): event is Extract<StreamEvent,{type:"tool_call"}> => event.type === "tool_call" && event.toolName === "command_execution");
      const results = events.filter((event): event is Extract<StreamEvent,{type:"tool_result"}> => event.type === "tool_result" && event.toolName === "command_execution");
      assert.equal(calls.length, 1); assert.equal(results.length, 1); assert.ok(calls[0]!.toolCallId);
      assert.equal(results[0]!.toolCallId, calls[0]!.toolCallId); assert.equal(results[0]!.ok, true);
      const output = results[0]!.output as {output:string;exitCode:number};
      assert.equal(output.exitCode, 0); assert.ok(output.output.includes("BLOCKED") && !output.output.includes("ESCAPED"));
    }
    assert.equal(requests, 4); assert.equal(toolCalls, 2);
    assert.ok(outputs.every(output => output.includes("BLOCKED") && !output.includes("ESCAPED")));
    assert.equal(readFileSync(join(home, "config.toml"), "utf8"), config);
  } finally {
    clearTimeout(timer); await session.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(root, {recursive: true, force: true});
  }
});
