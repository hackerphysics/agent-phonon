import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WebSocketServer,type WebSocket } from "ws";
import { AdapterRegistry,OpenClawGatewayAdapter,PhononStore } from "@agent-phonon/core";
import { TestConn } from "./harness.js";

const model="local/m1";
type Native={key:string;id:string;agent:string;cwd:string;createdAt:number;messages:string[];leaf:string|null;status?:string;endedAt?:number;active:boolean;pending:number;archived:boolean;model:string};
async function until(check:()=>boolean|Promise<boolean>){for(let n=0;n<500;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("OpenClaw fixture condition not observed");}
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-gateway-recovery-"))),base=join(root,"base");mkdirSync(base);
  writeFileSync(join(root,"resource-owner.json"),JSON.stringify({workflow:"fn-openclaw-recovery",pid:process.pid,root}));
  const records=new Map<string,Native>(),agents=new Map<string,string>([["base",base]]),calls:Array<{method:string;params:any}>=[],inferences:any[]=[];
  const policyReceipts=new Map<string,unknown>();
  let capabilities=true,changeBeforeSend=false,holdHistory=false,historyWaiting=false,releaseHistory:(()=>void)|undefined;
  const server=new WebSocketServer({host:"127.0.0.1",port:0});
  await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);}).catch(error=>{server.close();rmSync(root,{recursive:true,force:true});throw error;});
  const history=(row:Native)=>({sessionKey:row.key,sessionId:row.id,messages:row.messages.slice(-4).map((text,index)=>({id:String(index),role:"assistant",content:[{type:"text",text}]})),totalMessages:row.messages.length,
    pendingInputs:{items:row.pending?[{}]:[],total:row.pending},sessionInfo:{key:row.key,sessionId:row.id,createdAt:row.createdAt,model:row.model.slice(6),modelProvider:"local",spawnedCwd:row.cwd,
      hasActiveRun:row.active,activeRunIds:row.active?[randomUUID()]:[],activeLeafEntryId:row.leaf,archived:row.archived,status:row.status,endedAt:row.endedAt}});
  server.on("connection",socket=>{
    socket.send(JSON.stringify({type:"event",event:"connect.challenge",payload:{nonce:"isolated"}}));
    socket.on("message",async raw=>{
      const request=JSON.parse(String(raw)),p=request.params??{},method=String(request.method);
      const respond=(payload:unknown)=>socket.send(JSON.stringify({type:"res",id:request.id,ok:true,payload}));
      if(method==="connect"){respond({type:"hello-ok",protocol:4,server:{version:"fixture",connId:randomUUID()},features:{methods:[],events:[],capabilities:capabilities?["session-settings-cas-v1"]:[]}});return;}
      calls.push({method,params:p});
      try{
        if(method==="agents.list"){respond({agents:[...agents].map(([id,workspace])=>({id,workspace,model}))});return;}
        if(method==="models.list"){respond({models:["m1","m2"].map(id=>({id,provider:"local",available:true,thinkingLevels:[{value:"high"}]}))});return;}
        if(method==="tools.catalog"){respond({agentId:p.agentId,profiles:[],groups:[{source:"core",tools:["read","write","exec","ask_user","message","secrets","sessions_spawn"].map(id=>({id}))}]});return;}
        if(method==="tools.effective"){respond({agentId:p.agentId,groups:[]});return;}
        if(method==="phonon.policy.bind"){
          const receipt={version:1,bound:true,policy:"phonon-noninteractive-v1",nativeVersion:"2026.10.7",policyId:p.policyId,sessionKey:p.sessionKey,sessionId:p.sessionId,runId:p.runId,catalogHash:createHash("sha256").update(JSON.stringify(p.catalog)).digest("hex"),executionFence:"native-controller-v1"};
          policyReceipts.set(p.policyId,receipt);respond(receipt);return;
        }
        if(method==="phonon.policy.confirm"){assert.ok(policyReceipts.has(p.policyId));respond(policyReceipts.get(p.policyId));return;}
        if(method==="phonon.policy.release"){policyReceipts.delete(p.policyId);respond({version:1,released:true});return;}
        if(method==="agents.create"){agents.set(p.name,p.workspace);respond({agentId:p.name,workspace:p.workspace});return;}
        if(method==="agents.update"){respond({ok:true});return;}
        if(method==="config.get"){respond({valid:true,hash:"fixture-config",config:{}});return;}
        if(method==="agents.files.get"||method==="agents.files.set"){
          assert.ok(["SOUL.md","AGENTS.md","USER.md","TOOLS.md","IDENTITY.md","MEMORY.md"].includes(p.name));
          const home=agents.get(p.agentId)!;mkdirSync(home,{recursive:true});const file=join(home,p.name);
          if(method==="agents.files.set"){writeFileSync(file,p.content);respond({ok:true});}
          else respond({workspace:home,file:{missing:!existsSync(file),content:existsSync(file)?readFileSync(file,"utf8"):""}});return;
        }
        if(method==="sessions.create"){
          assert.equal(typeof p.cwd,"string");assert.equal(p.worktree,false);assert.equal(records.has(p.key),false,"Recovery must not recreate a key");
          const row:Native={key:p.key,id:randomUUID(),agent:p.key.split(":")[1],cwd:realpathSync(p.cwd),createdAt:Date.now(),messages:[],leaf:null,active:false,pending:0,archived:false,model:p.model};records.set(p.key,row);
          respond({ok:true,key:p.key,sessionId:row.id});return;
        }
        if(method==="sessions.messages.subscribe"){respond({subscribed:true});return;}
        if(method==="chat.history"){
          if(holdHistory){holdHistory=false;historyWaiting=true;await new Promise<void>(resolve=>{releaseHistory=resolve;});historyWaiting=false;}
          const row=records.get(p.sessionKey);respond(row?history(row):{sessionInfo:null,messages:[]});return;
        }
        if(method==="chat.send"){
          const row=records.get(p.sessionKey)!;
          if(changeBeforeSend){changeBeforeSend=false;row.id=randomUUID();}
          if(p.sessionId!==undefined&&p.sessionId!==row.id||p.expectedLeafEntryId!==undefined&&p.expectedLeafEntryId!==row.leaf)throw new Error("session-active-leaf-changed");
          inferences.push({sessionId:row.id,key:row.key,input:p.message});row.messages.push("user: "+p.message,"assistant: "+row.messages.join(" | ")+"; "+p.message);
          row.leaf=randomUUID();row.status="done";row.endedAt=Date.now();
          respond({runId:p.idempotencyKey,status:"started"});
          setImmediate(()=>socket.send(JSON.stringify({type:"event",event:"chat",payload:{sessionKey:row.key,runId:p.idempotencyKey,state:"final",finalText:row.messages.at(-1)}})));return;
        }
        if(method==="chat.abort"){respond({ok:true});return;}
        if(method==="agent.wait"){respond({status:"ok"});return;}
        if(method==="sessions.patch"){const row=records.get(p.key)!;if(p.model)row.model=p.model;respond({key:p.key,entry:{thinkingLevel:p.thinkingLevel},resolved:{model:row.model.slice(6),modelProvider:"local"}});return;}
        if(method==="sessions.compact"){const row=records.get(p.key)!;row.messages=["Retained compacted native history"];row.leaf=randomUUID();respond({ok:true,compacted:true});return;}
        throw new Error("Unexpected fixture method "+method);
      }catch(error){socket.send(JSON.stringify({type:"res",id:request.id,ok:false,error:{code:"INVALID_REQUEST",message:String(error)}}));}
    });
  });
  const address=server.address() as {port:number},adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:`ws://127.0.0.1:${address.port}`,token:"synthetic"}}),registry=new AdapterRegistry();registry.register(adapter);
  let store=new PhononStore(join(root,"state.db")),conn=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner",policy:{allowEmployeeProfiles:true}});
  const project=(await conn.call("project.create",{name:"Group",git:false}) as any).project.projectId as string;
  const create=async(projectId=project,employee?:{id:string;revision:number})=>(await conn.call("session.create",{project:projectId,agent:"openclaw:base",model,...(employee?{agentConfig:{employee}}:{})}) as any).sessionId as string;
  return {root,adapter,registry,records,agents,calls,inferences,project,get conn(){return conn;},get store(){return store;},create,
    expected:(sessionId:string,projectId=project)=>({sessionId,project:projectId,agent:"openclaw:base",model}),
    native:(id:string)=>[...records.values()].find(row=>row.key.endsWith("phonon-"+id))!,
    async turn(id:string,input:string){const sent=await conn.call("session.send",{sessionId:id,input}) as any;const final=await conn.waitTurnEnd(sent.turnId);await until(async()=>(await conn.call("session.status",{sessionId:id}) as any).status==="idle");return final;},
    async restart(){await conn.conn.dispose();store.close();store=new PhononStore(join(root,"state.db"));conn=new TestConn({registry,store,workspaceRoot:root,tenantId:"owner",policy:{allowEmployeeProfiles:true}});},
    changeBeforeSend(){changeBeforeSend=true;},disableCapabilities(){capabilities=false;adapter.close();},
    holdHistory(){holdHistory=true;},get historyWaiting(){return historyWaiting;},releaseHistory(){releaseHistory?.();},
    async close(){releaseHistory?.();await conn.conn.dispose();adapter.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});},
  };
}

