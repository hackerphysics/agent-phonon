import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes, randomUUID} from "node:crypto";
import {request as httpRequest} from "node:http";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {AgentInteractionBridge} from "../../core/dist/agent-interaction-bridge.js";
import {codexNativeToolArgs} from "../../core/dist/adapters/codex-native-tools.js";
import type {SendOptions} from "@agent-phonon/core";
import {CodexAdapter} from "@agent-phonon/core";

const form = {title: "Review", fields: [{key: "approved", label: "Approve?", type: "boolean" as const, required: true}]};
const names = ["phonon_request_interaction", "phonon_acknowledge_interaction", "phonon_conversation_board", "phonon_workflow", "phonon_conversation_message", "phonon_publish_document"];
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise, resolve}; }
async function client(environment:Record<string,string>, token=environment.AGENT_PHONON_INTERACTION_TOKEN) {
  const value = new Client({name: "phonon-unit-fixture", version: "1"}, {capabilities: {}});
  const transport=new StreamableHTTPClientTransport(new URL(environment.AGENT_PHONON_MCP_URL!), {
    requestInit: {headers: {Authorization: "Bearer " + token}},
    reconnectionOptions: {maxRetries: 0, initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1}
  });
  try{await value.connect(transport,{timeout:3000});}catch(error){await transport.close();throw error;}
  return value;
}
function payload(result:any) { assert.notEqual(result.isError, true); return JSON.parse(result.content[0].text); }

test("native MCP exposes strict read-only group history and original-message chunks",async()=>{
  const conversationID=randomUUID(),projectID=randomUUID(),messageID=randomUUID(),calls:unknown[]=[];
  const message={id:messageID,historyOrder:"5",author:"assistant" as const,senderID:randomUUID(),senderName:"DE",createdAt:new Date().toISOString(),text:"Shared background",textLength:17,isExcerpt:false,mentionIDs:[],attachmentIDs:[]};
  const bridge=new AgentInteractionBridge(undefined,undefined,undefined,undefined,async input=>{
    calls.push(input);
    if(input.operation==="history")return {status:"history",conversationID,projectID,throughOrder:input.throughOrder??"9",messages:[message]};
    if(input.operation==="read")return {status:"message",conversationID,projectID,message,offset:input.offset??0};
    throw Error("No sends in this fixture");
  });
  let c:Client|undefined;
  try{
    c=await client(await bridge.listen());const tools=await c.listTools();assert.deepEqual(tools.tools.map(tool=>tool.name),["phonon_conversation_message"]);
    assert.match(tools.tools[0]!.description!,/read originating group history/);
    assert.equal(payload(await c.callTool({name:"phonon_conversation_message",arguments:{operation:"history",throughOrder:"9",beforeOrder:"8",limit:2}})).status,"history");
    assert.equal(payload(await c.callTool({name:"phonon_conversation_message",arguments:{operation:"read",messageID,offset:0}})).message.text,"Shared background");
    assert.equal((await c.callTool({name:"phonon_conversation_message",arguments:{operation:"history",conversationID:randomUUID()}})).isError,true);assert.equal(calls.length,2);
  }finally{await c?.close();await bridge.close();}
});

