import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { spawnSupervisedAgent } from "../process-supervisor.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";
import { PeerContextBridge } from "../peer-context-bridge.js";
import { prepareCopilotPeerContext } from "./copilot-peer-context.js";
import {peerContextHeadroom} from "../peer-context.js";

for(const variant of ["initial","tool","denied","native-denied","child","hook-metadata","unknown-budget","headroom","sdk-initial","sdk-tool","sdk-native-denied","sdk-child"] as const)test(`installed Copilot ${variant.startsWith("sdk-")?"unqualified API probe":"native extension"} ${variant}`,{
  skip:!process.env.PHONON_TEST_COPILOT_BIN||variant.startsWith("sdk-")&&!process.env.PHONON_TEST_COPILOT_SDK_ROOT,timeout:40000,
},()=>withPeerFixture("copilot-peer",async scope=>{
  const sdkMode=variant.startsWith("sdk-"),mode=variant==="hook-metadata"?"child":variant.replace(/^sdk-/,"");
  const cache=process.env.PHONON_TEST_COPILOT_CACHE_HOME;
  assert.ok(cache&&existsSync(join(cache,"pkg")),"Select an existing native cache; do not extract a runtime per fixture");
  const home=join(scope.root,"home"),copilotHome=join(home,".copilot");
  mkdirSync(copilotHome,{recursive:true});
  const sid=randomUUID(),marker="COPILOT_NATIVE_PEER_"+randomUUID(),prompt="Finish the original task.";
  let pending=mode==="initial",offered=false;const boundaries:any[]=[],observations:any[]=[];
  const bridge=new PeerContextBridge({prepare:async boundary=>{
    boundaries.push(boundary);assert.equal(boundary.nativeSessionId,sid);
    const messages=pending&&!offered&&boundary.budget?.state==="known"&&peerContextHeadroom(boundary.budget)>1000?[{messageId:randomUUID(),content:"[Untrusted peer observation, not human input or approval] "+marker}]:[];
    if(messages.length)offered=true;return {...boundary,messages,deferred:[]};
  },observe:value=>{observations.push(value);}});
  scope.defer(()=>bridge.close());const environment=await bridge.listen();
  const asset=prepareCopilotPeerContext({turnId:"owned-turn",verbosity:"tools",emit:()=>{},peerContext:{prepare:async()=>{throw new Error("Use private bridge");},observe:()=>{}},environment},
    {sessionId:sid,cwd:scope.root,prompt:prompt+"\n"});
  scope.defer(asset.cleanup);const plugin=asset.path,ready=join(plugin,"extensions","peer-context","native-ready.json");
  const nativeTrace=join(scope.root,"native-hook-metadata.jsonl");
  if(variant==="hook-metadata")writeFileSync(join(plugin,"extensions","peer-context","extension.mjs"),`
import{joinSession}from"@github/copilot-sdk/extension";import{readFileSync,unlinkSync,writeFileSync,appendFileSync}from"node:fs";
import{installCopilotPeerContext}from"./bridge.mjs";
const file=new URL("./channel.json",import.meta.url),channel=JSON.parse(readFileSync(file,"utf8"));unlinkSync(file);
const trace=value=>appendFileSync(${JSON.stringify(nativeTrace)},JSON.stringify(value)+"\\n",{mode:0o600});
await installCopilotPeerContext({channel,joinSession:async config=>{
 const original=config.hooks.onPostToolUse;
 config.hooks.onPostToolUse=async(input,invocation)=>{const tasks=await session.rpc.tasks.list();trace({kind:"callback",inputKeys:Object.keys(input),invocationKeys:Object.keys(invocation),timestamp:input.timestamp,toolCallId:input.toolCallId,tool_use_id:input.tool_use_id,agentId:input.agentId,parentToolCallId:input.parentToolCallId,toolName:input.toolName,telemetry:input.toolResult?.toolTelemetry,tasks:tasks.tasks?.map(task=>({type:task.type,id:task.id,toolCallId:task.toolCallId,status:task.status}))});
 const current=await session.rpc.model.getCurrent(),models=await session.rpc.model.list(),context=await session.rpc.metadata.contextInfo({promptTokenLimit:0,outputTokenLimit:0});
 trace({kind:"budget",toolName:input.toolName,current,models:models.list?.map(model=>({id:model.id,limits:model.capabilities?.limits})),context});return original(input,invocation);};
 const session=await joinSession(config);session.on(event=>{if(["hook.start","hook.end","assistant.turn_start","assistant.message_start","tool.execution_start","tool.execution_complete"].includes(event.type))trace({kind:"lifecycle",event});if(event.type==="session.usage_info")trace({kind:"usage",agentId:event.agentId,data:event.data});if(event.type==="hook.start"&&event.data?.hookType==="postToolUse")trace({kind:"event",agentId:event.agentId,id:event.id,hookInvocationId:event.data.hookInvocationId,inputKeys:Object.keys(event.data.input??{}),timestamp:event.data.input?.timestamp,toolCallId:event.data.input?.toolCallId,toolName:event.data.input?.toolName});});return session;
},onReady:value=>writeFileSync(new URL("./native-ready.json",import.meta.url),JSON.stringify(value),{mode:0o600})});
`,{mode:0o600});
  const inputPath=join(scope.root,"input.txt"),forbiddenPath=join(scope.root,"forbidden.txt"),fileText="ORIGINAL_NATIVE_FILE_"+randomUUID();writeFileSync(inputPath,fileText);
  writeFileSync(join(copilotHome,"settings.json"),JSON.stringify({model:"gpt-4.1"}));
  writeFileSync(join(copilotHome,"config.json"),JSON.stringify({model:"gpt-4.1",trustedFolders:[scope.root]}));
  const errors:unknown[]=[],requests:any[]=[];let readyProof:any;
  const provider=createServer((req,res)=>{
    void(async()=>{
      if(req.method!=="POST"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end('{"data":[]}');return;}
      let body="";for await(const chunk of req)body+=String(chunk);const payload=JSON.parse(body);requests.push(payload);
      if(existsSync(ready))readyProof=JSON.parse(readFileSync(ready,"utf8"));
      if(mode!=="initial")pending=true;
      assert.ok(requests.length<=5,"Native probe must not loop");
      const useTool=["initial","tool","native-denied","child","unknown-budget","headroom"].includes(mode)&&requests.length===1||mode==="child"&&requests.length===2;
      const toolName=mode==="child"&&requests.length===1?"task":mode==="native-denied"?"create":"view";
      const toolArgs=toolName==="task"?{name:"fixture-reader",agent_type:"general-purpose",description:"Read synthetic fixture",prompt:"Read the input fixture and report its bytes",model:"gpt-4.1"}:toolName==="create"?{path:forbiddenPath,file_text:"Must not be written"}:{path:inputPath};
      if(useTool)assert.ok(payload.tools?.some((item:any)=>item.function?.name===toolName),"Installed native tool missing: "+toolName);
      const message=useTool?{role:"assistant",content:null,tool_calls:[{id:toolName==="task"?"native-task":"native-read",type:"function",function:{name:toolName,arguments:JSON.stringify(toolArgs)}}]}:{role:"assistant",content:"Original Copilot task complete"};
      const finish=useTool?"tool_calls":"stop";
      if(payload.stream!==true){res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({id:"controlled",object:"chat.completion",created:1,model:payload.model,choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));return;}
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const send=(delta:any,finish_reason:string|null)=>res.write("data: "+JSON.stringify({id:"controlled",object:"chat.completion.chunk",created:1,model:payload.model,choices:[{index:0,delta,finish_reason}]})+"\n\n");
      send(useTool?{role:"assistant",tool_calls:[{index:0,...message.tool_calls![0]}]}:message,null);send({},finish);res.end("data: [DONE]\n\n");
    })().catch(error=>{errors.push(error);res.destroy();});
  });
  scope.defer(()=>closePeerServer(provider));await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const capsulePath=join(plugin,"extensions","peer-context","channel.json"),capsule=JSON.parse(readFileSync(capsulePath,"utf8"));
  capsule.budgetEnvironment={COPILOT_PROVIDER_TYPE:"openai",COPILOT_PROVIDER_WIRE_API:"completions",COPILOT_MODEL:"gpt-4.1",COPILOT_PROVIDER_MAX_PROMPT_TOKENS:variant==="hook-metadata"?"128000":"64000",COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:mode==="unknown-budget"?"":mode==="headroom"?"55000":"4096",COPILOT_PROVIDER_BASE_URL:`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`};writeFileSync(capsulePath,JSON.stringify(capsule),{mode:0o600});
  const sdkRunner=join(scope.root,"sdk-probe.mjs");
  if(sdkMode){
    const sdk=process.env.PHONON_TEST_COPILOT_SDK_ROOT;assert.ok(sdk&&existsSync(join(sdk,"index.js")),"Select the installed CLI's bundled SDK, without installing another copy");
    writeFileSync(sdkRunner,`
import{CopilotClient,RuntimeConnection}from${JSON.stringify(pathToFileURL(join(sdk,"index.js")).href)};
import{readFileSync,unlinkSync,writeFileSync}from"node:fs";
import{installCopilotPeerContext}from${JSON.stringify(pathToFileURL(asset.modulePath).href)};
const path=${JSON.stringify(join(plugin,"extensions","peer-context","channel.json"))};const channel=JSON.parse(readFileSync(path,"utf8"));unlinkSync(path);
process.env.SESSION_ID=channel.sessionId;
const client=new CopilotClient({connection:RuntimeConnection.forStdio({path:${JSON.stringify(process.env.PHONON_TEST_COPILOT_BIN)},args:["--no-auto-update","--no-remote","--no-remote-export","--disable-builtin-mcps"]}),workingDirectory:process.cwd(),env:{...process.env},useLoggedInUser:false});
let session,binding;
try{
binding=await installCopilotPeerContext({channel,joinSession:async({hooks})=>session=await client.createSession({sessionId:channel.sessionId,model:"gpt-4.1",provider:{type:"openai",baseUrl:process.env.COPILOT_PROVIDER_BASE_URL,apiKey:process.env.COPILOT_PROVIDER_API_KEY,wireApi:"completions"},workingDirectory:process.cwd(),enableConfigDiscovery:true,streaming:true,hooks,onPermissionRequest:()=>({kind:"reject"})}),onReady:value=>{writeFileSync(${JSON.stringify(ready)},JSON.stringify(value));process.stdout.write(JSON.stringify({type:"phonon.sdk.ready"})+"\\n");}});
session.on(event=>{if(!event.type.startsWith("model."))process.stdout.write(JSON.stringify(event)+"\\n");});
await session.rpc.name.set({name:"agent-phonon-probe"});
let prompt="";for await(const chunk of process.stdin)prompt+=String(chunk);
const result=await session.sendAndWait({prompt},15000);
if(!result||typeof result.data?.content!=="string"||!result.data.content.trim()){process.stderr.write("Native final result unconfirmed\\n");process.exitCode=1;}
else process.stdout.write(JSON.stringify({type:"result",sessionId:session.sessionId,text:result.data.content})+"\\n");
}catch(error){process.stderr.write(String(error)+"\\n");process.exitCode=1;}
finally{binding?.deactivate();await client.stop();}
`,{mode:0o600});
  }
  // Fixture-only consent for one extension; the SDK path receives no native permission grants.
  const native=spawnSupervisedAgent(sdkMode?process.execPath:process.env.PHONON_TEST_COPILOT_BIN!,sdkMode?[sdkRunner]:["--no-auto-update","--experimental","--plugin-dir",plugin,...(mode!=="denied"?["--allow-tool=extension-permission-access(plugin:agent-phonon:peer-context)"]:[]),...(mode==="native-denied"?["--deny-tool=write"]:[]),"--session-id",sid,"--output-format","json","--stream","on","--no-ask-user","--no-remote","--no-remote-export","--no-color","--disable-builtin-mcps"],{
    cwd:scope.root,env:{PATH:process.env.PATH,HOME:home,USERPROFILE:home,COPILOT_HOME:copilotHome,COPILOT_CACHE_HOME:cache,TMPDIR:scope.root,TMP:scope.root,TEMP:scope.root,
      COPILOT_OFFLINE:"true",COPILOT_PROVIDER_BASE_URL:`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`,COPILOT_PROVIDER_TYPE:"openai",COPILOT_PROVIDER_API_KEY:"controlled-local-key",
      COPILOT_PROVIDER_WIRE_API:"completions",COPILOT_MODEL:"gpt-4.1",COPILOT_PROVIDER_MAX_PROMPT_TOKENS:variant==="hook-metadata"?"128000":"64000",COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:mode==="unknown-budget"?"":mode==="headroom"?"55000":"4096",HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
  scope.watch(native.child,true);scope.defer(()=>native.terminate());let stdout="",stderr="",buffer="";const events:any[]=[];
  native.child.stdout.on("data",chunk=>{stdout=(stdout+String(chunk)).slice(-20000);buffer+=String(chunk);let nl:number;
    while((nl=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);
      let event:any;try{event=JSON.parse(line);}catch{continue;}
      if(!event.type?.startsWith("model.")&&events.length<256)events.push(event);
      if(sdkMode&&event.type==="phonon.sdk.ready"){if(requests.length)errors.push(new Error("Native readiness must not execute inference"));native.child.stdin.end(prompt+"\n");}
    }
  });native.child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-2000);});
  const closed=new Promise<number|null>((resolve,reject)=>{native.child.once("close",resolve);native.child.once("error",reject);});
  const timer=setTimeout(()=>{void native.terminate();},30000);scope.defer(()=>clearTimeout(timer));
  if(!sdkMode)native.child.stdin.end(prompt+"\n");
  const code=await closed;clearTimeout(timer);
  if(variant==="hook-metadata"){
    const records=readFileSync(nativeTrace,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const lifecycle=records.filter(record=>record.kind==="lifecycle").map(record=>record.event);
    const applied=lifecycle.findIndex(event=>event.type==="hook.end"&&event.data?.output?.additionalContext?.includes(marker));
    assert.ok(applied>=0);
    assert.equal(lifecycle[applied].agentId,undefined);assert.equal(lifecycle[applied].data.success,true);
    const accepted=lifecycle.findIndex((event,index)=>index>applied&&event.type==="tool.execution_complete"&&!event.agentId&&event.data?.result?.content?.includes(marker));
    assert.ok(accepted>applied);
    const continuation=lifecycle.find((event,index)=>index>accepted&&event.type==="assistant.turn_start"&&!event.agentId);
    assert.equal(continuation.data.interactionId,lifecycle[accepted].data.interactionId);
    assert.notEqual(continuation.data.turnId,lifecycle[accepted].data.turnId);
    const callbacks=records.filter(record=>record.kind==="callback");
    assert.equal(callbacks.length,2);
    assert.ok(callbacks.every(record=>!record.inputKeys.includes("toolCallId")&&record.invocationKeys.length===1));
    assert.ok(callbacks.some(record=>record.toolName==="view"&&record.tasks.some((task:any)=>task.type==="agent"&&task.status==="running")));
    const rootTask=callbacks.find(record=>record.toolName==="task");
    assert.ok(rootTask.tasks.some((task:any)=>task.id===rootTask.telemetry.restrictedProperties.agent_id&&task.toolCallId==="native-task"));
    assert.ok(records.some(record=>record.kind==="budget"&&record.context?.contextInfo),JSON.stringify(records.filter(record=>["budget","usage"].includes(record.kind))));
    assert.ok(records.some(record=>record.kind==="usage"&&!record.agentId&&record.data.systemTokens+record.data.conversationTokens+record.data.toolDefinitionsTokens===record.data.currentTokens));
    assert.ok(records.some(record=>record.kind==="usage"&&!record.agentId&&record.data.tokenLimit===128000),"native configured prompt window must be observed, not guessed");
  }
  const eventTypes=events.map(event=>event.type);
  const failures=stdout.split("\n").flatMap(line=>{try{const event=JSON.parse(line);return /error|failure/.test(event.type)?[{type:event.type,data:event.data}]:[];}catch{return [];}}).slice(-2);
  const logs=existsSync(join(copilotHome,"logs"))?readdirSync(join(copilotHome,"logs"),{recursive:true}).filter(name=>String(name).endsWith(".log")).flatMap(name=>readFileSync(join(copilotHome,"logs",String(name)),"utf8").split("\n").filter(line=>/extension|error|warn/i.test(line)).map(line=>line.slice(0,700))).slice(-15):[];
  const trace=events.filter(event=>event.type?.startsWith("tool.")||event.type?.startsWith("subagent.")).map(event=>({type:event.type,agentId:event.agentId,toolCallId:event.data?.toolCallId,parentToolCallId:event.data?.parentToolCallId,success:event.data?.success}));
  const diagnostic=JSON.stringify({code,eventTypes,failures,logs:logs.slice(-3),trace,stderr:stderr.slice(-2000),requests:requests.map(payload=>({model:payload.model,tools:payload.tools?.length,hasPeer:JSON.stringify(payload).includes(marker)})),ready:readyProof});
  if(sdkMode){
    // Direct API sessions need a separately qualified native permission bootstrap.
    assert.deepEqual(errors,[],diagnostic);assert.equal(code,mode==="child"?0:1,diagnostic);
    assert.ok(readyProof,diagnostic);assert.equal(readyProof.nativeSessionId,sid,diagnostic);
    assert.ok(events.some(event=>event.type==="permission.requested"),diagnostic);
    assert.ok(trace.some(event=>event.type==="tool.execution_complete"&&event.success===false),diagnostic);
    assert.equal(requests.some(payload=>JSON.stringify(payload).includes(marker)),false,diagnostic);
    assert.equal(observations.length,0,diagnostic);assert.equal(existsSync(forbiddenPath),false,diagnostic);
    if(mode==="child")assert.ok(trace.some(event=>event.type==="subagent.started"),diagnostic);
    asset.cleanup();assert.equal(existsSync(plugin),false);return;
  }
  assert.deepEqual(errors,[],diagnostic);assert.equal(code,0,diagnostic);assert.equal(!!readyProof,mode!=="denied",diagnostic);
  if(mode!=="denied")assert.equal(readyProof.nativeSessionId,sid,diagnostic);
  assert.equal(requests.some(payload=>JSON.stringify(payload).includes(marker)),!["denied","native-denied","unknown-budget","headroom"].includes(mode),diagnostic);assert.ok(stdout.includes("Original Copilot task complete"),diagnostic);
  assert.equal(existsSync(forbiddenPath),false,diagnostic);
  assert.equal(JSON.stringify(events.filter(event=>event.type==="user.message"||event.type==="assistant.message").map(event=>event.data?.content)).includes(marker),false,diagnostic);
  assert.equal(observations.length,["denied","native-denied","unknown-budget","headroom"].includes(mode)?0:1,diagnostic);
  assert.ok(observations.every(value=>value.evidence==="context_hook"),diagnostic);
  assert.equal(boundaries[0]?.budget?.state,mode==="denied"?undefined:"unknown",diagnostic);
  if(observations.length)assert.equal(boundaries.at(-1).budget.state,"known",diagnostic);
  if(mode==="unknown-budget")assert.ok(boundaries.every(row=>row.budget.state==="unknown"),diagnostic);
  if(mode==="headroom"){assert.equal(boundaries.at(-1).budget.state,"known",diagnostic);assert.equal(peerContextHeadroom(boundaries.at(-1).budget),0,diagnostic);}
  if(mode==="child"){
    assert.ok(trace.some(event=>event.type==="subagent.started"),diagnostic);
    assert.ok(trace.some(event=>event.type==="tool.execution_start"&&event.agentId&&event.parentToolCallId==="native-task"),diagnostic);
    assert.equal(requests.length,4,diagnostic);
    assert.deepEqual(requests.map(payload=>JSON.stringify(payload).includes(marker)),[false,false,false,true],diagnostic);
    assert.equal(boundaries.length,2,diagnostic);
  }
  if(mode==="tool"){
    assert.ok(JSON.stringify(requests.at(-1)).includes(fileText),diagnostic);
    assert.ok(trace.some(event=>event.type==="tool.execution_complete"&&event.success===true),diagnostic);
    assert.ok(trace.some(event=>event.type==="tool.execution_start"&&!event.agentId&&event.toolCallId==="native-read"),diagnostic);
    assert.equal(readFileSync(inputPath,"utf8"),fileText);
  }
  if(mode==="denied")assert.equal(boundaries.length,0,diagnostic);
  assert.equal(existsSync(join(plugin,"extensions","peer-context","channel.json")),false,diagnostic);
  asset.cleanup();assert.equal(existsSync(plugin),false);
}));
