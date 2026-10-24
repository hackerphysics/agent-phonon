import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareCopilotPeerContext } from "./copilot-peer-context.js";
import { withPeerFixture } from "../testing/peer-fixture.js";
import {PeerContextJournal,PeerContextReceiver} from "../peer-context.js";
import type {ProjectCoordinationResult} from "@agent-phonon/protocol";

async function fixture(work: (value: any) => Promise<void>, prime = true) {
  await withPeerFixture("copilot-peer-unit", async scope => {
    const sessionId = randomUUID(), prompt = "Original assigned task\n";
    const environment = { AGENT_PHONON_PEER_CONTEXT_URL: "http://127.0.0.1:1/peer-context", AGENT_PHONON_PEER_CONTEXT_TOKEN: randomBytes(32).toString("base64url") };
    const access = { prepare: async () => { throw new Error("Use test checkpoint"); }, observe: () => {} };
    const asset = prepareCopilotPeerContext({ peerContext: access, turnId: "turn", verbosity: "tools", emit: () => {}, environment },
      { sessionId, cwd: scope.root, prompt });
    scope.defer(asset.cleanup);
    const module = await import(pathToFileURL(asset.modulePath).href);
    const state = { active: true, mail: true, tasks: [] as any[], permissions: [] as any[], response: undefined as any, beforeResponse: undefined as any,
      budget:{state:"known",source:"native_estimate",contextWindowTokens:128000,inputTokens:1000,outputTokens:4096,overheadTokens:1024} as any,budgetInputs:[] as any[] };
    const calls: any[] = [], message = { messageId: randomUUID(), content: "[Untrusted peer observation] synthetic peer data" };
    const checkpoint = async (path: string, input: any) => {
      calls.push({ path, input });
      if (state.beforeResponse) await state.beforeResponse(path, input);
      return path.endsWith("/observe") ? {} : state.response ?? { ...input, messages: state.mail ? [message] : [], deferred: [] };
    };
    const binding = module.createCopilotPeerHooks({ sessionId, cwd: scope.root, promptHash: createHash("sha256").update(prompt).digest("hex"),
      checkpoint, getNativeTasks: async () => state.tasks,getPendingPermissions:async()=>state.permissions,
      getNativeBudget:async(...input:any[])=>{state.budgetInputs.push(input);return structuredClone(state.budget);}, active: () => state.active });
    scope.defer(binding.deactivate);
    if (prime) {
      state.mail = false;
      await binding.hooks.onUserPromptSubmitted({ workingDirectory: scope.root, prompt }, { sessionId });
      calls.length = 0; state.mail = true;
    }
    const input = { workingDirectory: scope.root, timestamp: new Date(), toolName: "view", toolArgs: { path: join(scope.root, "input.txt") },
      toolResult: { textResultForLlm: "Original file bytes", resultType: "success" } };
    const start = (id: string, extra: any = {}) => binding.observe({ type: "tool.execution_start", data: { toolCallId: id, toolName: input.toolName, arguments: input.toolArgs }, ...extra });
    await work({ scope, asset, module, binding, state, calls, input, start, invocation: { sessionId }, prompt, message, environment });
    asset.cleanup(); assert.equal(existsSync(asset.path), false);
  });
}

test("Copilot peer hooks preserve native data and expose neither permission nor prompt mutation handlers", () => fixture(async f => {
  assert.deepEqual(Object.keys(f.binding.hooks).sort(), ["onPostToolUse", "onUserPromptSubmitted"]);
  f.start("owned-read"); const original = structuredClone(f.input);
  const result = await f.binding.hooks.onPostToolUse(f.input, f.invocation);
  assert.deepEqual(result, { additionalContext: f.message.content });
  assert.deepEqual(f.input, original);
  assert.deepEqual(f.calls.map((item: any) => item.path), ["/peer-context", "/peer-context/observe"]);
  assert.equal(f.calls[1].input.evidence, "context_hook");
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 2);
  assert.equal(readFileSync(f.asset.modulePath, "utf8").includes(f.environment.AGENT_PHONON_PEER_CONTEXT_TOKEN), false);
  assert.equal(readFileSync(join(dirname(f.asset.modulePath), "extension.mjs"), "utf8").includes(f.environment.AGENT_PHONON_PEER_CONTEXT_TOKEN), false);
}));