test("OpenClaw Gateway DE recovery retains private/group native histories, memory, pending context and updated identity without work",async()=>{
  const f=await fixture();
  try{
    const employeeId=randomUUID(),profile={employeeId,revision:1,agent:"openclaw:base",model,profileId:randomUUID(),name:"Engineer",responsibility:"Delivery",documents:{soul:"Original identity",agents:"Keep scope",user:"",tools:""}};
    const installed=await f.conn.call("employee.profile.apply",profile) as any;
    const direct=await f.create(installed.privateWorkspace.projectId,{id:employeeId,revision:1}),group=await f.create(f.project,{id:employeeId,revision:1});
    await f.turn(direct,"private original");await f.turn(group,"group original");
    const privateNative=f.native(direct),groupNative=f.native(group);assert.notEqual(privateNative.id,groupNative.id);assert.notEqual(privateNative.cwd,groupNative.cwd);
    const memory=join(installed.privateWorkspace.path,"MEMORY.md");writeFileSync(memory,"Retained long-term DE memory");
    await f.conn.call("session.inject",{sessionId:direct,context:[{role:"system",content:"pending next private input"}]});
    await f.conn.call("employee.profile.apply",{...profile,revision:2,documents:{...profile.documents,soul:"Updated employee personality"}});
    await f.restart();const before=f.calls.length;
    for(const [id,project]of[[direct,installed.privateWorkspace.projectId],[group,f.project]]){
      const result=await f.conn.call("session.recover",f.expected(id,project)) as any;
      assert.equal(result.employeeRevision,2);assert.equal(result.sessionId,id);assert.equal(result.recovery.detached,false);
    }
    assert.equal(f.inferences.length,2);assert.equal(f.conn.streamEvents.length,0);
    assert.ok(f.calls.slice(before).every(call=>["chat.history","sessions.describe","sessions.messages.subscribe","agents.list","agents.files.get","models.list","phonon.peers.capabilities"].includes(call.method)),JSON.stringify(f.calls.slice(before).map(call=>call.method)));
    assert.equal(readFileSync(memory,"utf8"),"Retained long-term DE memory");
    await f.turn(direct,"private next");await f.turn(group,"group next");
    assert.deepEqual(f.inferences.map(call=>call.sessionId),[privateNative.id,groupNative.id,privateNative.id,groupNative.id]);
    assert.match(f.inferences[2].input,/pending next private input/);assert.match(f.inferences[2].input,/Updated employee personality/);
    assert.ok(f.calls.filter(call=>call.method==="chat.send").slice(2).every(call=>call.params.sessionId&&call.params.expectedLeafEntryId));
  }finally{await f.close();}
});

