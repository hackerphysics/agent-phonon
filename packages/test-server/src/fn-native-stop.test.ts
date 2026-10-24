import test from "node:test";
import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync } from "node:fs";
import { homedir,tmpdir } from "node:os";
import { join,sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { AdapterRegistry,PhononStore,CodexAdapter,OpenClawGatewayAdapter } from "@agent-phonon/core";
import type { AgentAdapter } from "@agent-phonon/core";
import { PeerFixture } from "../../core/dist/testing/peer-fixture.js";
import { TestConn } from "./harness.js";
import { PhononDevice } from "@agent-phonon/server-sdk";

test("TypeScript cancellation and status preserve native stop evidence",async()=>{
  const nativeStop={version:1,state:"unknown",targets:[],observedAt:new Date().toISOString()},reply={status:"cancelled",nativeStop};
  const device=new PhononDevice("device","owner",{async request(){return reply;}} as never);
  const values=await Promise.all([device.workflow.cancel("workflow"),device.workflow.cancelDispatch({dispatchKey:"native-one",project:"owned"}),device.workflow.status("workflow")]);
  for(const value of values)assert.equal(value.nativeStop,nativeStop);
});

async function until(check:()=>boolean|Promise<boolean>,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error("native stop condition not observed");}
async function setup(registry:AdapterRegistry){
  const scope=new PeerFixture("native-stop"),root=scope.root;
  try{
    const store=new PhononStore(join(root,"state.db"));scope.defer(()=>store.close());
    let tc=new TestConn({store,registry,workspaceRoot:root,tenantId:"owner"});scope.defer(()=>tc.conn.dispose());
    const project=(await tc.call("project.create",{name:"work",git:false}) as any).project.projectId;
    return {root,store,project,get tc(){return tc;},async restart(){await tc.conn.dispose();tc=new TestConn({store,registry,workspaceRoot:root,tenantId:"owner"});},async close(){await scope.dispose();}};
  }catch(error){try{await scope.dispose();}catch{}throw error;}
}
function request(project:string,agent="stop:worker") {const id=randomUUID();return {project,clientRequestId:"native-"+id,metadata:{native_run_id:id,native_chat:true,native_request_hash:"a".repeat(64)},plan:{mode:"dag",nodes:[{nodeId:"reply",agent,model:"m1",input:"work"}],finalNodeId:"reply"}};}

test("native cancellation stays pending until the original executor actually settles, without another attempt",async()=>{
  let release!:()=>void,active=false,turn:string|undefined,sends=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),registry=new AdapterRegistry();
  registry.register({name:"stop",capabilities:{nativeSession:true,interrupt:true} as never,discoverAgents:async()=>[],createSession:async(params)=>({sessionId:params.sessionId,model:params.model,interrupt:async()=>{},terminate:async()=>{},
    observeNativeStop:async id=>id===turn&&!active?"native_terminal":undefined,
    send:async(_input,options)=>{sends++;active=true;turn=options.turnId;await gate;active=false;options.emit({type:"result",sessionId:params.sessionId,turnId:turn,seq:0,at:new Date().toISOString(),status:"completed",text:"late success",final:true} as never);}})});
  const f=await setup(registry);
  try{
    const body=request(f.project),ack=await f.tc.call("workflow.run",body) as any;
    await until(()=>active);
    const started=Date.now(),cancel=await f.tc.call("workflow.cancel",{workflowId:ack.workflowId}) as any;
    assert.ok(Date.now()-started<2700);assert.equal(cancel.status,"cancelled");assert.notEqual(cancel.nativeStop.state,"confirmed");
    assert.equal(f.tc.streamEvents.some(event=>event.final&&event.status==="interrupted"),false);
    const status=await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any;
    assert.equal(status.resumable,false);await assert.rejects(f.tc.call("workflow.resume",{workflowId:ack.workflowId,strategy:"continue"}));
    release();await until(async()=>(await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any).nativeStop?.state==="confirmed");
    const done=await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any;
    assert.equal(done.nativeStop.targets[0].turnId,turn);assert.equal(done.nativeStop.targets[0].confirmation,"native_terminal");
    assert.equal(done.nodes[0].attempts.length,1);assert.equal(sends,1);
    assert.equal(f.tc.streamEvents.filter(event=>event.final&&event.status==="interrupted").length,1);
    assert.equal((await f.tc.call("workflow.run",body) as any).workflowId,ack.workflowId);assert.equal(sends,1);
  }finally{release();await f.close();}
});

