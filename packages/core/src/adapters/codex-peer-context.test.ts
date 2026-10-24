import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { CodexPeerContext, listCodexHooks, qualifyCodexPeerContext } from "./codex-peer-context.js";
import { PeerContextJournal, PeerContextReceiver } from "../peer-context.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";
import { spawnSupervisedAgent } from "../process-supervisor.js";
import { CodexAdapter } from "./codex.js";
import type { AdapterSession } from "../adapter.js";
import type { ChildProcess } from "node:child_process";
import {resolveCodexContextFile} from "./codex-context.js";

function response(res:ServerResponse,item:any,id:string,inputTokens=10) {
  res.writeHead(200,{"Content-Type":"text/event-stream"});
  const send=(data:any)=>res.write("data: "+JSON.stringify(data)+"\n\n");
  send({type:"response.created",response:{id,status:"in_progress",output:[]}});
  send({type:"response.output_item.added",output_index:0,item});send({type:"response.output_item.done",output_index:0,item});
  send({type:"response.completed",response:{id,status:"completed",output:[item],usage:{input_tokens:inputTokens,output_tokens:10,total_tokens:inputTokens+10}}});res.end();
}

async function fixture(work:(f:any)=>Promise<void>) {
  return withPeerFixture("codex-peer",async scope=>{
    const root=scope.root,journal=new PeerContextJournal(join(root,"peer.sqlite"));scope.defer(()=>journal.close());
    const self={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"codex",agentKind:"agent" as const,sourceKind:"native" as const,sessionId:"owned",label:"root",
      activity:{summary:"",phase:"working" as const,impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active" as const};
    const message={id:randomUUID(),position:"2",senderId:randomUUID(),recipientId:self.id,kind:"question" as const,text:"CODEX_PEER_"+randomUUID(),references:[],inReplyTo:null,depth:0,createdAt:null,expiresAt:null,state:"stored" as const,receivedAt:null};
    const state={native:randomUUID(),pending:false,active:true,inbox:0,blocked:false,session:undefined as AdapterSession|undefined};
    const receiver=new PeerContextReceiver({tenantId:"owner",sessionId:self.sessionId,turnId:"turn",runId:randomUUID(),nativeSessionId:()=>state.session?state.session.peerContextCapability?.()?.nativeSessionId:state.native,
      active:()=>scope.active&&state.active,blocked:()=>state.blocked,journal,evidence:"context_hook",coordinate:async action=>{
        assert.equal(action.operation,"inbox");state.inbox++;return {self,messages:state.pending?[message]:[],next:null};
      }});
    const asset=new CodexPeerContext({access:receiver,cwd:root,prompt:"Original task",onRuntime:runtime=>scope.watch(runtime.child,true)});
    scope.defer(()=>asset.close());await asset.listen();
    const call=async(input:any,headers:any={})=>{
      const environment=asset.environment();
      return (await fetch(environment.AGENT_PHONON_CODEX_PEER_URL!,{method:"POST",headers:{Authorization:"Bearer "+environment.AGENT_PHONON_CODEX_PEER_TOKEN,"Content-Type":"application/json",...headers},body:JSON.stringify(input)})).json();
    };
    const event={session_id:state.native,turn_id:"native-turn",cwd:root,transcript_path:join(root,"rollout-"+state.native+".jsonl")};
    await work({scope,root,journal,self,message,state,receiver,asset,call,event});
  });
}

test("Codex hook ingress binds only the observed root, exact original prompt and original native turn",()=>fixture(async f=>{
  const initial={...f.event,hook_event_name:"UserPromptSubmit",prompt:"Original task"};
  assert.deepEqual(await f.call(initial),{});assert.equal(f.state.inbox,0);
  f.asset.bindNativeThread(f.state.native);
  for(const patch of [{session_id:randomUUID()},{cwd:join(f.root,"absent")},{transcript_path:"child.jsonl"},{prompt:"Child task"}]){
    assert.deepEqual(await f.call({...initial,...patch}),{});
  }
  assert.equal(f.state.inbox,0);
  assert.deepEqual(await f.call(initial,{Authorization:"Bearer invalid"}),{});
  assert.deepEqual(await f.call(initial,{Origin:"https://untrusted.example"}),{});
  assert.deepEqual(await f.call(initial),{});assert.equal(f.state.inbox,1);
  f.state.pending=true;
  for(const input of [{...initial},{...f.event,hook_event_name:"PermissionRequest"},{...f.event,hook_event_name:"PostToolUse",turn_id:"other",tool_use_id:"read"}]){
    assert.deepEqual(await f.call(input),{});
  }
  const tool={...f.event,hook_event_name:"PostToolUse",tool_use_id:"root-read"};
  const output:any=await f.call(tool);
  assert.deepEqual(Object.keys(output),["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName,"PostToolUse");assert.ok(output.hookSpecificOutput.additionalContext.includes(f.message.text));
  assert.deepEqual(await f.call(tool),{});
  assert.equal(f.journal.records("owner","owned")[0]?.state,"context_hook");
  assert.throws(()=>f.asset.bindNativeThread(randomUUID()),/identity changed/);
  f.asset.deactivate();assert.throws(()=>f.asset.environment(),/unavailable/);
}));

test("Codex budgeted hook ingress defers missing usage and includes the current native tool response",()=>fixture(async f=>{
  const home=join(f.root,"budget-home"),directory=join(home,"sessions");mkdirSync(directory,{recursive:true});
  const file=join(directory,"rollout-"+f.state.native+".jsonl"),turn=f.event.turn_id;
  const meta={type:"session_meta",payload:{id:f.state.native,cwd:f.root}};
  const rows=[meta,{type:"event_msg",payload:{type:"task_started",turn_id:turn,model_context_window:100000}},
    {type:"turn_context",payload:{turn_id:turn,model:"fixture"}}];
  const write=(values:any[])=>writeFileSync(file,values.map(value=>JSON.stringify(value)).join("\n")+"\n");write(rows);
  const budgets:any[]=[],asset=new CodexPeerContext({access:{prepare:async(boundary,signal)=>{budgets.push(boundary.budget);return f.receiver.prepare(boundary,signal);},observe:value=>f.receiver.observe(value)},
    cwd:f.root,prompt:"Original task",nativeThread:f.state.native,context:{home,model:"fixture",notBefore:0}});
  f.scope.defer(()=>asset.close());await asset.listen();const environment=asset.environment();f.state.pending=true;
  const call=async(event:any)=>{
    const response=await fetch(environment.AGENT_PHONON_CODEX_PEER_URL!,{method:"POST",headers:{Authorization:"Bearer "+environment.AGENT_PHONON_CODEX_PEER_TOKEN,"Content-Type":"application/json"},
      body:JSON.stringify({...f.event,transcript_path:file,...event})});return response.json() as Promise<any>;
  };
  assert.deepEqual(await call({hook_event_name:"UserPromptSubmit",prompt:"Original task"}),{});assert.equal(budgets.at(-1).state,"unknown");
  const record={type:"token_usage_record",timestamp:new Date().toISOString(),payload:{thread_id:f.state.native,session_id:f.state.native,turn_id:turn,usage:{input_tokens:100,output_tokens:10,total_tokens:110}}};
  write([...rows,record]);
  assert.deepEqual(await call({hook_event_name:"PostToolUse",tool_use_id:"large",tool_response:"x".repeat(85000)}),{});
  assert.ok(budgets.at(-1).inputTokens>=85000);assert.deepEqual(f.journal.records("owner","owned"),[]);
  const result=await call({hook_event_name:"PostToolUse",tool_use_id:"small",tool_response:"small output"});
  assert.ok(result.hookSpecificOutput.additionalContext.includes(f.message.text));assert.equal(f.journal.records("owner","owned")[0]?.state,"context_hook");
  assert.equal(budgets.at(-1).outputReservation,"native_usable_window");
  const prior=budgets.at(-1).inputTokens;await call({hook_event_name:"PostToolUse",tool_use_id:"after-peer",tool_response:"small output"});
  assert.ok(budgets.at(-1).inputTokens>prior,"already offered peer text must remain charged even before native transcript flush");
  asset.deactivate();assert.deepEqual(await call({hook_event_name:"PostToolUse",tool_use_id:"closed"}),{});
}));

for(const phase of ["baseline","midturn","initial","denied","resume","headroom","unknown_budget"] as const)test(`installed Codex ${phase} completes its original task with native peer-context semantics`,{
  skip:!process.env.PHONON_TEST_CODEX_BIN,timeout:45000,
},()=>fixture(async f=>{
  const home=join(f.root,"native-home");mkdirSync(home);
  writeFileSync(join(home,"config.toml"),(phase==="unknown_budget"?"":"model_context_window = 128000\n")+"[features]\nplugins = false\n");
  const previous=new Map(["HOME","USERPROFILE"].map(key=>[key,process.env[key]]));
  process.env.HOME=f.root;process.env.USERPROFILE=f.root;
  f.scope.defer(()=>{for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  if(phase==="denied"){
    const hook=join(f.root,"native-deny.mjs"),command="'"+process.execPath.replace(/'/g,"'\\''")+"' '"+hook.replace(/'/g,"'\\''")+"'";
    writeFileSync(hook,'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Fixture native denial"}})));\n');
    const base=readFileSync(join(home,"config.toml"),"utf8")+'\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = '+JSON.stringify(command)+'\ntimeout = 3\n';
    writeFileSync(join(home,"config.toml"),base);
    const hooks=await listCodexHooks({bin:process.env.PHONON_TEST_CODEX_BIN!,args:[],cwd:f.root,env:{...process.env,CODEX_HOME:home},onRuntime:runtime=>f.scope.watch(runtime.child,true)});
    const own=hooks.filter(row=>row.command===command);assert.equal(own.length,1);
    writeFileSync(join(home,"config.toml"),base+'\n[hooks.state.'+JSON.stringify(own[0]!.key)+']\ntrusted_hash = '+JSON.stringify(own[0]!.currentHash)+'\n');
  }
  const originalConfig=readFileSync(join(home,"config.toml"),"utf8");
  f.state.pending=phase==="initial"||phase==="unknown_budget";
  const payloads:any[]=[],errors:unknown[]=[],observed:any[]=[],eventsOut:any[]=[],abort=new AbortController();
  const provider=createServer((req,res)=>{
    void(async()=>{
      if(req.method!=="POST"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end('{"data":[]}');return;}
      let body="";for await(const chunk of req)body+=String(chunk);
      const payload=JSON.parse(body);payloads.push(payload);
      const first=(payloads.length-1)%2===0;
      assert.ok(payloads.length<=(phase==="resume"?4:2),"unexpected native inference loop");
      if(phase!=="denied")assert.equal(body.includes(f.message.text),["initial","midturn","resume"].includes(phase)&&!first,"peer data must wait for this turn's known native budget");
      assert.equal(req.headers.authorization,"Bearer controlled-codex-key");
      let item:any;
      if(first&&phase==="unknown_budget"){
        item={type:"message",id:"msg_no_boundary",role:"assistant",status:"completed",content:[{type:"output_text",text:"Original Codex task complete",annotations:[]}]};
      }else if(first){
        const names=(payload.tools??[]).map((tool:any)=>tool.name),name=names.includes("exec_command")?"exec_command":"shell_command";
        assert.ok(names.includes(name),"native shell tool unavailable: "+names.join(","));
        const command="printf actual-native-bytes > native-effect.txt; printf native-codex-boundary; if [ -n \"$AGENT_PHONON_CODEX_PEER_TOKEN\" ]; then printf LEAKED_PEER_CAPABILITY; fi";
        item={type:"function_call",id:"fc_read_"+payloads.length,call_id:"call_read_"+payloads.length,name,arguments:JSON.stringify(name==="exec_command"?{cmd:command}:{command})};
        f.state.pending=true;
      }else{
        const output=payload.input.findLast((row:any)=>row.type==="function_call_output");
        assert.ok(output,"native command must produce an actual tool result");
        assert.ok(String(output.output).includes(phase==="denied"?"Fixture native denial":"native-codex-boundary"));
        if(phase!=="denied")assert.equal(String(output.output).includes("LEAKED_PEER_CAPABILITY"),false,"native tool environment must not receive hook capability");
        item={type:"message",id:"msg_final_"+payloads.length,role:"assistant",status:"completed",content:[{type:"output_text",text:"Original Codex task complete",annotations:[]}]};
      }
      response(res,item,"resp_"+payloads.length,phase==="headroom"?100000:10);
    })().catch(error=>{errors.push(error);abort.abort();res.destroy();});
  });
  f.scope.defer(()=>closePeerServer(provider));await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const adapter=new CodexAdapter({env:{binPath:process.env.PHONON_TEST_CODEX_BIN!,codexHome:home,baseUrl:`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`,apiKey:"controlled-codex-key",defaultModel:"gpt-5.4"}});
  const session=await adapter.createSession({sessionId:f.self.sessionId,agentId:"codex",model:"gpt-5.4",cwd:f.root});
  f.state.session=session;f.scope.defer(()=>session.terminate());
  let stdout="",stderr="";const watched=new Set<ChildProcess>();
  const watch=()=>{
    const native=(session as unknown as{current?:{child:ChildProcess}}).current?.child;
    if(!native||watched.has(native))return;watched.add(native);f.scope.watch(native,true);
    native.stdout?.on("data",chunk=>{stdout=(stdout+String(chunk)).slice(-30000);});native.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-20000);});
  };
  const monitor=setInterval(watch,5);f.scope.defer(()=>clearInterval(monitor));
  await session.preparePeerContext?.();assert.ok(session.peerContextCapability?.());
  let receiver:PeerContextReceiver=f.receiver,originalNative:string|undefined;
  const boundaryDiagnostics:any[]=[];
  const access={prepare:async(...args:Parameters<PeerContextReceiver["prepare"]>)=>{
    const file=await resolveCodexContextFile(home,session.peerContextCapability?.()?.nativeSessionId??"");
    boundaryDiagnostics.push({budget:args[0].budget,rows:file?readFileSync(file,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)).map(row=>({type:row.type,event:row.payload?.type,model:row.payload?.model,turnId:row.payload?.turn_id})):[]});
    return receiver.prepare(...args);
  },observe:(input:any)=>{observed.push(input);receiver.observe(input);}};
  for(let round=0;round<(phase==="resume"?2:1);round++){
    const turnId=round?"resumed-turn":"turn";
    if(round){
      f.message.id=randomUUID();f.message.text="CODEX_PEER_RESUME_"+randomUUID();f.state.pending=false;
      receiver=new PeerContextReceiver({tenantId:"owner",sessionId:f.self.sessionId,turnId,runId:randomUUID(),nativeSessionId:()=>session.peerContextCapability?.()?.nativeSessionId,
        active:()=>f.scope.active&&f.state.active,journal:f.journal,evidence:"context_hook",coordinate:async action=>{assert.equal(action.operation,"inbox");f.state.inbox++;return {self:f.self,messages:f.state.pending?[f.message]:[],next:null};}});
      await session.preparePeerContext?.();
    }
    await session.send("Run printf once and finish the original task.",{turnId,verbosity:"tools",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]),emit:event=>eventsOut.push(event),
      ...(phase==="baseline"?{}:{peerContext:access}),environment:{HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
    const native=session.peerContextCapability?.()?.nativeSessionId;
    if(round)assert.equal(native,originalNative,"peer receive must resume the original native root");else originalNative=native;
  }
  watch();clearInterval(monitor);
  const transcript=await resolveCodexContextFile(home,session.peerContextCapability?.()?.nativeSessionId??"");
  const nativeContext=transcript?readFileSync(transcript,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(row=>["turn_context","event_msg"].includes(row.type))
    .map(row=>({type:row.type,event:row.payload?.type,model:row.payload?.model,turnId:row.payload?.turn_id,info:row.payload?.info})):[];
  const diagnostic=JSON.stringify({events:eventsOut,errors:errors.map(String),requests:payloads.length,inbox:f.state.inbox,observed,nativeContext,boundaryDiagnostics});
  assert.deepEqual(errors,[],diagnostic);assert.equal(eventsOut.at(-1)?.status,"completed",diagnostic);
  assert.equal(eventsOut.at(-1).text,"Original Codex task complete");assert.equal(payloads.length,phase==="resume"?4:phase==="unknown_budget"?1:2);
  assert.equal(JSON.stringify(eventsOut).includes(f.message.text),false,"peer data must not become a human stream event");
  assert.equal(stdout.includes(f.message.text),false,"peer body must not be echoed into native exec output");
  if(phase!=="denied")assert.equal(f.journal.records("owner","owned")[0]?.state,["baseline","headroom","unknown_budget"].includes(phase)?undefined:"context_hook");
  if(phase!=="baseline")assert.equal(boundaryDiagnostics[0]?.budget?.state,"unknown","initial automatic mail must wait rather than guess native usage");
  if(phase==="headroom")assert.equal(boundaryDiagnostics.at(-1)?.budget?.state,"known");
  if(phase==="unknown_budget")assert.ok(boundaryDiagnostics.every(row=>row.budget?.state==="unknown"));
  if(phase==="resume")assert.equal(f.journal.records("owner","owned").length,2);
  assert.equal(existsSync(join(f.root,"native-effect.txt")),phase!=="denied"&&phase!=="unknown_budget","a native policy denial must still prevent the command");
  assert.equal(readFileSync(join(home,"config.toml"),"utf8"),originalConfig);
}));

test("installed Codex keeps newly pending parent mail out of actual native child requests",{
  skip:!process.env.PHONON_TEST_CODEX_BIN,timeout:45000,
},()=>fixture(async f=>{
  const home=join(f.root,"child-home");mkdirSync(home);writeFileSync(join(home,"config.toml"),"model_context_window = 128000\n[features]\nplugins = false\nmulti_agent = true\n");
  const previous=new Map(["HOME","USERPROFILE"].map(key=>[key,process.env[key]]));process.env.HOME=f.root;process.env.USERPROFILE=f.root;
  f.scope.defer(()=>{for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const abort=new AbortController(),errors:unknown[]=[],requests:any[]=[],out:any[]=[];
  let rootRequests=0,childRequests=0;
  const text=(value:string)=>({type:"message",id:"msg_"+requests.length,role:"assistant",status:"completed",content:[{type:"output_text",text:value,annotations:[]}]});
  const tool=(name:string,args:unknown,id:string)=>({type:"function_call",id:"fc_"+id,call_id:id,name,arguments:JSON.stringify(args)});
  const provider=createServer((req,res)=>{
    void(async()=>{
      if(req.method!=="POST"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end('{"data":[]}');return;}
      let body="";for await(const chunk of req)body+=String(chunk);const payload=JSON.parse(body);
      const nativeTools=payload.tools.flatMap((entry:any)=>entry.type==="namespace"?entry.tools.map((nested:any)=>({...nested,namespace:entry.name})):[entry]);
      const lastUser=payload.input.filter((item:any)=>item.role==="user").at(-1),child=JSON.stringify(lastUser).includes("PHONON_CHILD_TASK");
      requests.push({child,lastUser,names:(payload.tools??[]).map((item:any)=>item.name)});assert.ok(requests.length<=5,"unexpected delegated inference loop");
      assert.equal(body.includes(f.message.text),!child&&rootRequests>0,"new mail belongs only to the original parent continuation");
      let item:any;
      if(child){
        childRequests++;
        if(childRequests===1){
          const names=requests.at(-1).names,name=names.includes("exec_command")?"exec_command":"shell_command";
          assert.ok(names.includes(name));item=tool(name,name==="exec_command"?{cmd:"printf native-child-boundary"}:{command:"printf native-child-boundary"},"child-read");
        }else{assert.equal(childRequests,2);assert.ok(body.includes("native-child-boundary"));item=text("CHILD_TASK_COMPLETE");}
      }else{
        rootRequests++;
        if(rootRequests===1){
          const spawn=nativeTools.find((entry:any)=>entry.name==="spawn_agent");assert.ok(spawn);f.state.pending=true;
          item={...tool(spawn.name,{message:"PHONON_CHILD_TASK: Run printf once and reply CHILD_TASK_COMPLETE."},"root-spawn"),namespace:spawn.namespace};
        }else if(rootRequests===2){
          const output=payload.input.find((entry:any)=>entry.type==="function_call_output"&&entry.call_id==="root-spawn");
          const id=JSON.parse(output.output).agent_id;assert.equal(typeof id,"string",JSON.stringify(output));
          const wait=nativeTools.find((entry:any)=>entry.name==="wait_agent"||entry.name==="wait");assert.ok(wait);
          const args=wait.parameters.properties.targets?{targets:[id],timeout_ms:10000}:{ids:[id],timeout_ms:10000};item={...tool(wait.name,args,"root-wait"),namespace:wait.namespace};
        }else{assert.equal(rootRequests,3);assert.ok(body.includes("CHILD_TASK_COMPLETE"));item=text("Original Codex child task complete");}
      }
      response(res,item,"child_resp_"+requests.length);
    })().catch(error=>{errors.push(error);abort.abort();res.destroy();});
  });
  f.scope.defer(()=>closePeerServer(provider));await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const adapter=new CodexAdapter({env:{binPath:process.env.PHONON_TEST_CODEX_BIN!,codexHome:home,baseUrl:`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`,apiKey:"controlled-codex-key",defaultModel:"gpt-5.4"}});
  const session=await adapter.createSession({sessionId:f.self.sessionId,agentId:"codex",model:"gpt-5.4",cwd:f.root});f.state.session=session;f.scope.defer(()=>session.terminate());
  const watched=new Set<ChildProcess>();let stderr="";
  const monitor=setInterval(()=>{const native=(session as unknown as{current?:{child:ChildProcess}}).current?.child;
    if(native&&!watched.has(native)){watched.add(native);f.scope.watch(native,true);native.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-12000);});}},5);
  f.scope.defer(()=>clearInterval(monitor));await session.preparePeerContext?.();assert.ok(session.peerContextCapability?.());
  await session.send("Delegate one child task, wait for the child to finish, and then finish the original task.",{turnId:"turn",verbosity:"tools",peerContext:f.receiver,
    signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]),emit:event=>out.push(event),environment:{HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
  clearInterval(monitor);const diagnostic=JSON.stringify({errors:errors.map(String),requests,out,stderr});
  assert.deepEqual(errors,[],diagnostic);assert.equal(out.at(-1)?.status,"completed",diagnostic);
  assert.equal(rootRequests,3);assert.equal(childRequests,2);assert.equal(out.at(-1).text,"Original Codex child task complete");
  assert.equal(f.state.inbox,3,"native child hooks must not drain the parent's inbox");
  assert.equal(f.journal.records("owner","owned").length,1);assert.equal(f.journal.records("owner","owned")[0]?.nativeSessionId,session.peerContextCapability?.()?.nativeSessionId);
  assert.equal(JSON.stringify(out).includes(f.message.text),false);
}));

test("Codex hook client returns context only and does not put credentials in generated source",()=>fixture(async f=>{
  f.asset.bindNativeThread(f.state.native);f.state.pending=true;
  const environment=f.asset.environment(),path=join(f.asset.directory,"hook.mjs");
  assert.equal(readFileSync(path,"utf8").includes(environment.AGENT_PHONON_CODEX_PEER_TOKEN),false);
  const runtime=spawnSupervisedAgent(process.execPath,[path],{cwd:f.root,env:{...process.env,...environment}});
  f.scope.watch(runtime.child,true);f.scope.defer(()=>runtime.terminate());
  let out="",err="";runtime.child.stdout.on("data",chunk=>{out+=String(chunk);});runtime.child.stderr.on("data",chunk=>{err+=String(chunk);});
  const closed=new Promise(resolve=>runtime.child.once("close",resolve));
  runtime.child.stdin.end(JSON.stringify({...f.event,hook_event_name:"UserPromptSubmit",prompt:"Original task"}));
  assert.equal(await closed,0,err);assert.equal(err,"");
  assert.ok(JSON.parse(out).hookSpecificOutput.additionalContext.includes(f.message.text));
  const directory=f.asset.directory;await f.asset.close();assert.equal(existsSync(directory),false);
}));

test("Codex pending human decisions and closed current-turn authority cannot drain peer messages",()=>fixture(async f=>{
  f.asset.bindNativeThread(f.state.native);f.state.blocked=true;f.state.pending=true;
  assert.deepEqual(await f.call({...f.event,hook_event_name:"UserPromptSubmit",prompt:"Original task"}),{});
  assert.equal(f.state.inbox,0);f.state.blocked=false;
  f.state.active=false;
  assert.deepEqual(await f.call({...f.event,hook_event_name:"PostToolUse",tool_use_id:"later"}),{});assert.equal(f.state.inbox,0);
}));

for(const disabled of [false,true])test(`installed Codex native hook discovery ${disabled?"honors disabled hooks":"trusts only the invocation's own exact hook hashes"}`,{
  skip:!process.env.PHONON_TEST_CODEX_BIN,timeout:30000,
},()=>fixture(async f=>{
  const home=join(f.root,"home"),codexHome=join(home,".codex");mkdirSync(codexHome,{recursive:true});
  const config="[features]\nplugins = false\n"+(disabled?"hooks = false\n":'[[hooks.PostToolUse]]\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = "printf existing-hook-not-auto-trusted"\n');
  writeFileSync(join(codexHome,"config.toml"),config);
  const env={...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:codexHome,HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:""};
  assert.equal(await qualifyCodexPeerContext(process.env.PHONON_TEST_CODEX_BIN!),true);
  assert.equal(await qualifyCodexPeerContext(process.env.PHONON_TEST_CODEX_BIN!,{cwd:f.root,env,onRuntime:runtime=>f.scope.watch(runtime.child,true)}),!disabled);
  if(disabled){await assert.rejects(f.asset.nativeArguments(process.env.PHONON_TEST_CODEX_BIN!,env),/could not be qualified/);}
  else{
    const before=await listCodexHooks({bin:process.env.PHONON_TEST_CODEX_BIN!,args:f.asset.definitionArguments(),cwd:f.root,env,onRuntime:runtime=>f.scope.watch(runtime.child,true)});
    let args:string[];
    try{args=await f.asset.nativeArguments(process.env.PHONON_TEST_CODEX_BIN!,env);}catch(error){assert.fail(String(error)+"\n"+JSON.stringify(before));}
    assert.equal(args.some((value:string)=>/bypass|features\.hooks|approval_policy|sandbox_mode/.test(value)),false);
    const hooks=await listCodexHooks({bin:process.env.PHONON_TEST_CODEX_BIN!,args,cwd:f.root,env,onRuntime:runtime=>f.scope.watch(runtime.child,true)});
    const existing=hooks.filter(row=>row.command?.includes("existing-hook-not-auto-trusted"));
    assert.equal(existing.length,1);assert.equal(existing[0]!.trustStatus,"untrusted");
    const own=hooks.filter(row=>row.command===f.asset.command);assert.equal(own.length,2);assert.ok(own.every(row=>row.trustStatus==="trusted"));
  }
  assert.equal(readFileSync(join(codexHome,"config.toml"),"utf8"),config);
}));