test("OpenClaw recovery refuses changed identity, empty/active/queued/archived history and missing native facts without mutation",async()=>{
  for(const variant of ["missing","id","model","cwd","created","empty","active","queued","archived","unknown"]){
    const f=await fixture();
    try{
      const id=await f.create();await f.turn(id,"settled");const row=f.native(id);await f.restart();
      if(variant==="missing")f.records.delete(row.key);
      if(variant==="id")row.id=randomUUID();if(variant==="model")row.model="local/m2";
      if(variant==="cwd")row.cwd=f.root;if(variant==="created")row.createdAt++;
      if(variant==="empty"){row.messages=[];row.leaf=null;}if(variant==="active")row.active=true;
      if(variant==="queued")row.pending=1;if(variant==="archived")row.archived=true;if(variant==="unknown")row.status=undefined;
      const before=f.calls.length;await assert.rejects(f.conn.call("session.recover",f.expected(id)));
      assert.equal(f.inferences.length,1);assert.ok(f.calls.slice(before).every(call=>["chat.history","agents.list","models.list","sessions.describe","phonon.peers.capabilities"].includes(call.method)),JSON.stringify(f.calls.slice(before).map(call=>call.method)));
      assert.equal((await f.conn.call("session.status",{sessionId:id}) as any).recovery.detached,true);
    }finally{await f.close();}
  }
});