test("abort acknowledgement without native evidence remains unknown across connection recreation",async()=>{
  let active=false,sends=0;const registry=new AdapterRegistry();
  registry.register({name:"stop",capabilities:{nativeSession:true,interrupt:true} as never,discoverAgents:async()=>[],createSession:async(params)=>({sessionId:params.sessionId,model:params.model,interrupt:async()=>{},terminate:async()=>{},
    send:async(_input,options)=>{sends++;active=true;await new Promise<void>(resolve=>options.signal?.addEventListener("abort",()=>resolve(),{once:true}));}})});
  const f=await setup(registry);
  try{
    const body=request(f.project),ack=await f.tc.call("workflow.run",body) as any;await until(()=>active);
    await f.tc.call("workflow.cancel",{workflowId:ack.workflowId});
    await until(async()=>(await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any).nativeStop?.state==="unknown");
    assert.equal(f.tc.streamEvents.some(event=>event.final&&event.status==="interrupted"),false);
    await f.restart();
    const status=await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any;assert.equal(status.nativeStop.state,"unknown");assert.equal(status.resumable,false);
    await f.tc.call("workflow.dispatch.cancel",{dispatchKey:body.clientRequestId,project:f.project});
    assert.equal((await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any).nativeStop.state,"unknown");assert.equal(sends,1);
  }finally{await f.close();}
});

test("a real matching stop observed during graceful disposal survives recreation without replaying the input",async()=>{
  let active=false,sends=0,turn:string|undefined,release:()=>void=()=>{};
  const registry=new AdapterRegistry(),inputs:string[]=[];
  const create:AgentAdapter["createSession"]=async params=>({
    sessionId:params.sessionId,model:params.model,interrupt:async()=>{},terminate:async()=>{active=false;release();},
    observeNativeStop:async id=>id===turn&&!active?"native_terminal":undefined,
    recoveryCheckpoint:()=>({nativeID:"unchanged-native-session"}),
    send:async(input,options)=>{sends++;inputs.push(input);turn=options.turnId;
      if(sends===1){active=true;await new Promise<void>(resolve=>{release=resolve;});}
      else options.emit({type:"result",sessionId:params.sessionId,turnId:options.turnId,seq:0,at:new Date().toISOString(),status:"completed",text:"next reply",final:true} as never);
    },
  });
  registry.register({name:"stop",capabilities:{nativeSession:true,interrupt:true} as never,discoverAgents:async()=>[],createSession:create,
    recoverSession:async(params,state)=>{assert.deepEqual(state,{nativeID:"unchanged-native-session"});return create(params);}});
  const f=await setup(registry);
  try{
    const body=request(f.project),ack=await f.tc.call("workflow.run",body) as any;await until(()=>active);
    await f.tc.call("workflow.cancel",{workflowId:ack.workflowId});
    await f.restart();
    const row=f.store.loadSessions("owner")[0];assert.ok(row);
    const proof=JSON.parse(String(row?.native_stop_json));
    assert.equal(proof.state,"confirmed");assert.equal(proof.turnId,turn);assert.equal(proof.confirmation,"native_terminal");
    await f.tc.call("workflow.dispatch.cancel",{dispatchKey:body.clientRequestId,project:f.project});
    await until(async()=>(await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any).nativeStop?.state==="confirmed");
    assert.equal(sends,1);assert.equal(active,false);
    assert.equal(JSON.parse(String(row.recovery_json)).settled,true);
    await f.tc.call("session.recover",{sessionId:proof.sessionId,project:f.project,agent:"stop:worker",model:"m1"});
    assert.equal(sends,1);
    await f.tc.call("session.send",{sessionId:proof.sessionId,input:"next original input"});
    await until(()=>sends===2);assert.deepEqual(inputs,["work","next original input"]);
  }finally{release();await f.close();}
});

