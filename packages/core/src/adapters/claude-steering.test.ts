import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { AdapterSession, SendOptions } from "../adapter.js";
import { AgentInteractionBridge } from "../agent-interaction-bridge.js";
import { withPeerFixture, closePeerServer, type PeerFixture } from "../testing/peer-fixture.js";
import type { ProcessSupervisor } from "../process-supervisor.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { AdapterRegistry, SessionEngine } from "../session-engine.js";

function watchNative(scope:PeerFixture,session:AdapterSession){
  const runtime=(session as unknown as{current?:ProcessSupervisor;lastNative?:{supervisor:ProcessSupervisor}}).current
    ??(session as unknown as{lastNative?:{supervisor:ProcessSupervisor}}).lastNative?.supervisor;
  if(!runtime)return;
  scope.watch(runtime.child,true);
  scope.defer(async()=>{
    if(!runtime.hasStopped())await runtime.terminate();
    const deadline=Date.now()+5000;
    while(!runtime.hasStopped()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    if(!runtime.hasStopped())throw new Error("Owned Claude test process termination is unconfirmed");
  });
  return runtime.child;
}

async function response(res: ServerResponse, payload: any, content: any[], id: string, inputTokens = 100, afterStart?: () => Promise<void>) {
  const stop = content.some(part => part.type === "tool_use") ? "tool_use" : "end_turn";
  if (!payload.stream) throw new Error("Native streaming response is required for context-application confirmation");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (type: string, value: any) => res.write("event: " + type + "\ndata: " + JSON.stringify(value) + "\n\n");
  send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: payload.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  await afterStart?.();
  content.forEach((part, index) => {
    send("content_block_start", { type: "content_block_start", index, content_block: part.type === "tool_use" ? { type: "tool_use", id: part.id, name: part.name, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index, delta: part.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(part.input) } : { type: "text_delta", text: part.text } });
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send("message_stop", { type: "message_stop" }); res.end();
}

for (const phase of ["insert", "engine", "revoked", "headroom", "closed", "child", "resume", "mcp"] as const) test(`installed Claude current-turn ${phase} preserves one original native query`, {
  skip: !process.env.PHONON_TEST_CLAUDE_BIN, timeout: 45000,
}, () => withPeerFixture("claude-steering", async scope => {
  const root = scope.root, marker = "CURRENT_CLAUDE_" + randomUUID();
  writeFileSync(join(root, "input.txt"), "Actual current-task fixture\n");
  mkdirSync(join(root, "claude"));
  const previous = new Map(["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CLAUDECODE"].map(key => [key, process.env[key]]));
  process.env.HOME = root; process.env.USERPROFILE = root; process.env.CLAUDE_CONFIG_DIR = join(root, "claude"); delete process.env.CLAUDECODE;
  scope.defer(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const payloads: any[] = [], events: any[] = [], errors: unknown[] = [], sent: any[] = [], abort = new AbortController();
  let session: AdapterSession | undefined, insertion: Promise<void> | undefined, insertionState = "pending", raw = "";
  let engine:SessionEngine|undefined,engineSessionId:string|undefined,insertAck:any;
  const action = { operation: "send", requestId: randomUUID(), recipientId: randomUUID(), kind: "notice", text: "Native Claude MCP result" };
  const bridge = new AgentInteractionBridge(undefined, undefined, undefined, undefined, undefined, undefined, phase === "mcp" ? async input => {
    sent.push(input); return { status: "recorded", requestId: action.requestId };
  } : undefined);
  scope.defer(() => bridge.close()); const controllerEnvironment = phase === "mcp" ? await bridge.listen() : {};
  if (phase === "mcp") { mkdirSync(join(root, ".claude")); writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["mcp__phonon_current_turn__phonon_project_coordination"] } })); }
  const provider = createServer((req, res) => { void (async () => {
    if (req.method === "GET") { req.resume(); res.writeHead(200, { "Content-Type": "application/json" }).end("{}"); return; }
    let body = ""; for await (const chunk of req) body += String(chunk);
    if (new URL(req.url ?? "/", "http://local").pathname.endsWith("/count_tokens")) { res.writeHead(200, { "Content-Type": "application/json" }).end('{"input_tokens":100}'); return; }
    const payload = JSON.parse(body), main = payload.tools?.some((tool: any) => tool.name === "Read");
    if (!main) { await response(res, payload, [{ type: "text", text: "Fixture helper response" }], "helper"); return; }
    payloads.push(payload); const index = payloads.length;
    assert.ok(index <= (phase === "child" ? 4 : phase === "resume" ? 3 : 2), "no queued native execution may follow the original task");
    const receives = !["revoked","headroom", "closed", "mcp"].includes(phase) && index === (phase === "child" ? 4 : 2);
    assert.equal(body.includes(marker), receives, "input must enter only the original root model continuation");
    if (index === 1 && phase !== "mcp") {
      insertion = engine?engine.send("owner",engineSessionId!,marker,{turnId:"original-turn",expectedActiveTurnId:"original-turn",whenBusy:"inject"}).then(ack=>{insertAck=ack;}):session!.insertAtToolGap!(marker, { turnId: "original-turn", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
        ...(phase==="revoked"?{beforeApply(){throw new Error("original source revoked");}}:{}) });
      void insertion.then(() => { insertionState = "accepted"; }, () => { insertionState = "rejected"; });
    }
    const content = phase === "closed" || phase === "resume" && index === 3 ? [{ type: "text", text: "Original Claude task complete" }]
      : index === 1 && phase === "child" ? [{ type: "tool_use", id: "parent-task", name: "Task", input: { description: "Controlled child", subagent_type: "general-purpose", prompt: "Read input.txt once and finish", model: "sonnet" } }]
      : phase === "child" && index === 2 ? [{ type: "tool_use", id: "child-read", name: "Read", input: { file_path: join(root, "input.txt") } }]
      : index === 1 ? [{ type: "tool_use", id: "root-tool", name: phase === "mcp" ? "mcp__phonon_current_turn__phonon_project_coordination" : "Read", input: phase === "mcp" ? action : { file_path: join(root, "input.txt") } }]
      : [{ type: "text", text: phase === "child" && index === 3 ? "Child native task complete" : "Original Claude task complete" }];
    await response(res, payload, content, "main_" + index, phase === "headroom" ? 150000 : 100, receives ? async () => {
      await insertion; assert.equal(insertionState, "accepted"); assert.equal(events.some(event => event.final), false, "insertion is applied before original task completion");
    } : undefined);
  })().catch(error => { errors.push(error); abort.abort();if(engine&&engineSessionId)void engine.interrupt("owner",engineSessionId).catch(()=>{});res.destroy(); }); });
  scope.defer(() => closePeerServer(provider)); await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const adapter = new ClaudeCodeAdapter({ env: { binPath: process.env.PHONON_TEST_CLAUDE_BIN, defaultModel: "claude-sonnet-4-5-20250929", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, authToken: "controlled-claude-key" } });
  const discovered = await adapter.discoverAgents(); assert.equal(discovered[0]!.capabilities.injectMidTurn, true);
  const options: SendOptions = { turnId: "original-turn", verbosity: "tools", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]), emit: event => events.push(event),
    ...(phase === "mcp" ? { projectCoordination: async () => ({}) } : {}), environment: { ...controllerEnvironment, CLAUDE_CONFIG_DIR: join(root, "claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
      ...(phase === "headroom" ? { MAX_THINKING_TOKENS: "55000" } : {}) } };
  let run:Promise<unknown>;
  if(phase==="engine"){
    const registry=new AdapterRegistry();registry.register(adapter);const create=adapter.createSession.bind(adapter);adapter.createSession=async params=>session=await create(params);
    let ended!:()=>void;const terminal=new Promise<void>(resolve=>{ended=resolve;});
    engine=new SessionEngine(registry,event=>{events.push(event);if("final"in event&&event.final)ended();});scope.defer(()=>engine?.dispose());
    const owned=await engine.create({tenantId:"owner",project:"native-project",agent:"claude-code",model:"claude-sonnet-4-5-20250929",cwd:root,verbosity:"tools"});engineSessionId=owned.sessionId;
    await assert.rejects(engine.send("foreign",owned.sessionId,"borrowed",{turnId:"original-turn",whenBusy:"inject"}));
    await engine.send("owner",owned.sessionId,"Read input.txt and finish the original task.",{turnId:"original-turn",environment:options.environment});
    run=(async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([terminal,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Original Claude execution did not reach a terminal event")),30000);})]);
        await engine!.settleTurn("owner",owned.sessionId,"original-turn");
      }finally{clearTimeout(timer);}
    })();
  }else{
    session = await adapter.createSession({ sessionId: "owned", agentId: "claude-code", model: "claude-sonnet-4-5-20250929", cwd: root }); scope.defer(() => session?.terminate());
    run=session.send("Read input.txt and finish the original task.", options);
  }
  assert.ok(session);
  void run.catch(()=>{});
  const deadline = Date.now() + 5000; while (!(session as any).current && !events.some(event => event.final) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const native = watchNative(scope,session);native?.stdout?.on("data", (chunk: any) => { raw = (raw + String(chunk)).slice(-128000); });
  await run;
  assert.deepEqual(errors, []); assert.equal(events.at(-1)?.status, "completed", JSON.stringify(events));
  if (phase !== "mcp") { assert.ok(insertion); if (["revoked","headroom","closed"].includes(phase)) await assert.rejects(insertion); else await insertion; }
  if(phase==="engine")assert.deepEqual(insertAck,{turnId:"original-turn",disposition:"injected"});
  if (phase === "resume") {
    const nativeSession = session.peerContextCapability?.()?.nativeSessionId;
    const again = session.send("Continue the same native session.", { ...options, turnId: "next-turn", signal: AbortSignal.timeout(30000) });
    const end = Date.now() + 5000; while (!(session as any).current && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    watchNative(scope,session);await again;
    assert.equal(session.peerContextCapability?.()?.nativeSessionId, nativeSession); assert.equal(events.at(-1)?.status, "completed");
  }
  if (phase === "mcp") assert.deepEqual(sent, [{ ...action, references: [] }]);
  const results = raw.split("\n").flatMap(line => { try { const frame = JSON.parse(line); return frame.type === "result" ? [frame] : []; } catch { return []; } });
  assert.equal(results.length, 1, "one native SDK result per original task");
}));