test("Copilot native budget checks current system/tool/message counters and actual configured output reserve",()=>fixture(async f=>{
  const usage={tokenLimit:128000,currentTokens:6000,systemTokens:1000,conversationTokens:3000,toolDefinitionsTokens:2000};
  const environment={COPILOT_PROVIDER_TYPE:"openai",COPILOT_PROVIDER_WIRE_API:"completions",COPILOT_PROVIDER_BASE_URL:"http://127.0.0.1:12345/v1",COPILOT_MODEL:"fixture",COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:"4096"};
  let current:any={modelId:"fixture"},info:any={modelName:"fixture",systemTokens:1000,conversationTokens:4000,toolDefinitionsTokens:2000,totalTokens:7000,promptTokenLimit:128000};
  const inputs:any[]=[],session={rpc:{model:{getCurrent:async()=>current,list:async()=>({list:[]})},metadata:{contextInfo:async(input:any)=>{inputs.push(input);return{contextInfo:info};}}}};
  const result=await f.module.readCopilotNativeBudget(session,usage,{textResultForLlm:"native result"},environment);
  assert.deepEqual(result,{state:"known",source:"native_estimate",contextWindowTokens:128000,inputTokens:7000+Buffer.byteLength(JSON.stringify({textResultForLlm:"native result"})),outputTokens:4096,outputReservation:"native_usable_window",overheadTokens:1024});
  assert.deepEqual(inputs,[{selectedModel:"fixture",promptTokenLimit:128000,outputTokenLimit:4096}]);
  const unknown={state:"unknown",source:"native_estimate"};
  for(const patch of [{COPILOT_MODEL:"other"},{COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:undefined},{COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:"0"},
    {COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:"4.5"},{COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:"129000"},{COPILOT_PROVIDER_MAX_PROMPT_TOKENS:"-1"},{COPILOT_PROVIDER_WIRE_API:"responses"},
    {COPILOT_PROVIDER_BASE_URL:"invalid"},{COPILOT_PROVIDER_BASE_URL:"http://user:secret@127.0.0.1/v1"}])
    assert.deepEqual(await f.module.readCopilotNativeBudget(session,usage,undefined,{...environment,...patch}),unknown);
  for(const patch of [{currentTokens:5999},{systemTokens:-1},{tokenLimit:0},{conversationTokens:undefined},{toolDefinitionsTokens:NaN}])
    assert.deepEqual(await f.module.readCopilotNativeBudget(session,{...usage,...patch},undefined,environment),unknown);
  assert.deepEqual(await f.module.readCopilotNativeBudget(session,undefined,undefined,environment),unknown);
  for(const patch of [{modelName:"other"},{totalTokens:6999},{promptTokenLimit:64000}]){
    const previous=info;info={...info,...patch};assert.deepEqual(await f.module.readCopilotNativeBudget(session,usage,undefined,environment),unknown);info=previous;
  }
  session.rpc.model.getCurrent=async()=>{const value=current;current={modelId:"switched"};return value;};
  assert.deepEqual(await f.module.readCopilotNativeBudget(session,usage,undefined,environment),unknown);
}));

test("Copilot catalog budgets require an exact native model and bounded positive output limits",()=>fixture(async f=>{
  const usage={tokenLimit:128000,currentTokens:6000,systemTokens:1000,conversationTokens:3000,toolDefinitionsTokens:2000};
  const model={id:"fixture",capabilities:{limits:{max_output_tokens:8192,max_prompt_tokens:100000,max_context_window_tokens:128000}}};
  let list:any[]=[model];const session={rpc:{model:{getCurrent:async()=>({modelId:"fixture"}),list:async()=>({list})},metadata:{contextInfo:async(input:any)=>({contextInfo:{modelName:"fixture",systemTokens:1000,conversationTokens:3000,toolDefinitionsTokens:2000,totalTokens:6000,promptTokenLimit:input.promptTokenLimit}})}}};
  const known=await f.module.readCopilotNativeBudget(session,usage,undefined,{});assert.equal(known.state,"known");assert.equal(known.contextWindowTokens,100000);assert.equal(known.outputTokens,8192);
  for(const value of [[],[model,model],[{...model,id:"other"}],[{id:"fixture",capabilities:{limits:{}}}]]){
    list=value;assert.equal((await f.module.readCopilotNativeBudget(session,usage,undefined,{})).state,"unknown");
  }
  session.rpc.model.getCurrent=async()=>new Promise(()=>{});
  assert.equal((await f.module.readCopilotNativeBudget(session,usage,undefined,{})).state,"unknown");
}));