test("stop evidence arriving after the disposal window cannot mutate the released Session",async()=>{
  let active=false,release:()=>void=()=>{},confirm:()=>void=()=>{},observations=0;
  const proof=new Promise<"native_terminal">(resolve=>{confirm=()=>resolve("native_terminal");}),registry=new AdapterRegistry();
  registry.register({name:"stop",capabilities:{nativeSession:true,interrupt:true} as never,discoverAgents:async()=>[],createSession:async params=>({
    sessionId:params.sessionId,model:params.model,interrupt:async()=>{},terminate:async()=>{active=false;release();},
    observeNativeStop:async()=>{observations++;return proof;},
    send:async()=>{active=true;await new Promise<void>(resolve=>{release=resolve;});},
  })});
  const f=await setup(registry);
  try{
    await f.tc.call("workflow.run",request(f.project));await until(()=>active);
    await f.restart();assert.ok(observations>0);
    const beforeRow=f.store.loadSessions("owner")[0];assert.ok(beforeRow);
    const before=String(beforeRow.native_stop_json);assert.equal(JSON.parse(before).state,"unknown");
    confirm();await new Promise(resolve=>setTimeout(resolve,50));
    const afterRow=f.store.loadSessions("owner")[0];assert.ok(afterRow);assert.equal(String(afterRow.native_stop_json),before);
  }finally{confirm();release();await f.close();}
});

test("Gateway stop needs the matching native terminal, not a chat.abort acknowledgement or another run",async()=>{
  const adapter=new OpenClawGatewayAdapter({gateway:{baseUrl:"ws://127.0.0.1:1",token:"fixture"}});let runId:string|undefined;
  (adapter as any).gw={connect:async()=>{},close:()=>{},isConnected:()=>true,connectionEpoch:()=>1,rpc:async(method:string,params:any)=>{if(method==="chat.send")runId=params.idempotencyKey;return {};}};
  const session=await adapter.createSession({sessionId:"retained",agentId:"openclaw:main",model:"m1",cwd:tmpdir()}),abort=new AbortController();
  try{
    const sent=session.send("work",{turnId:"turn",verbosity:"final",emit:()=>{},signal:abort.signal});await until(()=>!!runId);
    abort.abort();await sent;await session.interrupt!();assert.equal(await session.observeNativeStop!("turn"),undefined);
    (session as any).handleEvent("chat",{state:"aborted",runId:"different"});assert.equal(await session.observeNativeStop!("turn"),undefined);
    (session as any).handleEvent("chat",{state:"aborted",runId});assert.equal(await session.observeNativeStop!("turn"),"native_terminal");
  }finally{await session.terminate();adapter.close();}
});