test("native MCP reuses scoped forms, explicit acknowledgement, board/workflow/message and document validation", async () => {
  const calls:Array<{route:string;input:any}>=[], applied:string[]=[], publication="native-file:"+randomUUID();
  const bridge = new AgentInteractionBridge(async input => {calls.push({route:"interaction",input}); return {requestId:input.requestId!, action:"submit", values:{approved:false}};},
    id=>{applied.push(id);},
    async input=>{calls.push({route:"board",input}); return {status:"ok",board:{conversationID:randomUUID(),goal:"Current",items:[],revision:1,authorID:"human",updatedAt:new Date().toISOString()}};},
    async input=>{calls.push({route:"workflow",input}); return {status:"catalog",data:{agents:[],roles:[],bindings:[]}};},
    async input=>{calls.push({route:"message",input});return {status:"not_accepted",requestId:randomUUID(),errorCode:"de_mentions_disabled"};},
    async input=>{calls.push({route:"document",input});return {delivered:[{name:input.path,ok:true,serverRef:publication}]};});
  const environment=await bridge.listen(), c=await client(environment);
  const post=(body:unknown)=>fetch(environment.AGENT_PHONON_INTERACTION_RECEIPT_URL!,{method:"POST",headers:{Authorization:"Bearer "+environment.AGENT_PHONON_INTERACTION_TOKEN,"Content-Type":"application/json"},body:JSON.stringify(body)});
  try {
    const catalog=await c.listTools(); assert.deepEqual(catalog.tools.map(tool=>tool.name),names);
    assert.ok(!JSON.stringify(catalog).includes(environment.AGENT_PHONON_INTERACTION_TOKEN!));
    const result=payload(await c.callTool({name:names[0]!,arguments:{requestId:"review-one",form}}));
    assert.equal(result.values.approved,false);assert.deepEqual(applied,[]);
    assert.equal((await post({requestId:result.requestId,decisionHash:result.decisionHash})).status,200);
    const second=payload(await c.callTool({name:names[0]!,arguments:{requestId:"review-two",form}}));
    payload(await c.callTool({name:names[1]!,arguments:{requestId:second.requestId,decisionHash:second.decisionHash}}));
    assert.deepEqual(applied,["review-one","review-two"]);
    assert.equal(payload(await c.callTool({name:names[2]!,arguments:{operation:"read"}})).board.goal,"Current");
    assert.equal(payload(await c.callTool({name:names[3]!,arguments:{operation:"catalog"}})).status,"catalog");
    assert.equal(payload(await c.callTool({name:names[4]!,arguments:{operation:"members"}})).status,"not_accepted");
    const id=randomUUID(), published=payload(await c.callTool({name:names[5]!,arguments:{requestId:id,path:"report.txt"}}));
    assert.equal(published.delivered[0].serverRef,publication);
    const count=calls.length;
    for (const bad of [{requestId:id,path:"../secret"},{requestId:id,path:"/etc/passwd"},{requestId:id,path:"report.txt",ownerUserId:"foreign"}]) {
      assert.equal((await c.callTool({name:names[5]!,arguments:bad})).isError,true);
    }
    assert.equal((await c.callTool({name:names[3]!,arguments:{operation:"catalog",nativeRunId:randomUUID()}})).isError,true);
    assert.equal((await c.callTool({name:"arbitrary_rpc",arguments:{}})).isError,true);assert.equal(calls.length,count);
  } finally {await c.close();await bridge.close();}
  await assert.rejects(client(environment));
});

test("coordination-only MCP exposes no human/group controls and revokes retained calls at turn end", async () => {
  const calls: unknown[] = [], participant = randomUUID();
  const bridge = new AgentInteractionBridge(undefined, undefined, undefined, undefined, undefined, undefined, async input => {
    calls.push(input); return { status: "left", participantId: participant };
  });
  const environment = await bridge.listen(), c = await client(environment);
  try {
    assert.deepEqual((await c.listTools()).tools.map(tool => tool.name), ["phonon_project_coordination"]);
    assert.equal(environment.AGENT_PHONON_INTERACTION_RECEIPT_URL, undefined);
    assert.equal(payload(await c.callTool({ name: "phonon_project_coordination", arguments: { operation: "leave" } })).participantId, participant);
    assert.equal((await c.callTool({ name: "phonon_request_interaction", arguments: { form } })).isError, true);
    assert.equal((await c.callTool({ name: "phonon_conversation_message", arguments: { operation: "members" } })).isError, true);
    const denied = await fetch(environment.AGENT_PHONON_INTERACTION_URL!, { method: "POST", headers: { authorization: "Bearer " + environment.AGENT_PHONON_INTERACTION_TOKEN }, body: JSON.stringify({ form }) });
    assert.equal(denied.status, 404); assert.equal(calls.length, 1);
    await bridge.close(); await assert.rejects(c.callTool({ name: "phonon_project_coordination", arguments: { operation: "leave" } }, undefined, { timeout: 1000 }));
    assert.equal(calls.length, 1);
  } finally { await c.close(); await bridge.close(); }
  assert.throws(() => new AgentInteractionBridge(undefined, () => {}), /matching acknowledgement/);
});