test("Copilot budgets track root usage only, invalidate compaction and charge earlier peer context",()=>fixture(async f=>{
  const usage={tokenLimit:128000,currentTokens:6000,systemTokens:1000,conversationTokens:3000,toolDefinitionsTokens:2000};
  f.binding.observe({type:"session.usage_info",data:usage});
  f.binding.observe({type:"session.usage_info",agentId:"child",data:{...usage,currentTokens:1}});
  f.start("one");await f.binding.hooks.onPostToolUse(f.input,f.invocation);
  assert.deepEqual(f.state.budgetInputs.at(-1),[usage,f.input.toolResult]);
  const prior=f.calls.find((value:any)=>value.path==="/peer-context").input.budget.inputTokens;
  f.binding.observe({type:"tool.execution_complete",data:{toolCallId:"one"}});f.start("two");
  await f.binding.hooks.onPostToolUse(f.input,f.invocation);
  assert.ok(f.calls.filter((value:any)=>value.path==="/peer-context").at(-1).input.budget.inputTokens>prior);
  for(const type of ["session.compaction_start","session.compaction_complete","session.model_change","session.truncation"]){
    f.binding.observe({type,data:{}});f.binding.observe({type:"tool.execution_complete",data:{toolCallId:"two"}});f.start("two");
    await f.binding.hooks.onPostToolUse(f.input,f.invocation);assert.equal(f.state.budgetInputs.at(-1)[0],undefined);
  }
}));

test("Copilot budget capsule retains no provider secrets or credentials embedded in a URL",()=>fixture(async f=>{
  const asset=prepareCopilotPeerContext({turnId:"capsule",verbosity:"tools",emit:()=>{},peerContext:{prepare:async()=>{throw new Error("unused");},observe:()=>{}},
    environment:{...f.environment,COPILOT_PROVIDER_TYPE:"openai",COPILOT_PROVIDER_API_KEY:"not-a-real-provider-secret",COPILOT_PROVIDER_BASE_URL:"https://user:url-secret@example.test/v1?key=query-secret",
      COPILOT_MODEL:"fixture",COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:"4096"}},{sessionId:randomUUID(),cwd:f.scope.root,prompt:f.prompt});
  f.scope.defer(asset.cleanup);
  const raw=readFileSync(join(dirname(asset.modulePath),"channel.json"),"utf8"),capsule=JSON.parse(raw);
  for(const secret of ["not-a-real-provider-secret","url-secret","query-secret"])assert.equal(raw.includes(secret),false);
  assert.equal(capsule.budgetEnvironment.COPILOT_PROVIDER_BASE_URL,"");assert.equal(capsule.budgetEnvironment.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS,"4096");
}));

test("Copilot a native context change during budget or inbox lookup suppresses late projections",()=>fixture(async f=>{
  const usage={tokenLimit:128000,currentTokens:6000,systemTokens:1000,conversationTokens:3000,toolDefinitionsTokens:2000};
  f.binding.observe({type:"session.usage_info",data:usage});f.start("one");
  f.state.beforeResponse=(path:string)=>{if(path==="/peer-context")f.binding.observe({type:"session.compaction_start",data:{}});};
  assert.equal(await f.binding.hooks.onPostToolUse(f.input,f.invocation),undefined);assert.equal(f.calls.length,1);
  f.binding.observe({type:"session.usage_info",data:usage});f.binding.observe({type:"tool.execution_complete",data:{toolCallId:"one"}});f.start("two");
  f.state.beforeResponse=undefined;await f.binding.hooks.onPostToolUse(f.input,f.invocation);
  assert.equal(f.state.budgetInputs.at(-1)[0],undefined,"usage during active compaction is not a stable new baseline");
}));