test("a concurrent discovery probe can overwrite a legacy CLI fixture PID without invalidating the actual executor stop proof",{skip:process.platform==="win32",timeout:20000},async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-stop-identity-"))),bin=join(root,"codex.cjs"),pidFile=join(root,"pid"),invocations=join(root,"invocations.jsonl");
  // Reproduce the old fixture: both --version and exec publish the same PID alias.
  writeFileSync(bin,`#!${process.execPath}\nconst fs=require('node:fs');fs.readFileSync(0);process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(invocations)},JSON.stringify({pid:process.pid,mode:process.argv[2]})+'\\n');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));setInterval(()=>{},1000);\n`,{mode:0o700});
  const adapter=new CodexAdapter({env:{binPath:bin,codexHome:root,defaultModel:"m1",models:[{id:"m1",available:true}]}}),session=await adapter.createSession({sessionId:"owned-executor",agentId:"codex",model:"m1",cwd:root});
  const abort=new AbortController(),discoveryAbort=new AbortController();let sent:Promise<void>|undefined,discovery:Promise<unknown>|undefined;
  try{
    sent=session.send("owned stop fixture",{turnId:"owned-turn",verbosity:"tools",signal:abort.signal,emit(){}});
    await until(()=>existsSync(pidFile));const executorPID=Number(readFileSync(pidFile,"utf8"));
    assert.deepEqual(JSON.parse(readFileSync(invocations,"utf8").trim()),{pid:executorPID,mode:"exec"});
    discovery=adapter.discoverAgents(discoveryAbort.signal).catch(()=>[]);
    await until(()=>Number(readFileSync(pidFile,"utf8"))!==executorPID);
    const probePID=Number(readFileSync(pidFile,"utf8")),calls=readFileSync(invocations,"utf8").trim().split("\n").map(row=>JSON.parse(row));
    assert.deepEqual(calls,[{pid:executorPID,mode:"exec"},{pid:probePID,mode:"--version"}]);
    abort.abort();await sent;
    await until(async()=>await session.observeNativeStop!("owned-turn")==="process_tree_exit");
    assert.throws(()=>process.kill(executorPID,0));
    assert.doesNotThrow(()=>process.kill(probePID,0),"the old PID-file assertion checks discovery, not the stopped executor");
    console.log(JSON.stringify({case:"legacy-stop-pid-alias",executorPID,probePID,executorStopped:true,probeStillAlive:true,nativeStop:"process_tree_exit"}));
  }finally{
    abort.abort();discoveryAbort.abort();await sent?.catch(()=>{});await discovery?.catch(()=>{});await session.terminate();rmSync(root,{recursive:true,force:true});
  }
});

test("Codex native stop waits past acknowledgement for a real supervised process exit",{skip:process.platform==="win32",timeout:20000},async()=>{
  const binRoot=realpathSync(mkdtempSync(join(tmpdir(),"phonon-stop-cli-"))),bin=join(binRoot,"codex.cjs"),home=join(binRoot,"home"),pidFile=join(binRoot,"pid"),nonce=randomUUID();mkdirSync(home);
  writeFileSync(bin,`#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('codex-cli fixture');process.exit(0);}if(process.argv[2]!=='exec')process.exit(2);const fs=require('node:fs');fs.readFileSync(0);process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile+".new")},JSON.stringify({pid:process.pid,mode:'exec',nonce:${JSON.stringify(nonce)}}),{flag:'wx'});fs.renameSync(${JSON.stringify(pidFile+".new")},${JSON.stringify(pidFile)});console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));setInterval(()=>{},1000);\n`,{mode:0o700});
  const registry=new AdapterRegistry(),adapter=new CodexAdapter({env:{binPath:bin,codexHome:home,defaultModel:"m1",models:[{id:"m1",available:true}]}});registry.register(adapter);const f=await setup(registry);let pid:number|undefined;
  try{
    const ack=await f.tc.call("workflow.run",request(f.project,"codex")) as any;await until(()=>existsSync(pidFile));
    const identity=JSON.parse(readFileSync(pidFile,"utf8"));assert.equal(identity.mode,"exec");assert.equal(identity.nonce,nonce);assert.ok(Number.isSafeInteger(identity.pid)&&identity.pid>1);pid=identity.pid;
    const inventory=await adapter.discoverAgents();assert.equal(inventory[0]?.available,true);assert.deepEqual(JSON.parse(readFileSync(pidFile,"utf8")),identity,"discovery must not replace the executor identity");
    const stopped=await f.tc.call("workflow.cancel",{workflowId:ack.workflowId}) as any;
    assert.notEqual(stopped.nativeStop.state,"confirmed");assert.doesNotThrow(()=>process.kill(pid!,0));
    await until(async()=>(await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any).nativeStop?.state==="confirmed");
    assert.throws(()=>process.kill(pid!,0));const status=await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any;
    assert.equal(status.nativeStop.targets[0].confirmation,"process_tree_exit");assert.equal(status.nodes[0].attempts.length,1);
  }finally{if(pid)try{process.kill(-pid,"SIGKILL");}catch{}await f.close();rmSync(binRoot,{recursive:true,force:true});}
});