test("OpenClaw recovered input carries native-id/leaf admission and a late native reset cannot start another inference",async()=>{
  const f=await fixture();
  try{
    const id=await f.create();await f.turn(id,"original");await f.restart();await f.conn.call("session.recover",f.expected(id));
    f.changeBeforeSend();const result=await f.turn(id,"must not run in replacement");
    assert.equal(result.status,"failed");assert.equal(f.inferences.length,1);
    assert.equal(f.calls.filter(call=>call.method==="sessions.create").length,1);
  }finally{await f.close();}
});

test("OpenClaw recovery survives Gateway transport restart but refuses downgraded native admission capability",async()=>{
  const f=await fixture();
  try{
    const id=await f.create();await f.turn(id,"original");await f.restart();f.adapter.close();
    await f.conn.call("session.recover",f.expected(id));assert.equal(f.inferences.length,1);
    await f.restart();f.disableCapabilities();const before=f.calls.length;
    await assert.rejects(f.conn.call("session.recover",f.expected(id)));assert.equal(f.inferences.length,1);assert.equal(f.calls.length,before);
  }finally{await f.close();}
});

test("OpenClaw compaction, confirmed model selection and inactive native terminal history preserve the original Session",async()=>{
  const f=await fixture();
  try{
    const id=await f.create();await f.turn(id,"first");await f.turn(id,"second");const native=f.native(id),nativeID=native.id;
    const compacted=await f.conn.call("session.compress",{sessionId:id,mode:"native",clientRequestId:randomUUID()}) as any;
    assert.equal(compacted.state,"succeeded");assert.equal(native.messages.length,1);
    await f.conn.call("session.switchModel",{sessionId:id,model:"local/m2"});assert.equal(native.model,"local/m2");
    await f.restart();native.status="killed";native.endedAt=Date.now();
    await f.conn.call("session.recover",{...f.expected(id),model:"local/m2"});assert.equal(f.inferences.length,2);
    await f.turn(id,"after reconnect");assert.equal(f.inferences.at(-1).sessionId,nativeID);
    assert.equal(f.calls.filter(call=>call.method==="sessions.create").length,1);
  }finally{await f.close();}
});

test("OpenClaw adapter closure during read-only recovery cannot install a late Session or abort native work",async()=>{
  const f=await fixture();
  try{
    const id=await f.create();await f.turn(id,"original");await f.restart();f.holdHistory();
    const recovering=assert.rejects(f.conn.call("session.recover",f.expected(id)));await until(()=>f.historyWaiting);
    const before=f.calls.filter(call=>call.method==="chat.abort").length;f.adapter.close();f.releaseHistory();await recovering;
    assert.equal(f.calls.filter(call=>call.method==="chat.abort").length,before);assert.equal(f.inferences.length,1);
    assert.equal((await f.conn.call("session.status",{sessionId:id}) as any).recovery.detached,true);
  }finally{await f.close();}
});