test("Copilot required budgets preserve pending IDs through unknown/exhausted boundaries and later native recovery",()=>fixture(async f=>{
  const participant:NonNullable<ProjectCoordinationResult["self"]>={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"copilot",agentKind:"agent",sourceKind:"native",
    sessionId:"owned",label:"Copilot",activity:{summary:"",phase:"working",impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active"};
  const message:NonNullable<ProjectCoordinationResult["messages"]>[number]={id:randomUUID(),position:"2",senderId:randomUUID(),recipientId:participant.id,kind:"notice",text:"Native pending peer",references:[],inReplyTo:null,
    depth:0,createdAt:null,expiresAt:null,state:"stored",receivedAt:null};
  const journal=new PeerContextJournal(join(f.scope.root,"budget.sqlite"));f.scope.defer(()=>journal.close());
  const boundaries:any[]=[],receiver=new PeerContextReceiver({tenantId:"owner",sessionId:"owned",turnId:"budget",runId:randomUUID(),nativeSessionId:()=>f.invocation.sessionId,
    active:()=>true,requireBudget:true,journal,evidence:"context_hook",coordinate:async()=>({self:participant,messages:[message],next:null})});
  const budget={state:"known",source:"native_estimate",contextWindowTokens:64000,inputTokens:60000,outputTokens:4096,overheadTokens:1024};
  let known=false;
  const binding=f.module.createCopilotPeerHooks({sessionId:f.invocation.sessionId,cwd:f.scope.root,promptHash:createHash("sha256").update(f.prompt).digest("hex"),
    getNativeTasks:async()=>[],getPendingPermissions:async()=>[],getNativeBudget:async()=>known?structuredClone(budget):{state:"unknown",source:"native_estimate"},
    checkpoint:async(path:string,input:any)=>{if(path.endsWith("/observe")){receiver.observe(input);return{};}boundaries.push(input);return receiver.prepare(input);}});
  f.scope.defer(binding.deactivate);
  assert.equal(await binding.hooks.onUserPromptSubmitted({workingDirectory:f.scope.root,prompt:f.prompt},f.invocation),undefined);
  assert.deepEqual(journal.records("owner","owned"),[]);known=true;
  const invoke=async(id:string)=>{binding.observe({type:"tool.execution_start",data:{toolCallId:id,toolName:f.input.toolName,arguments:f.input.toolArgs}});
    const output=await binding.hooks.onPostToolUse(f.input,f.invocation);binding.observe({type:"tool.execution_complete",data:{toolCallId:id}});return output;};
  assert.equal(await invoke("full"),undefined);assert.deepEqual(journal.records("owner","owned"),[]);
  budget.inputTokens=1000;
  assert.ok((await invoke("recovered")).additionalContext.includes(message.text));
  assert.equal(journal.records("owner","owned")[0]?.state,"context_hook");
  assert.equal(await invoke("deduplicated"),undefined);assert.equal(journal.records("owner","owned").length,1);
  assert.equal(boundaries[0].budget.state,"unknown");assert.equal(boundaries[1].budget.inputTokens,60000);
}));

test("Copilot readiness requires this invocation's private native session and nonce", () => fixture(async f => {
  const ready = join(dirname(f.asset.modulePath), "native-ready.json"), channel = JSON.parse(readFileSync(join(dirname(f.asset.modulePath), "channel.json"), "utf8"));
  const proof = { version: 1, nativeSessionId: channel.sessionId, nativeProcessId: process.pid, nonce: channel.nonce };
  assert.equal(f.asset.isReady(), false);
  writeFileSync(ready, JSON.stringify({ ...proof, nonce: "wrong" }), { mode: 0o600 }); assert.equal(f.asset.isReady(), false);
  writeFileSync(ready, JSON.stringify({ ...proof, nativeSessionId: randomUUID() })); assert.equal(f.asset.isReady(), false);
  writeFileSync(ready, JSON.stringify(proof)); assert.equal(f.asset.isReady(), true);
  chmodSync(ready, 0o644); assert.equal(f.asset.isReady(), false);
  chmodSync(ready, 0o600); assert.equal(f.asset.isReady(), true);
  f.asset.deactivate(); assert.equal(f.asset.isReady(), false);
  assert.equal(existsSync(join(dirname(f.asset.modulePath), "channel.json")), false);
  writeFileSync(ready, JSON.stringify(proof)); assert.equal(f.asset.isReady(), false, "a late native proof cannot revive a closed admission slot");
  f.asset.cleanup(); assert.equal(f.asset.isReady(), false);
}));

test("Copilot outgoing tool authority is exact, one-shot and does not consume the later receive boundary", () => fixture(async f => {
  const args = { operation: "presence" }, invocation = { ...f.invocation, toolCallId: "coordination", toolName: "phonon_project_coordination" };
  f.binding.observe({ type: "tool.execution_start", data: { toolCallId: invocation.toolCallId, toolName: invocation.toolName, arguments: args } });
  assert.equal(await f.binding.authorizeTool({ ...invocation, sessionId: randomUUID() }, args), false);
  assert.equal(await f.binding.authorizeTool(invocation, { operation: "leave" }), false);
  assert.equal(await f.binding.authorizeTool({ ...invocation, toolCallId: "foreign" }, args), false);
  assert.equal(await f.binding.authorizeTool(invocation, args), true);
  assert.equal(await f.binding.authorizeTool(invocation, args), false);
  assert.deepEqual(await f.binding.hooks.onPostToolUse({ ...f.input, toolName: invocation.toolName, toolArgs: args }, f.invocation), { additionalContext: f.message.content });
}));

test("Copilot child and unscoped outgoing calls cannot impersonate their root's sender", () => fixture(async f => {
  const args = { operation: "presence" }, invocation = { ...f.invocation, toolCallId: "child-send", toolName: "phonon_project_coordination" };
  f.binding.observe({ type: "tool.execution_start", agentId: randomUUID(), data: { toolCallId: invocation.toolCallId, toolName: invocation.toolName, arguments: args } });
  assert.equal(await f.binding.authorizeTool(invocation, args), false);
  f.binding.observe({ type: "tool.execution_start", data: { toolCallId: "root-send", toolName: invocation.toolName, arguments: args } });
  f.state.tasks = [{ type: "agent", id: randomUUID(), toolCallId: "task", status: "running" }];
  assert.equal(await f.binding.authorizeTool({ ...invocation, toolCallId: "root-send" }, args), false);
  assert.equal(f.calls.length, 0);
}));

test("Copilot native pending approvals fence incoming and outgoing context without answering the human", () => fixture(async f => {
  const args = { operation: "presence" }, invocation = { ...f.invocation, toolCallId: "root-send", toolName: "phonon_project_coordination" };
  f.binding.observe({ type: "tool.execution_start", data: { toolCallId: invocation.toolCallId, toolName: invocation.toolName, arguments: args } });
  f.state.permissions = [{ requestId: "native-approval" }];
  assert.equal(await f.binding.authorizeTool(invocation, args), false); assert.equal(f.binding.isActive(), false);
  f.start("root-read"); assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
  f.state.permissions = []; f.binding.observe({ type: "permission.completed" });
  assert.equal(f.binding.isActive(), true);
  assert.equal(await f.binding.authorizeTool(invocation, args), true);
}));

test("Copilot original prompt is exact, one-shot, native-session and working-directory scoped", () => fixture(async f => {
  const invoke = f.binding.hooks.onUserPromptSubmitted, input = { workingDirectory: f.scope.root, prompt: f.prompt };
  assert.equal(await invoke({ ...input, prompt: f.prompt.trim() }, f.invocation), undefined);
  assert.equal(await invoke(input, { sessionId: randomUUID() }), undefined);
  assert.equal(await invoke({ ...input, workingDirectory: dirname(f.scope.root) }, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await invoke(input, f.invocation), { additionalContext: f.message.content });
  assert.equal(await invoke(input, f.invocation), undefined);
  assert.equal(f.calls.length, 2);
}, false));

test("Copilot startup idle is not the terminal event of the as-yet-unsubmitted owned task", () => fixture(async f => {
  f.binding.observe({ type: "assistant.idle" });
  assert.deepEqual(await f.binding.hooks.onUserPromptSubmitted({ workingDirectory: f.scope.root, prompt: f.prompt }, f.invocation), { additionalContext: f.message.content });
  f.binding.observe({ type: "assistant.idle" });
  f.start("late-read");
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 2);
}, false));

test("Copilot child activity cannot receive root mail even with the same session ID, cwd and tool arguments", () => fixture(async f => {
  f.start("root-read");
  const agentId = randomUUID(); f.binding.observe({ type: "subagent.started", agentId });
  f.start("child-read", { agentId, data: { toolCallId: "child-read", parentToolCallId: "root-task", toolName: f.input.toolName, arguments: f.input.toolArgs } });
  assert.equal(await f.binding.hooks.onUserPromptSubmitted({ workingDirectory: f.scope.root, prompt: f.prompt }, f.invocation), undefined);
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
  f.binding.observe({ type: "tool.execution_complete", agentId, data: { toolCallId: "child-read" } });
  f.binding.observe({ type: "subagent.completed", agentId });
  assert.deepEqual(await f.binding.hooks.onPostToolUse(f.input, f.invocation), { additionalContext: f.message.content });
}));

test("Copilot unknown, ambiguous, child and finished native tools do not receive context", () => fixture(async f => {
  const invoke = f.binding.hooks.onPostToolUse;
  assert.equal(await invoke(f.input, f.invocation), undefined);
  f.start("root-a"); f.start("root-b");
  assert.equal(await invoke(f.input, f.invocation), undefined);
  f.binding.observe({ type: "tool.execution_complete", data: { toolCallId: "root-a" } });
  f.binding.observe({ type: "tool.execution_complete", data: { toolCallId: "root-b" } });
  f.start("child", { agentId: randomUUID() });
  assert.equal(await invoke(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}));

test("Copilot root task receives after its child read even when the native child terminal event is late", () => fixture(async f => {
  const root = { ...f.input, toolName: "task", toolArgs: { name: "fixture-reader" } };
  f.binding.observe({ type: "tool.execution_start", data: { toolCallId: "root-task", toolName: root.toolName, arguments: root.toolArgs } });
  const agentId = randomUUID(); f.binding.observe({ type: "subagent.started", agentId });
  f.state.tasks = [{ type: "agent", id: agentId, toolCallId: "root-task", status: "running" }];
  f.start("child-read", { agentId, data: { toolCallId: "child-read", parentToolCallId: "root-task", toolName: f.input.toolName, arguments: f.input.toolArgs } });
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
  f.binding.observe({ type: "tool.execution_complete", agentId, data: { toolCallId: "child-read" } });
  root.toolResult = { ...root.toolResult, toolTelemetry: { restrictedProperties: { agent_id: agentId } } };
  f.state.tasks[0].status = "idle";
  assert.deepEqual(await f.binding.hooks.onPostToolUse(root, f.invocation), { additionalContext: f.message.content });
  f.binding.observe({ type: "tool.execution_complete", data: { toolCallId: "root-task" } });
  f.binding.observe({ type: "subagent.completed", agentId });
  assert.equal(f.calls.length, 2);
}));

test("Copilot authoritative native task state fences a child even before its notifications arrive", () => fixture(async f => {
  f.start("parent-read");
  f.state.tasks = [{ type: "agent", id: randomUUID(), toolCallId: "not-yet-observed-task", status: "running" }];
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}));

test("Copilot a child copying the original prompt cannot receive the initial parent context", () => fixture(async f => {
  f.state.tasks = [{ type: "agent", id: randomUUID(), toolCallId: "parent-task", status: "running" }];
  assert.equal(await f.binding.hooks.onUserPromptSubmitted({ workingDirectory: f.scope.root, prompt: f.prompt }, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}, false));

test("Copilot identical nested task arguments cannot borrow a root tool's authority", () => fixture(async f => {
  const root = { ...f.input, toolName: "task", toolArgs: { name: "identical" } }, childId = randomUUID();
  f.binding.observe({ type: "tool.execution_start", data: { toolCallId: "root-task", toolName: root.toolName, arguments: root.toolArgs } });
  f.state.tasks = [{ type: "agent", id: randomUUID(), toolCallId: "root-task", status: "running" }, { type: "agent", id: childId, toolCallId: "child-task", status: "idle" }];
  const childResult = { ...root.toolResult, toolTelemetry: { restrictedProperties: { agent_id: childId } } };
  assert.equal(await f.binding.hooks.onPostToolUse({ ...root, toolResult: childResult }, f.invocation), undefined);
  f.state.tasks[1].toolCallId = "root-task";
  assert.equal(await f.binding.hooks.onPostToolUse({ ...root, toolResult: childResult }, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}));

test("Copilot missing or oversized native task metadata closes receive admission without claiming delivery", () => fixture(async f => {
  f.start("parent-read"); f.state.tasks = Array.from({ length: 257 }, () => ({ type: "agent", id: randomUUID(), toolCallId: "task", status: "running" }));
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.binding.isActive(), false); assert.equal(f.calls.length, 0);
}));

test("Copilot parentToolCallId alone is enough to disqualify a child tool", () => fixture(async f => {
  f.start("child-read", { data: { toolCallId: "child-read", parentToolCallId: "root-task", toolName: f.input.toolName, arguments: f.input.toolArgs } });
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}));

for (const resultType of ["failure", "rejected", "denied", "timeout"]) {
  test(`Copilot ${resultType} tool outcome cannot carry collaboration or change native policy`, () => fixture(async f => {
    f.start("root-read");
    assert.equal(await f.binding.hooks.onPostToolUse({ ...f.input, toolResult: { ...f.input.toolResult, resultType } }, f.invocation), undefined);
    assert.equal(f.calls.length, 0);
  }));
}

test("Copilot closed and revoked turns cannot return context or record a stronger receipt", () => fixture(async f => {
  f.start("root-read");
  f.state.beforeResponse = (path: string) => { if (path === "/peer-context") f.state.active = false; };
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/peer-context");
  f.state.active = true; f.state.beforeResponse = undefined;
  f.start("later"); f.binding.observe({ type: "assistant.idle" });
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 1);
}));

test("Copilot child work beginning during a checkpoint suppresses its pending projection", () => fixture(async f => {
  f.start("root-read");
  f.state.beforeResponse = (path: string) => { if (path === "/peer-context") f.binding.observe({ type: "subagent.started", agentId: randomUUID() }); };
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 1);
}));

for (const invalid of ["foreign-session", "foreign-boundary", "oversized", "too-many"]) {
  test(`Copilot ${invalid} checkpoint response is rejected`, () => fixture(async f => {
    f.start("root-read");
    f.state.beforeResponse = (_path: string, input: any) => {
      f.state.response = { ...input, messages: [f.message], deferred: [], ...(invalid === "foreign-session" ? { nativeSessionId: randomUUID() }
        : invalid === "foreign-boundary" ? { boundaryId: randomUUID() }
        : invalid === "oversized" ? { messages: [{ ...f.message, content: "x".repeat(16001) }] }
        : { messages: Array.from({ length: 9 }, () => f.message) }) };
    };
    assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
    assert.equal(f.calls.length, 1);
  }));
}

test("Copilot missing native source identity fails closed", () => fixture(async f => {
  f.binding.observe({ type: "subagent.started" }); f.start("root-read");
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}));

test("Copilot native event-capacity overflow fails closed", () => fixture(async f => {
  for (let index = 0; index <= 256; index++) f.start("owned-" + index);
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}));

test("Copilot tool callbacks before the exact original prompt cannot drain current-turn mail", () => fixture(async f => {
  f.start("owned-read");
  assert.equal(await f.binding.hooks.onPostToolUse(f.input, f.invocation), undefined);
  assert.equal(f.calls.length, 0);
}, false));