test("Codex native stop remains unconfirmed after leader exit while a real same-group descendant survives",{skip:process.platform==="win32",timeout:30000},async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-stop-descendant-"))),bin=join(root,"codex.cjs"),leaderFile=join(root,"leader.json"),childFile=join(root,"child.json"),nonce=randomUUID();
  const descendant=`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(childFile+".new")},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(nonce)}}));fs.renameSync(${JSON.stringify(childFile+".new")},${JSON.stringify(childFile)});setInterval(()=>{},1000);`;
  writeFileSync(bin,`#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('codex-cli fixture');process.exit(0);}if(process.argv[2]!=='exec')process.exit(2);const fs=require('node:fs');fs.readFileSync(0);process.on('SIGTERM',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(leaderFile+".new")},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(nonce)}}));fs.renameSync(${JSON.stringify(leaderFile+".new")},${JSON.stringify(leaderFile)});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));setInterval(()=>{},1000);\n`,{mode:0o700});
  const registry=new AdapterRegistry();registry.register(new CodexAdapter({env:{binPath:bin,codexHome:root,defaultModel:"m1",models:[{id:"m1",available:true}]}}));const f=await setup(registry);
  let leaderPID:number|undefined,childPID:number|undefined;
  try{
    const ack=await f.tc.call("workflow.run",request(f.project,"codex")) as any;
    await until(()=>existsSync(leaderFile)&&existsSync(childFile));
    const leader=JSON.parse(readFileSync(leaderFile,"utf8")),child=JSON.parse(readFileSync(childFile,"utf8"));
    for(const identity of [leader,child]){assert.equal(identity.nonce,nonce);assert.ok(Number.isSafeInteger(identity.pid)&&identity.pid>1);}
    leaderPID=leader.pid;childPID=child.pid;assert.notEqual(leaderPID,childPID);
    const stopped=await f.tc.call("workflow.cancel",{workflowId:ack.workflowId}) as any;
    await until(()=>{try{process.kill(leaderPID!,0);return false;}catch{return true;}});
    assert.doesNotThrow(()=>process.kill(childPID!,0));assert.notEqual(stopped.nativeStop.state,"confirmed");
    const whileChildLives=await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any;
    assert.notEqual(whileChildLives.nativeStop.state,"confirmed");
    assert.equal(f.tc.streamEvents.some(event=>event.final&&event.status==="interrupted"),false);
    console.log(JSON.stringify({case:"leader-exit-with-live-descendant",leaderPID,childPID,leaderStopped:true,childStillAlive:true,state:whileChildLives.nativeStop.state}));
    await until(async()=>(await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any).nativeStop?.state==="confirmed");
    assert.throws(()=>process.kill(childPID!,0));
    const settled=await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any;
    assert.equal(settled.nativeStop.targets[0].confirmation,"process_tree_exit");assert.equal(settled.nodes[0].attempts.length,1);
    assert.equal(f.tc.streamEvents.filter(event=>event.final&&event.status==="interrupted").length,1);
  }finally{
    if(leaderPID)try{process.kill(-leaderPID,"SIGKILL");}catch{}
    await f.close();
    if(childPID)await until(()=>{try{process.kill(childPID!,0);return false;}catch{return true;}});
    rmSync(root,{recursive:true,force:true});
  }
});