test("MCP rejects missing/foreign capabilities, browser origins, changed Host and oversized inputs without effects", async () => {
  let calls=0;
  const bridge=new AgentInteractionBridge(async input=>{calls++;return {requestId:input.requestId!,action:"cancel"};},()=>{});
  const env=await bridge.listen();
  const raw=(body:unknown,headers:Record<string,string>={})=>fetch(env.AGENT_PHONON_MCP_URL!,{method:"POST",headers:{Authorization:"Bearer "+env.AGENT_PHONON_INTERACTION_TOKEN,"Content-Type":"application/json",Accept:"application/json, text/event-stream",...headers},body:JSON.stringify(body)});
  try {
    const init={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"unit",version:"1"}}};
    assert.equal((await raw(init,{Authorization:"Bearer wrong"})).status,403);
    assert.equal((await raw(init,{Origin:"https://foreign.invalid"})).status,403);
    const hostStatus=await new Promise<number|undefined>((resolve,reject)=>{
      const req=httpRequest(env.AGENT_PHONON_MCP_URL!,{method:"POST",headers:{Host:"foreign.invalid",Authorization:"Bearer "+env.AGENT_PHONON_INTERACTION_TOKEN,"Content-Type":"application/json",Accept:"application/json, text/event-stream"}},res=>{res.resume();res.once("end",()=>resolve(res.statusCode));});
      req.once("error",reject);req.end(JSON.stringify(init));
    });
    assert.equal(hostStatus,403);
    assert.equal((await raw({value:"x".repeat(65537)})).status,413);
    assert.equal((await fetch(env.AGENT_PHONON_MCP_URL!)).status,404);
    const c=await client(env);try{assert.deepEqual((await c.listTools()).tools.map(tool=>tool.name),names.slice(0,2));}finally{await c.close();}
    assert.equal(calls,0);
  }finally{await bridge.close();}
});