test("installed OpenClaw history handler verifies an isolated native transcript without writes or inference",async t=>{
  const nativeRoot=process.env.PHONON_TEST_OPENCLAW_ROOT;
  if(!nativeRoot){t.skip("Set PHONON_TEST_OPENCLAW_ROOT for isolated installed-native read verification");return;}
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-openclaw-installed-")));
  const script=String.raw`
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readdirSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const [nativeRoot,root,coreFile]=process.argv.slice(1),workspace=join(root,'work');mkdirSync(workspace);
const config={agents:{defaults:{workspace,model:{primary:'local/m1'}},entries:{base:{workspace}}},plugins:{enabled:false},models:{providers:{local:{baseUrl:'http://127.0.0.1:1',apiKey:'isolated-test-not-a-provider-credential',api:'openai-completions',models:[{id:'m1',name:'Isolated',contextWindow:32000,maxTokens:1024}]}}}};
writeFileSync(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify(config));
const sdk=await import(pathToFileURL(join(nativeRoot,'dist/plugin-sdk/session-store-runtime.js')));
const transcript=await import(pathToFileURL(join(nativeRoot,'dist/plugin-sdk/session-transcript-runtime.js')));
const file=readdirSync(join(nativeRoot,'dist')).find(name=>/^chat-.*\.mjs$/.test(name)&&readFileSync(join(nativeRoot,'dist',name),'utf8').includes('const chatHandlers ='));
assert.ok(file,'Installed native chat handler missing');
const module=await import(pathToFileURL(join(nativeRoot,'dist',file))),handlers=Object.values(module).find(value=>value&&typeof value==='object'&&typeof value['chat.history']==='function');assert.ok(handlers);
const sessionId=randomUUID(),phononId=randomUUID(),key='agent:base:phonon-'+phononId,createdAt=Date.now()-1000;
const storePath=join(root,'agents/base/sessions/sessions.json'),scope={agentId:'base',sessionKey:key,sessionId,storePath};
await sdk.upsertSessionEntry({...scope,entry:{sessionId,createdAt,updatedAt:createdAt,model:'m1',modelProvider:'local',providerOverride:'local',modelOverride:'m1',spawnedCwd:workspace,status:'done',endedAt:Date.now(),lastRunId:randomUUID()}});
for(const role of ['user','assistant'])assert.equal((await transcript.appendSessionTranscriptMessageByIdentity({...scope,config,message:{role,content:[{type:'text',text:role+' retained native history'}],timestamp:Date.now()},updateMode:'none'})).appended,true);
const context={getRuntimeConfig:()=>config,getModelCatalog:async()=>[],loadGatewayModelCatalog:async()=>[{provider:'local',id:'m1',name:'Isolated',contextWindow:32000}],chatAbortControllers:new Map(),chatQueuedTurns:new Map(),chatRunState:{buffers:new Map(),deltaSentAt:new Map(),lastBroadcastAt:new Map(),abortedRuns:new Map()},logGateway:{debug(){},warn(){},error(){}},broadcast(){},broadcastToConnIds(){},getSessionEventSubscriberConnIds:()=>new Set(),dedupe:new Map()};
const client={connect:{role:'operator',scopes:['operator.read','operator.write','operator.admin'],client:{id:'gateway-client'}}};
const read=(target=key)=>new Promise((resolve,reject)=>Promise.resolve(handlers['chat.history']({params:{sessionKey:target,agentId:'base',limit:4,offset:0,maxBytes:32768,maxChars:512},context,client,req:{id:randomUUID()},respond:(ok,data,error)=>ok?resolve(data):reject(new Error(JSON.stringify(error)))})).catch(reject));
const history=await read();assert.equal(history.sessionId,sessionId);assert.equal(history.sessionInfo.key,key);
assert.ok(history.totalMessages>0);assert.equal(history.sessionInfo.hasActiveRun,false);
const {OpenClawGatewayAdapter}=await import(pathToFileURL(coreFile)),gateway='ws://127.0.0.1:1';
const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:gateway,token:'isolated'}}),calls=[];
adapter.gw={connect:async()=>{},close(){},isConnected:()=>true,connectionEpoch:()=>1,supportsCapability:name=>name==='session-settings-cas-v1',rpc:async(method)=>{calls.push(method);assert.ok(['chat.history','sessions.messages.subscribe'].includes(method),'Recovery attempted a mutation');return method==='chat.history'?await read():{subscribed:true};}};
const checkpoint={version:1,phononSessionId:phononId,gateway:gateway+'/',model:'local/m1',pendingInject:['Retain pending context'],native:{sessionKey:key,sessionId,agent:'base',cwd:workspace,model:'local/m1',createdAt,messageCount:history.totalMessages,leafId:history.sessionInfo.activeLeafEntryId}};
function files(dir){const result={};for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())Object.assign(result,files(path));else if(/\.(sqlite|db)(-wal)?$/.test(path))result[path]=createHash('sha256').update(readFileSync(path)).digest('hex');}return result;}
const before=files(root),restored=await adapter.recoverSession({sessionId:phononId,agentId:'openclaw:base',model:'local/m1',cwd:workspace},checkpoint);
assert.equal(restored.sessionId,phononId);assert.equal(restored.recoveryCheckpoint().native.sessionId,sessionId);await restored.terminate();
assert.deepEqual(files(root),before);assert.deepEqual(calls,['chat.history','sessions.messages.subscribe']);
context.chatAbortControllers.set(randomUUID(),{sessionKey:key,sessionId,agentId:'base',controller:new AbortController()});
await assert.rejects(adapter.recoverSession({sessionId:phononId,agentId:'openclaw:base',model:'local/m1',cwd:workspace},checkpoint));
context.chatAbortControllers.clear();
const createFile=readdirSync(join(nativeRoot,'dist')).find(name=>/^sessions-create-.*\.mjs$/.test(name)&&readFileSync(join(nativeRoot,'dist',name),'utf8').includes('const sessionCreateHandlers ='));
assert.ok(createFile,'Installed native creation handler missing');
const createModule=await import(pathToFileURL(join(nativeRoot,'dist',createFile))),createHandlers=Object.values(createModule).find(value=>value&&typeof value==='object'&&typeof value['sessions.create']==='function');
const newKey='agent:base:phonon-'+randomUUID();
const created=await new Promise((resolve,reject)=>Promise.resolve(createHandlers['sessions.create']({params:{key:newKey,model:'local/m1',cwd:workspace,worktree:false},context,client,req:{id:randomUUID(),method:'sessions.create'},respond:(ok,data,error)=>ok?resolve(data):reject(new Error(JSON.stringify(error)))})).catch(reject));
assert.equal(created.key,newKey);assert.notEqual(created.runStarted,true);
const empty=await read(newKey);assert.equal(empty.totalMessages,0);assert.equal(empty.sessionInfo.hasActiveRun,false);assert.equal(empty.sessionInfo.spawnedCwd??empty.sessionInfo.sessionRoot,workspace);
console.log(JSON.stringify({nativeReadVerified:true,nativeSessionRetained:true,readOnly:true,activeNativeRejected:true,nativeCreationCwdVerified:true}));
process.exit(0);
`;
  try{
    const output=execFileSync(process.execPath,["--input-type=module","-e",script,nativeRoot,root,join(process.cwd(),"packages/core/dist/index.js")],{timeout:30000,maxBuffer:262144,encoding:"utf8",env:{PATH:process.env.PATH,HOME:root,USERPROFILE:root,TMPDIR:root,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:join(root,"openclaw.json"),XDG_CONFIG_HOME:join(root,"config"),XDG_CACHE_HOME:join(root,"cache"),XDG_DATA_HOME:join(root,"data"),NO_COLOR:"1",LITELLM_LOCAL_MODEL_COST_MAP:"True"}});
    assert.match(output,/"nativeReadVerified":true/);assert.match(output,/"readOnly":true/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