test("installed Codex CLI stops its original held-inference execution without a model response or personal credentials",{skip:!process.env.PHONON_TEST_CODEX_BIN||process.platform==="win32",timeout:60000},async()=>{
  const bin=process.env.PHONON_TEST_CODEX_BIN!,home=realpathSync(mkdtempSync(join(tmpdir(),"phonon-installed-codex-stop-"))),sockets=new Set<Socket>();
  const hash=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex");
  const personal=new Map(["config.toml","auth.json"].map(name=>join(homedir(),".codex",name)).filter(file=>existsSync(file)).map(file=>[file,hash(file)]));
  let inferenceRequests=0,modelResponses=0;
  const provider=createServer((req,res)=>{
    if(req.method==="POST"&&new URL(req.url??"/","http://127.0.0.1").pathname.endsWith("/responses")){
      inferenceRequests++;res.once("finish",()=>{modelResponses++;});req.resume();return;
    }
    res.writeHead(404);res.end();
  });
  provider.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const port=(provider.address() as {port:number}).port;
  const adapter=new CodexAdapter({env:{binPath:bin,codexHome:home,baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:"isolated-stop-fixture-not-a-real-key",defaultModel:"stop-fixture-model",models:[{id:"stop-fixture-model",available:true}]}});
  let session:Awaited<ReturnType<typeof adapter.createSession>>|undefined;
  const create=adapter.createSession.bind(adapter);adapter.createSession=async params=>{session=await create(params);return session;};
  const registry=new AdapterRegistry();registry.register(adapter);let f:Awaited<ReturnType<typeof setup>>|undefined;
  try{
    f=await setup(registry);
    const project=(await f.tc.call("project.get",{projectId:f.project}) as any).project;
    const workspace=realpathSync(project.path);assert.ok(workspace.startsWith(f.root+sep));
    execFileSync("git",["init","--quiet",workspace]);
    writeFileSync(join(home,"config.toml"),`approval_policy = "never"\nsandbox_mode = "workspace-write"\n[features]\nshell_snapshot = false\n[sandbox_workspace_write]\nnetwork_access = false\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,{mode:0o600});
    const body=request(f.project,"codex");body.plan.nodes[0]!.model="stop-fixture-model";
    const ack=await f.tc.call("workflow.run",body) as any;
    await until(()=>{
      const terminal=f!.tc.streamEvents.find(event=>event.final);
      if(terminal)throw new Error("Installed Codex ended before held inference: "+String(terminal.message??terminal.status));
      return inferenceRequests>0;
    },30000);
    const native=(session as any)?.lastNative;assert.ok(native?.supervisor?.child?.pid>1);
    const pid=native.supervisor.child.pid;assert.doesNotThrow(()=>process.kill(pid,0));assert.equal(modelResponses,0);
    const stopped=await f.tc.call("workflow.cancel",{workflowId:ack.workflowId}) as any;
    if(stopped.nativeStop.state!=="confirmed")await until(async()=>(await f!.tc.call("workflow.status",{workflowId:ack.workflowId}) as any).nativeStop?.state==="confirmed");
    const status=await f.tc.call("workflow.status",{workflowId:ack.workflowId}) as any;
    assert.equal(status.nativeStop.state,"confirmed");assert.deepEqual(status.nativeStop.targets.map((target:any)=>({sessionId:target.sessionId,turnId:target.turnId,confirmation:target.confirmation})),[{sessionId:session!.sessionId,turnId:native.turnId,confirmation:"process_tree_exit"}]);
    assert.throws(()=>process.kill(pid,0));assert.equal(status.nodes[0].attempts.length,1);
    assert.equal(f.tc.streamEvents.filter(event=>event.final&&event.status==="interrupted").length,1);
    assert.equal(modelResponses,0);
    console.log(JSON.stringify({case:"installed-codex-held-inference-stop",pid,inferenceRequests,modelResponses,attempts:status.nodes[0].attempts.length,confirmation:status.nativeStop.targets[0].confirmation}));
  }finally{
    await session?.terminate();await f?.close();
    for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>provider.close(()=>resolve()));
    rmSync(home,{recursive:true,force:true});
    for(const [file,before] of personal)assert.equal(hash(file),before,"Personal Codex configuration/auth must remain unchanged");
  }
});
