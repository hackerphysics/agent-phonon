import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {join} from "node:path";
import test from "node:test";
import {PiAdapter} from "@agent-phonon/core";
import type {AdapterSession} from "@agent-phonon/core";
import {withPeerFixture, closePeerServer} from "../../core/dist/testing/peer-fixture.js";

for (const phase of ["insert", "revoked", "closed", "resume"] as const) test(`installed Pi current-turn ${phase} retains its original native RPC execution`, {
  skip: !process.env.PHONON_TEST_PI_BIN, timeout: 45000,
}, () => withPeerFixture("pi-installed-input", async scope => {
  const home = join(scope.root, "pi"), marker = "PI_INSERT_" + randomUUID();
  mkdirSync(home);
  writeFileSync(join(scope.root, "input.txt"), "Original native Pi file\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({compaction: {enabled: false}, retry: {enabled: false}}));
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_HOME"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = home;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PI_CODING_AGENT_HOME;
  scope.defer(() => {for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;});
  const payloads: any[] = [], events: any[] = [], errors: unknown[] = [], pending: Promise<unknown>[] = [];
  const abort = new AbortController();
  let session: AdapterSession | undefined, insertion: Promise<void> | undefined, accepted = false;
  scope.defer(async () => {abort.abort(); await session?.terminate(); await Promise.allSettled(pending);});
  const provider = createServer((req, res) => {void (async () => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const payload = JSON.parse(body); payloads.push(payload);
    const index = payloads.length;
    assert(index <= (phase === "resume" ? 3 : phase === "closed" ? 1 : 2), "Steering must not start replacement work");
    if (index === 1) {
      assert(!body.includes(marker));
      if (phase !== "closed") {
        insertion = session!.insertAtToolGap!(marker, {turnId: "original", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
          ...(phase === "revoked" ? {beforeApply: () => {throw new Error("Original source withdrawn");}} : {})});
        pending.push(insertion);
        void insertion.then(() => {accepted = true;}, () => {});
      }
    } else if (index === 2) {
      assert.equal(body.includes(marker), phase !== "revoked", "Only the original authorized continuation may consume steering");
      if (phase !== "revoked") await insertion;
    }
    res.writeHead(200, {"Content-Type": "text/event-stream"});
    const send = (delta: unknown, finish_reason: string | null) => res.write("data: " + JSON.stringify({id: "controlled", object: "chat.completion.chunk", created: 1,
      model: "m1", choices: [{index: 0, delta, finish_reason}]}) + "\n\n");
    if (index === 1 && phase !== "closed") {
      assert(payload.tools.some((tool: any) => tool.function?.name === "read"), "Actual native read tool is required");
      send({role: "assistant", tool_calls: [{index: 0, id: "original-read", type: "function", function: {name: "read", arguments: JSON.stringify({path: join(scope.root, "input.txt")})}}]}, null);
      send({}, "tool_calls");
    } else {send({role: "assistant", content: "Original Pi task complete"}, null); send({}, "stop");}
    res.write("data: " + JSON.stringify({id: "controlled", object: "chat.completion.chunk", model: "m1", choices: [], usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}}) + "\n\n");
    res.end("data: [DONE]\n\n");
  })().catch(error => {errors.push(error); abort.abort(); res.destroy();});});
  scope.defer(() => closePeerServer(provider));
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as {port: number}).port;
  writeFileSync(join(home, "models.json"), JSON.stringify({providers: {"phonon-fixture": {
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "controlled-local-key", api: "openai-completions",
    models: [{id: "m1", name: "Controlled response", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 32000, maxTokens: 2000}],
  }}}));
  const adapter = new PiAdapter({env: {binPath: process.env.PHONON_TEST_PI_BIN, defaultModel: "phonon-fixture/m1"}});
  assert.equal((await adapter.discoverAgents())[0]?.capabilities.injectMidTurn, true);
  session = await adapter.createSession({sessionId: randomUUID(), agentId: "pi", model: "phonon-fixture/m1", cwd: scope.root});
  const watchNative = () => {
    const native = (session as any).lastNative?.supervisor;
    assert(native, "The native execution must have supervised process ownership");
    scope.watch(native.child, true);
    scope.defer(async () => {
      if (!native.hasStopped()) await native.terminate();
      const deadline = Date.now() + 5000;
      while (!native.hasStopped() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert(native.hasStopped(), "Native Pi tree stop remains unconfirmed");
    });
  };
  const run = session.send("Read input.txt once and finish.", {turnId: "original", verbosity: "tools", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]), emit: event => events.push(event)});
  pending.push(run); watchNative(); await run;
  assert.deepEqual(errors, []);
  assert.equal(events.at(-1)?.status, "completed", JSON.stringify(events));
  if (phase === "closed") await assert.rejects(session.insertAtToolGap!(marker, {turnId: "original", signal: AbortSignal.timeout(1000)}));
  else if (phase === "revoked") {await assert.rejects(insertion!); assert.equal(accepted, false);}
  else {await insertion; assert.equal(accepted, true);}
  const checkpoint = session.recoveryCheckpoint?.();
  assert(checkpoint, "The original native history must remain recoverable");
  if (phase === "resume") {
    const next = session.send("Continue the same native session.", {turnId: "next", verbosity: "tools", signal: AbortSignal.timeout(30000), emit: event => events.push(event)});
    pending.push(next); watchNative(); await next;
    assert.equal(events.at(-1)?.status, "completed", JSON.stringify(events));
    const continued = session.recoveryCheckpoint?.() as any;
    assert.equal(continued?.native?.sessionId, (checkpoint as any).native.sessionId);
    assert.equal(continued?.native?.path, (checkpoint as any).native.path);
  }
  assert.equal(readFileSync(join(scope.root, "input.txt"), "utf8"), "Original native Pi file\n");
}));