test("HTTP and MCP share the pending budget, and ending a turn invalidates an in-flight result", {timeout:5000}, async () => {
  const release=deferred<void>(), reached=deferred<void>();let calls=0;
  const bridge=new AgentInteractionBridge(async input=>{calls++;if(calls===8)reached.resolve();await release.promise;return {requestId:input.requestId!,action:"submit",values:{approved:true}};},()=>{});
  const env=await bridge.listen(), c=await client(env);
  const pending=Array.from({length:8},(_,i)=>fetch(env.AGENT_PHONON_INTERACTION_URL!,{method:"POST",headers:{Authorization:"Bearer "+env.AGENT_PHONON_INTERACTION_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({requestId:"held-"+i,form})}).catch(()=>undefined));
  try {
    await reached.promise;
    assert.equal((await c.callTool({name:names[0]!,arguments:{requestId:"over-limit",form}})).isError,true);assert.equal(calls,8);
    await bridge.close(); release.resolve(); await Promise.all(pending);
    await assert.rejects(c.callTool({name:names[0]!,arguments:{form}},undefined,{timeout:1000}));
  } finally {release.resolve();await c.close();await bridge.close();}
});

test("closing an active MCP call cannot return a late approval or acknowledge it in another turn", {timeout:5000}, async () => {
  const reached=deferred<void>(), release=deferred<void>();let applied=0;
  const bridge=new AgentInteractionBridge(async input=>{reached.resolve();await release.promise;return {requestId:input.requestId!,action:"submit",values:{approved:true}};},()=>{applied++;});
  const env=await bridge.listen(), c=await client(env);
  const sending=c.callTool({name:names[0]!,arguments:{requestId:"late",form}},undefined,{timeout:2000}).catch(()=>undefined);
  try {
    await reached.promise;await bridge.close();release.resolve();
    const result=await sending;assert.ok(!result||result.isError);assert.equal(applied,0);
    await assert.rejects(client(env));
  }finally{release.resolve();await c.close();await bridge.close();}
});

test("a new turn accepts neither an old MCP bearer nor the old consumed-response proof", async () => {
  let applied=0;
  const old=new AgentInteractionBridge(async input=>({requestId:input.requestId!,action:"submit",values:{approved:false}}),()=>{});
  const oldEnv=await old.listen(), original=await client(oldEnv);
  const reply=payload(await original.callTool({name:names[0]!,arguments:{requestId:"same-id",form}}));
  await original.close();await old.close();
  const next=new AgentInteractionBridge(async input=>({requestId:input.requestId!,action:"cancel"}),()=>{applied++;});
  const env=await next.listen();
  try{
    await assert.rejects(client(env,oldEnv.AGENT_PHONON_INTERACTION_TOKEN));
    const current=await client(env);
    try{assert.equal((await current.callTool({name:names[1]!,arguments:{requestId:reply.requestId,decisionHash:reply.decisionHash}})).isError,true);assert.equal(applied,0);}
    finally{await current.close();}
  }finally{await next.close();}
});

test("Codex grants only current-turn controller tools including coordination, without token values or global sandbox/approval overrides", () => {
  const token=randomBytes(32).toString("base64url"), base={AGENT_PHONON_MCP_URL:"http://127.0.0.1:12345/mcp",AGENT_PHONON_INTERACTION_URL:"http://127.0.0.1:12345/interaction",AGENT_PHONON_INTERACTION_TOKEN:token};
  const options={turnId:"test",verbosity:"tools",emit(){},requestInteraction:async()=>({requestId:"test",action:"cancel"})} as SendOptions;
  assert.deepEqual(codexNativeToolArgs({...options,requestInteraction:undefined,environment:base}),[]);
  const args=codexNativeToolArgs({...options,environment:base}), value=args.join(" ");
  assert.equal(args[0],"-c"); assert.ok(value.includes("mcp_servers.phonon_current_turn="));assert.ok(value.includes("bearer_token_env_var"));
  assert.ok(!value.includes(token));assert.ok(!/sandbox|approval_policy|dangerously/.test(value));
  assert.deepEqual(args.filter(arg=>arg.includes(".approval_mode=")),names.slice(0,2).map(name=>`mcp_servers.phonon_current_turn.tools.${name}.approval_mode="approve"`));
  for (const override of [{AGENT_PHONON_MCP_URL:undefined},{AGENT_PHONON_MCP_URL:"http://remote.invalid/mcp"},{AGENT_PHONON_MCP_URL:"http://127.0.0.1:12346/mcp"},{AGENT_PHONON_MCP_URL:base.AGENT_PHONON_MCP_URL+"?leak="+token},{AGENT_PHONON_INTERACTION_TOKEN:"bad"}]) {
    assert.throws(()=>codexNativeToolArgs({...options,environment:{...base,...override} as Record<string,string>}),error=>!String(error).includes(token)&&/current-turn local MCP/.test(String(error)));
  }
  const coordination=codexNativeToolArgs({...options,requestInteraction:undefined,environment:base,projectCoordination:async()=>({})});
  assert.deepEqual(coordination.filter(arg=>arg.includes(".approval_mode=")),['mcp_servers.phonon_current_turn.tools.phonon_project_coordination.approval_mode="approve"']);
  assert.equal(coordination.join(" ").includes("phonon_request_interaction"),false);
  assert.equal(coordination.join(" ").includes("phonon_conversation_message"),false);
});

test("Codex MCP events keep actual arguments/results once per item and ignore private reasoning items", async () => {
  const adapter=new CodexAdapter({env:{defaultModel:"m1"}}),session=await adapter.createSession({sessionId:"unit-mcp",agentId:"codex",model:"m1",cwd:"/tmp"});
  const events:any[]=[];
  const consume=(type:string,item:Record<string,unknown>)=>(session as any).handleEvent({type,item},"turn",(event:any)=>events.push(event),()=>{});
  const item={id:"native-item",type:"mcp_tool_call",server:"phonon_current_turn",tool:"phonon_publish_document",arguments:{requestId:randomUUID(),path:"proof.txt"},status:"in_progress"};
  consume("item.started",item);consume("item.started",item);
  const result={content:[{type:"text",text:JSON.stringify({delivered:[{name:"proof.txt",ok:true,serverRef:"native-file:"+randomUUID()}]})}]};
  consume("item.completed",{...item,status:"completed",result,error:null});consume("item.completed",{...item,status:"completed",result,error:null});
  consume("item.completed",{type:"reasoning",text:"must not become a tool event"});
  assert.deepEqual(events.map(event=>event.type),["tool_call","tool_result"]);
  assert.deepEqual(events[0].args,item.arguments);assert.deepEqual(events[1].output,result);assert.equal(events[1].ok,true);
  consume("item.completed",{...item,id:"failed-item",status:"failed",error:{message:"tool failed"}});
  assert.equal(events.at(-1).type,"tool_result");assert.equal(events.at(-1).ok,false);
  await session.terminate();
});
