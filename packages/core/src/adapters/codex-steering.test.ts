import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CodexAdapter } from "./codex.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";
import type { AdapterSession } from "../adapter.js";
import { AgentInteractionBridge } from "../agent-interaction-bridge.js";
import { AdapterRegistry, SessionEngine } from "../session-engine.js";

function nativeResponse(res: import("node:http").ServerResponse, item: unknown, id: string) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const data of [{ type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]) res.write("data: " + JSON.stringify(data) + "\n\n");
  res.end();
}

for (const phase of ["baseline", "insert", "resume", "engine", "approval-allow", "approval-deny", "stop", "mcp", "mcp-resume"]) test(`installed Codex app-server ${phase} preserves its original task and native history`, {
  skip: !process.env.PHONON_TEST_CODEX_BIN, timeout: 45000,
}, () => withPeerFixture("codex-steering", async scope => {
  const root = scope.root, home = join(root, "native-home"); mkdirSync(home);
  const approval=phase.startsWith("approval")||phase==="stop",insert=phase==="insert"||phase==="resume"||phase==="engine",mcp=phase.startsWith("mcp");
  writeFileSync(join(home, "config.toml"), `approval_policy="${approval?"on-request":"never"}"\nmodel_context_window=128000\n[features]\nplugins=false\n`);
  const originalConfig = readFileSync(join(home, "config.toml"), "utf8"), marker = "INSERT_CODEX_" + randomUUID()+"_\u6d88\u606f";
  const payloads: any[] = [], events: any[] = [], errors: unknown[] = [];
  const abort=new AbortController();
  const humanRequests:any[]=[],humanApplied:string[]=[],sent:any[]=[];
  const human=async(input:any)=>{humanRequests.push(input);if(phase==="stop")abort.abort();return{requestId:input.requestId,action:"submit" as const,values:{decision:phase==="approval-deny"?"decline":"accept"}};};
  const applied=(id:string)=>{humanApplied.push(id);};
  const coordination=async(input:any)=>{sent.push(input);return{status:"recorded" as const,requestId:input.requestId};};
  const bridge=new AgentInteractionBridge(approval?human:undefined,approval?applied:undefined,undefined,undefined,undefined,undefined,mcp?coordination:undefined);
  scope.defer(()=>bridge.close());const bridgeEnvironment=approval||mcp?await bridge.listen():{};
  const action={operation:"send",requestId:randomUUID(),recipientId:randomUUID(),kind:"notice",text:"Actual native coordination"};
  let session: AdapterSession | undefined, insertion: Promise<void> | undefined;
  let engine:SessionEngine|undefined,engineSessionId:string|undefined,insertAck:any;
  const provider = createServer((req, res) => { void (async () => {
    if (req.method !== "POST") { req.resume(); res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "gpt-5.4" }] })); return; }
    let text = ""; for await (const chunk of req) text += String(chunk);
    const payload = JSON.parse(text); payloads.push(payload);
    assert.ok(payloads.length <= (phase==="mcp-resume"?4:phase === "resume" ? 3 : 2), "unexpected native inference request count");
    if (payloads.length === 1||phase==="mcp-resume"&&payloads.length===3) {
      assert.equal(text.includes(marker), false);
      if (insert) {
        insertion = engine?engine.send("owner",engineSessionId!,marker,{turnId:"original-turn",expectedActiveTurnId:"original-turn",whenBusy:"inject"}).then(ack=>{insertAck=ack;}):session!.insertAtToolGap!(marker, { turnId: "original-turn", signal: AbortSignal.timeout(30000) });
        void insertion.catch(() => {});
      }
      const names = payload.tools.map((tool: any) => tool.name),namespace=mcp?payload.tools.find((tool:any)=>tool.type==="namespace"&&tool.name==="mcp__phonon_current_turn"):undefined;
      const name = mcp?namespace?.tools?.find((tool:any)=>tool.name==="phonon_project_coordination")?.name:names.includes("exec_command") ? "exec_command" : "shell_command";
      assert.ok(name&&(namespace||names.includes(name)),"actual native tool catalog: "+JSON.stringify(names));
      nativeResponse(res, { type: "function_call", id: "fc_original", call_id: "call_original", name,...(namespace?{namespace:namespace.name}:{}),
        arguments: JSON.stringify(mcp?action:name === "exec_command" ? { cmd: "printf original-native-boundary",...(approval?{sandbox_permissions:"require_escalated",justification:"Controlled native approval check"}:{}) } : { command: "printf original-native-boundary" }) }, "response_"+payloads.length);
    } else {
      assert.equal(text.includes(marker), insert, "input must enter the actual original native context");
      if (insert) await insertion;
      if(mcp)assert.ok(text.includes("recorded"),"the real current-turn MCP result must reach the native model");
      nativeResponse(res, { type: "message", id: "msg_" + payloads.length, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Original Codex task complete", annotations: [] }] }, "response_" + payloads.length);
    }
  })().catch(error => { errors.push(error); abort.abort();if(engine&&engineSessionId)void engine.interrupt("owner",engineSessionId).catch(()=>{});res.destroy(); }); });
  scope.defer(() => closePeerServer(provider)); await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const adapter = new CodexAdapter({ env: { binPath: process.env.PHONON_TEST_CODEX_BIN, codexHome: home, defaultModel: "gpt-5.4",
    models: [{ id: "gpt-5.4", available: true, reasoningLevels: ["low", "standard"] }],
    baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, apiKey: "controlled-native-key" } });
  const inventory = await adapter.discoverAgents(); assert.equal(inventory[0]!.capabilities.injectMidTurn, true);
  if(phase==="engine"){
    const registry=new AdapterRegistry();registry.register(adapter);
    const create=adapter.createSession.bind(adapter);adapter.createSession=async params=>session=await create(params);
    engine=new SessionEngine(registry,event=>events.push(event));scope.defer(()=>engine?.dispose());
    const owned=await engine.create({tenantId:"owner",project:"native-project",agent:"codex",model:"gpt-5.4",cwd:root,verbosity:"tools"});engineSessionId=owned.sessionId;
    await assert.rejects(engine.send("foreign",owned.sessionId,"borrowed input",{turnId:"original-turn",whenBusy:"inject"}));
    await engine.send("owner",owned.sessionId,"Read the native tool boundary and finish.",{turnId:"original-turn"});
    const deadline=Date.now()+5000;while(!(session as any)?.current&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    scope.watch((session as any).current?.child,true);await engine.settleTurn("owner",owned.sessionId,"original-turn");
  }else{
    session = await adapter.createSession({ sessionId: "owned", agentId: "codex", model: "gpt-5.4", cwd: root }); scope.defer(() => session?.terminate());
    const run = session.send("Read the native tool boundary and finish.", { turnId: "original-turn", verbosity: "tools", signal: AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]), emit: event => events.push(event),environment:bridgeEnvironment,
      ...(approval?{requestInteraction:human,acknowledgeInteraction:applied}:{}),...(mcp?{projectCoordination:coordination}:{}) });
    scope.watch((session as any).current?.child, true); await run;
  }
  assert.ok(session);assert.deepEqual(errors, []);
  if(phase==="stop"){
    assert.equal(events.at(-1)?.status,"interrupted");assert.equal(payloads.length,1);assert.equal(humanRequests.length,1);assert.deepEqual(humanApplied,[]);
    assert.equal(await session.observeNativeStop?.("original-turn"),"process_tree_exit");return;
  }
  assert.equal(events.at(-1)?.status, "completed", JSON.stringify(events));
  assert.equal(payloads.length, 2); if (insert) await insertion;
  if(phase==="engine")assert.deepEqual(insertAck,{turnId:"original-turn",disposition:"injected"});
  const commandResults=events.filter(event=>event.type==="tool_result"&&event.toolName==="command_execution");
  if(approval){
    assert.equal(humanRequests.length,1);assert.equal(humanRequests[0].presentation.kind,"approval");assert.equal(commandResults[0]?.ok,phase==="approval-allow");
    // A generic native failure is not proof that a particular refusal receipt was applied.
    assert.equal(humanApplied.length,phase==="approval-allow"?1:0);
  }
  if(mcp)assert.deepEqual(sent,[{...action,references:[]}]);
  const checkpoint = session!.recoveryCheckpoint?.(); assert.ok(checkpoint?.threadId);
  if (phase === "resume") {
    const again = session!.send("Continue the same native session.", { turnId: "next-turn", verbosity: "tools", signal: AbortSignal.timeout(30000), emit: event => events.push(event) });
    scope.watch((session as any).current?.child, true); await again;
    assert.equal(events.at(-1)?.status, "completed", JSON.stringify(events)); assert.equal(session.recoveryCheckpoint?.()?.threadId, checkpoint.threadId);
  }
  if(phase==="mcp-resume"){
    await bridge.close();
    const fresh=new AgentInteractionBridge(undefined,undefined,undefined,undefined,undefined,undefined,coordination);scope.defer(()=>fresh.close());
    const environment=await fresh.listen();
    assert.notEqual(environment.AGENT_PHONON_INTERACTION_TOKEN,(bridgeEnvironment as Record<string,string>).AGENT_PHONON_INTERACTION_TOKEN);
    const again=session.send("Use the current controller and continue.",{turnId:"next-turn",verbosity:"tools",signal:AbortSignal.timeout(30000),emit:event=>events.push(event),environment,projectCoordination:coordination});
    scope.watch((session as any).current?.child,true);await again;
    assert.equal(events.at(-1)?.status,"completed",JSON.stringify(events));assert.equal(sent.length,2);assert.equal(payloads.length,4);
    assert.equal(session.recoveryCheckpoint?.()?.threadId,checkpoint.threadId);
  }
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), originalConfig);
}));
