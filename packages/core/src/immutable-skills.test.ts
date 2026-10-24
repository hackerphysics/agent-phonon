import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,chmodSync,readdirSync,rmSync,existsSync,renameSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {prepareSkillArchive} from "./skill-archive.js";
import {PhononConnection,PhononStore,AdapterRegistry} from "./index.js";
import {NativeFileBroker} from "./native-file-broker.js";
import {AgentCapabilities,AgentDescriptor,AgentId,SessionId} from "@agent-phonon/protocol";

const artifact=process.env.PHONON_FS_BROKER_ARTIFACT_ROOT;
const nativeTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!artifact?"Prepared immutable tree runtime required":false},fn);
async function until(check:()=>boolean,options:{timeoutMs?:number;details?:()=>unknown}={}){const deadline=Date.now()+(options.timeoutMs??8000);while(!check()){if(Date.now()>deadline)throw Error("immutable skill fixture did not settle"+(options.details?": "+JSON.stringify(options.details()):""));await new Promise(resolve=>setTimeout(resolve,5));}}
function writable(path:string){chmodSync(path,0o700);for(const row of readdirSync(path,{withFileTypes:true})){const value=join(path,row.name);if(row.isDirectory())writable(value);else if(row.isFile())chmodSync(value,0o600);}}
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-immutable-"))),database=join(root,"native.db"),store=new PhononStore(database),registry=new AdapterRegistry(),broker=new NativeFileBroker(artifact!);
  const capabilities=AgentCapabilities.parse({nativeSession:true,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,interrupt:true,injectMidTurn:false,skillManagement:true,hooks:[],streaming:true});
  const received:string[]=[],environments:Array<Record<string,string>|undefined>=[],holds:Array<()=>void>=[];
  registry.register({name:"mock",capabilities,async discoverAgents(){return ["mock:default","mock:other"].map(agentId=>AgentDescriptor.parse({agentId,displayName:agentId,adapter:"mock",available:true,models:[{id:"model",available:true}],capabilities,scannedAt:new Date().toISOString()}));},
      async createSession(params){return {sessionId:params.sessionId,model:params.model,async terminate(){for(const release of holds.splice(0))release();},async send(input,options){received.push(input);environments.push(options.environment);if(input==="HOLD"||input.includes("[PIN_WORKFLOW_HOLD]"))await new Promise<void>(resolve=>holds.push(resolve));
      const executor=input.includes("You are the EXECUTOR of a multi-agent workflow."),continued=input.includes("Worker results from previous iteration:");
      const output=executor?'```phonon.workflow.route\n{"to":"worker","message":"Owned skill work"}\n```':continued?'```phonon.workflow.done\n{"finalSummary":"Controlled graph complete"}\n```'
        :input.includes("As the chairman, decide whether")?"Controlled discussion complete [DISCUSS_END]":"Controlled immutable result";
      options.emit({type:"result",sessionId:SessionId.parse(params.sessionId),turnId:options.turnId,origin:"solicited",seq:0,at:new Date().toISOString(),status:"completed",final:true,text:output});}};}});
  for(const owner of ["a","b"]){const path=join(root,owner);mkdirSync(path);store.upsertProject({projectId:"project-"+owner,namespace:"account-"+owner,name:owner,path,git:false,createdAt:new Date().toISOString()});}
  const connections:PhononConnection[]=[];let sequence=0;
  const actor=(owner="a",agents=["mock:default","mock:other"],policy:Record<string,unknown>={})=>{
    const replies:Array<Record<string,any>>=[],events:Array<Record<string,any>>=[];
    const connection=new PhononConnection({tenantId:"account-"+owner,store,registry,workspaceRoot:root,nativeFileBroker:broker,policy:{allowedAgents:agents.map(value=>AgentId.parse(value)),...policy},
      transport:{send:value=>{const message=JSON.parse(value);if(message.method==="stream.event")events.push(message.params);else replies.push(message);},close:()=>{}}});connections.push(connection);
    const call=async(method:string,params:unknown)=>{const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));const reply=replies.find(value=>value.id===id);assert.ok(reply);return reply;};
    return {events,connection,call,
      input(version:string,baseRevision:string|null=null){return {clientRequestId:"publication-"+ ++sequence,agent:"mock:default",name:"selected",scope:"project",projectId:"project-"+owner,baseRevision,
        source:{kind:"inline",files:{"SKILL.md":`---\nversion: ${version}\n---\nIMMUTABLE_MARKER_${version}\n`,"nested/helper.txt":"Exact helper "+version}}};},
      async session(agent="mock:default"){const result=await call("session.create",{project:"project-"+owner,agent,model:"model",verbosity:"messages"});assert.ok(result.result);return result.result.sessionId;}};
  };
  return {root,database,store,broker,actor,received,environments,release(){for(const release of holds.splice(0))release();},async close(){for(const release of holds.splice(0))release();for(const connection of connections)await connection.dispose();store.close();writable(root);rmSync(root,{recursive:true,force:true});}};
}

const exactSkill=(skill:any)=>({name:skill.name,scope:"project" as const,version:skill.version,revision:skill.revision,installationId:skill.publication.versionId});
async function workflowResult(actor:ReturnType<ReturnType<typeof fixture>["actor"]>,id:string){
  const deadline=Date.now()+10000;let status:any;
  do{const reply=await actor.call("workflow.status",{workflowId:id});assert.ok(reply.result,JSON.stringify(reply));status=reply.result;
    if(["completed","failed","cancelled","timeout"].includes(status.status))return status;
    await new Promise(resolve=>setTimeout(resolve,5));
  }while(Date.now()<deadline);
  throw Error("Original workflow is not terminal: "+JSON.stringify(status));
}
for(const mode of["dag","graph","discussion"] as const)nativeTest(`actual ${mode} workflows load each node's exact owned immutable skill and scoped environment`,async()=>{
  const f=fixture();try{
    const a=f.actor(),skill=(await a.call("skill.publish",a.input("1.0.0"))).result.skill,selection=exactSkill(skill);
    f.store.envSet({tenantId:"account-a",scope:"skill",projectId:"project-a",agent:"mock:default",skillName:"selected",name:"WORKFLOW_SKILL_SETTING",value:"owned-runtime-only",secret:true,updatedAt:new Date().toISOString()});
    const node=(nodeId:string,input:string)=>({nodeId,agent:"mock:default",model:"model",input,skills:[selection]});
    const plan=mode==="dag"?{mode,nodes:[node("one","[PIN_DAG_ONE]"),{...node("two","[PIN_DAG_TWO]"),dependsOn:["one"]}]}:
      mode==="graph"?{mode,executor:node("exec","[PIN_GRAPH_EXEC]"),workers:[node("worker","[PIN_GRAPH_WORKER]")],communicationGraph:{edges:[{from:"exec",to:"worker"}],maxIterations:3}}:
      {mode,topic:"[PIN_DISCUSSION]",participants:[node("one","Participant"),node("chair","Chairman")],chairman:"chair",termination:{maxRounds:1}};
    const result=await a.call("workflow.run",{project:"project-a",plan,clientRequestId:"exact-workflow"});assert.ok(result.result,JSON.stringify(result));
    const status=await workflowResult(a,result.result.workflowId);assert.equal(status.status,"completed",JSON.stringify(status));
    assert.equal(f.received.length,mode==="graph"?3:2);assert.ok(f.received.every(input=>input.includes("IMMUTABLE_MARKER_1.0.0")&&input.includes(skill.installedPath)));
    assert.ok(f.received.every(input=>!input.includes("owned-runtime-only")));assert.ok(f.environments.every(env=>env?.WORKFLOW_SKILL_SETTING==="owned-runtime-only"));
    const info=await a.call("device.info",{});assert.ok(info.result.capabilities.includes("pinned_skill_selection_v1"));assert.ok(info.result.capabilities.includes("workflow_skill_selection_v1"));
  }finally{await f.close();}
});
nativeTest("pins reject a same-name same-semver replacement before a workflow invokes a model",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill;
    const second=(await a.call("skill.publish",a.input("1.0.0",first.revision))).result.skill;assert.notEqual(second.publication.versionId,first.publication.versionId);
    const run=await a.call("workflow.run",{project:"project-a",plan:{mode:"dag",nodes:[{nodeId:"n",agent:"mock:default",model:"model",input:"Must not use replacement",skills:[exactSkill(first)]}]}});
    assert.ok(run.result);const status=await workflowResult(a,run.result.workflowId);assert.equal(status.status,"failed");assert.equal(f.received.length,0);
  }finally{await f.close();}
});
nativeTest("a queued dependent node cannot silently rebind its requested skill after another node started",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill;
    const run=await a.call("workflow.run",{project:"project-a",plan:{mode:"dag",nodes:[{nodeId:"hold",agent:"mock:default",model:"model",input:"[PIN_WORKFLOW_HOLD]"},
      {nodeId:"dependent",agent:"mock:default",model:"model",input:"Dependent must retain original pin",dependsOn:["hold"],skills:[exactSkill(first)]}]}});assert.ok(run.result);
    await until(()=>f.received.length===1);assert.ok((await a.call("skill.publish",a.input("2.0.0",first.revision))).result);f.release();
    const status=await workflowResult(a,run.result.workflowId);assert.equal(status.status,"failed");assert.equal(f.received.length,1);
  }finally{await f.close();}
});
nativeTest("an admitted native queued turn retains its immutable pinned version rather than adopting a later selection",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill,session=await a.session();
    await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const next=await a.call("session.send",{sessionId:session,input:"Use admitted original",skills:[exactSkill(first)]});assert.equal(next.result?.disposition,"queued");
    assert.ok((await a.call("skill.publish",a.input("2.0.0",first.revision))).result);f.release();
    await until(()=>a.events.some(event=>event.turnId===next.result.turnId&&event.final));assert.equal(f.received.length,2);assert.ok(f.received[1]!.includes("IMMUTABLE_MARKER_1.0.0"));assert.equal(f.received[1]!.includes("IMMUTABLE_MARKER_2.0.0"),false);
  }finally{await f.close();}
});
nativeTest("a different account cannot borrow an exact installation pin through an identically named skill",async()=>{
  const f=fixture();try{
    const a=f.actor("a"),b=f.actor("b"),owned=(await a.call("skill.publish",a.input("1.0.0"))).result.skill;
    assert.ok((await b.call("skill.publish",b.input("1.0.0"))).result);
    const run=await b.call("workflow.run",{project:"project-b",plan:{mode:"dag",nodes:[{nodeId:"n",agent:"mock:default",model:"model",input:"Must not borrow other account",skills:[exactSkill(owned)]}]}});assert.ok(run.result);
    const status=await workflowResult(b,run.result.workflowId);assert.equal(status.status,"failed");assert.equal(f.received.length,0);
  }finally{await f.close();}
});
nativeTest("workflow request identity includes exact skill selectors and never adopts a changed retry",async()=>{
  const f=fixture();try{
    const a=f.actor(),skill=(await a.call("skill.publish",a.input("1.0.0"))).result.skill;
    const request={project:"project-a",clientRequestId:"same-original-workflow",plan:{mode:"dag",nodes:[{nodeId:"n",agent:"mock:default",model:"model",input:"Original selection",skills:[exactSkill(skill)]}]}};
    const original=await a.call("workflow.run",request);assert.ok(original.result);await workflowResult(a,original.result.workflowId);
    const repeated=await a.call("workflow.run",request);assert.equal(repeated.result.workflowId,original.result.workflowId);
    const altered=structuredClone(request);altered.plan.nodes[0]!.skills[0]!.installationId=randomUUID();
    assert.equal((await a.call("workflow.run",altered)).error?.data?.appCode,"errInvalidParams");assert.equal(f.received.length,1);
  }finally{await f.close();}
});
nativeTest("a real manual workflow schedule persists and loads its pinned node skill",async()=>{
  const f=fixture();try{
    const a=f.actor(),skill=(await a.call("skill.publish",a.input("1.0.0"))).result.skill,selected=exactSkill(skill);
    const response=await a.call("schedule.create",{name:"Pinned workflow",trigger:{kind:"manual"},target:{project:"project-a",runKind:"workflow",plan:{mode:"dag",nodes:[{nodeId:"n",agent:"mock:default",model:"model",input:"Scheduled exact source",skills:[selected]}]}},consent:{push:"status-only"}});
    assert.ok(response.result,JSON.stringify(response));assert.deepEqual(response.result.schedule.target.plan.nodes[0].skills,[selected]);
    const triggered=await a.call("schedule.trigger",{scheduleId:response.result.schedule.id});assert.ok(triggered.result,JSON.stringify(triggered));
    const deadline=Date.now()+10000;let run:any;
    do{const reply=await a.call("run.get",{runId:triggered.result.runId});assert.ok(reply.result,JSON.stringify(reply));run=reply.result.run;if(["success","failed","cancelled","timeout"].includes(run.status))break;await new Promise(resolve=>setTimeout(resolve,5));}while(Date.now()<deadline);
    assert.equal(run.status,"success",JSON.stringify(run));assert.equal(f.received.length,1);assert.ok(f.received[0]!.includes("IMMUTABLE_MARKER_1.0.0"));
  }finally{await f.close();}
});

nativeTest("a native immutable publication activates a verified private tree without creating a legacy skill directory",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=a.input("1.0.0"),reply=await a.call("skill.publish",input);assert.ok(reply.result,JSON.stringify(reply));const skill=reply.result.skill;
    assert.equal(skill.publication.kind,"immutable");assert.ok(skill.revision);assert.equal(skill.version,"1.0.0");assert.equal(existsSync(join(f.root,"a/.agent/skills/selected")),false);
    assert.equal(readFileSync(join(skill.installedPath,"nested/helper.txt"),"utf8"),"Exact helper 1.0.0");
    assert.equal((await a.call("skill.list",{projectId:"project-a"})).result.skills[0].revision,skill.revision);
    assert.deepEqual((await a.call("skill.dirs",{projectId:"project-a",scope:"project"})).result.directories.map((row:any)=>({path:row.path,active:row.active,exists:row.exists})),[{path:skill.installedPath,active:true,exists:true}]);
    const session=await a.session(),sent=await a.call("session.send",{sessionId:session,input:"Use the exact private tree",skills:["selected"]});
    await until(()=>a.events.some(event=>event.turnId===sent.result?.turnId&&event.final));assert.equal(f.received.length,1);assert.ok(f.received[0]!.includes("IMMUTABLE_MARKER_1.0.0"));assert.ok(f.received[0]!.includes(skill.installedPath));
  }finally{await f.close();}
});

nativeTest("immutable publication rejects a mismatched prepared receiver before claiming or touching any target",async()=>{
  const f=fixture();try{
    const a=f.actor(),receiverID=(await a.call("device.info",{})).result.skillReceiverID,input=a.input("1.0.0");
    const rejected=await a.call("skill.publish",{...input,expectedReceiverID:randomUUID()});
    assert.equal(rejected.error?.data?.appCode,"errSkillInstallUnconfirmed");assert.equal(f.store.skillInstallOperation("account-a",input.clientRequestId),undefined);
    assert.equal(existsSync(join(f.root,"a/.agent")),false);
    const installed=await a.call("skill.publish",{...input,expectedReceiverID:receiverID});assert.ok(installed.result,JSON.stringify(installed));
    const proof=await f.actor().call("skill.install.status",{clientRequestId:input.clientRequestId,agent:input.agent,name:input.name,scope:input.scope,projectId:input.projectId,includeReceiverIdentity:true});
    assert.equal(proof.result.receiverID,receiverID);assert.deepEqual(proof.result.result,installed.result);
  }finally{await f.close();}
});

nativeTest("a metadata fence after physical tree publication prevents late activation while preserving the previous immutable selection and both trees",async()=>{
  const f=fixture();try{
    const a=f.actor(),control=f.actor("a",["mock:default","mock:other"],{allowSkillRecovery:true}),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill;
    const input=a.input("2.0.0",first.revision),call=f.broker.call.bind(f.broker);let fenced=false,published:string|undefined;
    f.broker.call=async request=>{
      const result=await call(request);
      if(request.operation==="publish_tree"&&!fenced){
        fenced=true;published=request.destinationName;
        const scope={clientRequestId:input.clientRequestId,agent:input.agent,name:input.name,scope:input.scope,projectId:input.projectId};
        const context=(await control.call("skill.install.status",{...scope,includeRecoveryContext:true})).result.recovery;assert.ok(context);
        const response=await control.call("skill.install.fence",{...scope,clientRequestId:"human-publication-fence",originalRequestId:input.clientRequestId,expectedReceiverID:context.receiverID,baseRecoveryRevision:context.revision});
        assert.ok(response.result,JSON.stringify(response));assert.equal(response.result.outcomeKnown,false);assert.equal(response.result.targetLocked,true);
      }
      return result;
    };
    const rejected=await a.call("skill.publish",input);assert.equal(rejected.error?.data?.appCode,"errSkillInstallUnconfirmed");assert.equal(fenced,true);
    assert.equal(f.store.loadSkills("account-a")[0]!.publication!.versionId,first.publication.versionId);
    assert.equal(f.store.managedSkillVersion("account-a",published!),undefined);
    assert.equal(readFileSync(join(first.installedPath,"nested/helper.txt"),"utf8"),"Exact helper 1.0.0");
    assert.equal(readFileSync(join(f.root,"a/.agent/skill-versions/selected",published!,"nested/helper.txt"),"utf8"),"Exact helper 2.0.0");
    assert.equal((await a.call("skill.publish",a.input("3.0.0",first.revision))).error?.data?.appCode,"errSkillInstallUnconfirmed");
    const session=await a.session(),sent=await a.call("session.send",{sessionId:session,input:"Use still-selected original tree",skills:["selected"]});
    await until(()=>a.events.some(event=>event.turnId===sent.result?.turnId&&event.final));assert.ok(f.received[0]!.includes("IMMUTABLE_MARKER_1.0.0"));assert.equal(f.received[0]!.includes("IMMUTABLE_MARKER_2.0.0"),false);
  }finally{await f.close();}
});

nativeTest("an old cached immutable result cannot bypass the original receiver pin after identity loss",async()=>{
  const f=fixture();try{
    const a=f.actor(),receiverID=(await a.call("device.info",{})).result.skillReceiverID,input={...a.input("1.0.0"),expectedReceiverID:receiverID},reply=await a.call("skill.publish",input);
    assert.ok(reply.result,JSON.stringify(reply));assert.ok(f.store.idempotencyGet("account-a\0skill.publish\0"+input.clientRequestId));
    const database=new DatabaseSync(f.database);try{database.exec("DROP TRIGGER skill_receiver_delete_immutable; DELETE FROM skill_receivers WHERE tenant_id='account-a'");}finally{database.close();}
    assert.notEqual((await a.call("device.info",{})).result.skillReceiverID,receiverID);
    assert.equal((await a.call("skill.publish",input)).error?.data?.appCode,"errSkillInstallUnconfirmed");
    assert.equal(readFileSync(join(reply.result.skill.installedPath,"SKILL.md"),"utf8"),input.source.files["SKILL.md"]);
    const proof=await a.call("skill.install.status",{clientRequestId:input.clientRequestId,agent:input.agent,name:input.name,scope:input.scope,projectId:input.projectId,includeReceiverIdentity:true});
    assert.equal(proof.result.state,"confirmed");assert.equal(proof.result.receiverID,undefined);
  }finally{await f.close();}
});
nativeTest("transitioning a known legacy selection to an immutable version preserves all human files and the original receipt",async()=>{
  const f=fixture();try{
    const a=f.actor(),legacy={clientRequestId:"legacy-owned",agent:"mock:default",name:"selected",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Human legacy instructions","human.txt":"Preserve all human work"}}};
    const old=(await a.call("skill.install",legacy)).result.skill,reply=await a.call("skill.publish",a.input("2.0.0",old.revision));assert.ok(reply.result,JSON.stringify(reply));
    assert.notEqual(reply.result.skill.installedPath,old.installedPath);assert.equal(readFileSync(join(old.installedPath,"SKILL.md"),"utf8"),"Human legacy instructions");assert.equal(readFileSync(join(old.installedPath,"human.txt"),"utf8"),"Preserve all human work");
    assert.equal((await a.call("skill.list",{projectId:"project-a"})).result.skills.length,1);
    const dirs=(await a.call("skill.dirs",{projectId:"project-a",scope:"project"})).result.directories;assert.equal(dirs.find((row:any)=>row.path===old.installedPath).active,false);assert.equal(dirs.find((row:any)=>row.path===reply.result.skill.installedPath).active,true);
    assert.deepEqual((await a.call("skill.install",legacy)).result.skill,old);
  }finally{await f.close();}
});
nativeTest("queued immutable selection uses its admitted version after activation switches to a newer tree",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill,session=await a.session();await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const queued=await a.call("session.send",{sessionId:session,input:"Original queued task",skills:[{name:"selected",scope:"project",version:"1.0.0"}]});assert.equal(queued.result?.disposition,"queued");
    const next=await a.call("skill.publish",a.input("2.0.0",first.revision));assert.ok(next.result,JSON.stringify(next));assert.notEqual(next.result.skill.installedPath,first.installedPath);
    f.release();await until(()=>a.events.some(event=>event.turnId===queued.result.turnId&&event.final));assert.equal(f.received.length,2);assert.ok(f.received[1]!.includes("IMMUTABLE_MARKER_1.0.0"));assert.equal(f.received[1]!.includes("IMMUTABLE_MARKER_2.0.0"),false);
    const latest=await a.call("session.send",{sessionId:session,input:"New selected task",skills:["selected"]});await until(()=>a.events.some(event=>event.turnId===latest.result?.turnId&&event.final));assert.ok(f.received[2]!.includes("IMMUTABLE_MARKER_2.0.0"));
  }finally{await f.close();}
});
nativeTest("a stale base cannot publish, and a concurrent metadata change after physical publication cannot be overwritten at activation",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill;
    assert.equal((await a.call("skill.publish",a.input("stale",null))).error?.data?.appCode,"errSkillRevisionChanged");
    const call=f.broker.call.bind(f.broker);let version:string|undefined,changed=false;
    f.broker.call=async request=>{const result=await call(request);if(request.operation==="publish_tree"&&!changed){changed=true;version=request.destinationName;
      const executionJson=f.store.skillExecutionReceipt("account-a",{agent:first.agent,name:first.name,scope:first.scope,projectId:first.projectId});
      f.store.upsertSkill({...first,hash:"f".repeat(64),tenantId:"account-a",executionJson});}return result;};
    const input=a.input("2.0.0",first.revision),reply=await a.call("skill.publish",input);assert.equal(reply.error?.data?.appCode,"errSkillRevisionChanged");assert.equal(changed,true);
    const current=f.store.loadSkills("account-a")[0]!;assert.equal(current.hash,"f".repeat(64));assert.equal(current.installedPath,first.installedPath);assert.ok(existsSync(join(f.root,"a/.agent/skill-versions/selected",version!)));
    assert.equal(f.store.managedSkillVersion("account-a",version!),undefined);assert.equal(f.store.skillInstallOperation("account-a",input.clientRequestId)!.state,"unknown");
  }finally{await f.close();}
});
nativeTest("revision-checked deactivation preserves files, revokes queued versions and cannot replay over a newer installation",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill,session=await a.session();await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const queued=await a.call("session.send",{sessionId:session,input:"Must not run after deactivation",skills:["selected"]});
    const input={clientRequestId:"deactivate-exact",agent:"mock:default",name:"selected",scope:"project",projectId:"project-a",baseRevision:first.revision};
    const deactivated=await a.call("skill.unpublish",input);assert.equal(deactivated.result?.deactivated,true);assert.equal(existsSync(join(first.installedPath,"SKILL.md")),true);assert.deepEqual((await a.call("skill.list",{})).result.skills,[]);
    f.release();await until(()=>a.events.some(event=>event.turnId===queued.result.turnId&&event.final));assert.equal(a.events.find(event=>event.turnId===queued.result.turnId&&event.final)!.type,"error");assert.equal(f.received.length,1);
    const next=await a.call("skill.publish",a.input("2.0.0"));assert.ok(next.result,JSON.stringify(next));assert.deepEqual((await a.call("skill.unpublish",input)).result,deactivated.result);
    assert.equal(f.store.loadSkills("account-a")[0]!.publication!.versionId,next.result.skill.publication.versionId);
    const database=new DatabaseSync(f.database);try{database.prepare("DELETE FROM idempotency WHERE k=?").run("account-a\0skill.unpublish\0"+input.clientRequestId);}finally{database.close();}
    assert.equal((await f.actor().call("skill.unpublish",input)).error?.data?.appCode,"errSkillRevisionChanged");assert.equal(f.store.loadSkills("account-a").length,1);
  }finally{await f.close();}
});
nativeTest("another allowed runtime can use an owned immutable Project version while unrelated accounts and root replacement fail closed",async()=>{
  const f=fixture();try{
    const a=f.actor(),input=a.input("1.0.0"),first=await a.call("skill.publish",input);assert.ok(first.result,JSON.stringify(first));
    const other=f.actor("a",["mock:other"]),session=await other.session("mock:other"),sent=await other.call("session.send",{sessionId:session,input:"Owned shared version",skills:["selected"]});await until(()=>other.events.some(event=>event.turnId===sent.result?.turnId&&event.final));assert.equal(f.received.length,1);
    const b=f.actor("b");assert.equal((await b.call("skill.publish",{...input,clientRequestId:"foreign",baseRevision:null})).error?.data?.appCode,"errProjectNotFound");
    const own=await b.call("skill.publish",b.input("1.0.0"));assert.ok(own.result);assert.notEqual(own.result.skill.installedPath,first.result.skill.installedPath);
    renameSync(join(f.root,"a"),join(f.root,"a-kept"));mkdirSync(join(f.root,"a"));
    assert.equal((await a.call("skill.publish",a.input("2.0.0",first.result.skill.revision))).error?.data?.appCode,"errSkillScopeInvalid");assert.equal(existsSync(join(f.root,"a/.agent")),false);
  }finally{await f.close();}
});
nativeTest("human helper edits and unlisted entries are preserved but cannot be loaded as the original immutable version",async()=>{
  const f=fixture();try{
    const a=f.actor(),skill=(await a.call("skill.publish",a.input("1.0.0"))).result.skill,helper=join(skill.installedPath,"nested/helper.txt"),session=await a.session();
    chmodSync(helper,0o600);writeFileSync(helper,"Actual human modified helper");chmodSync(helper,0o400);
    const sent=await a.call("session.send",{sessionId:session,input:"Must not consume edited helpers",skills:["selected"]});await until(()=>a.events.some(event=>event.turnId===sent.result?.turnId&&event.final));
    assert.equal(a.events.find(event=>event.turnId===sent.result.turnId&&event.final)!.type,"error");assert.equal(f.received.length,0);assert.equal(readFileSync(helper,"utf8"),"Actual human modified helper");
    chmodSync(helper,0o600);writeFileSync(helper,"Exact helper 1.0.0");chmodSync(helper,0o400);chmodSync(skill.installedPath,0o700);writeFileSync(join(skill.installedPath,"unlisted.txt"),"Human content must be preserved");chmodSync(skill.installedPath,0o500);
    const extra=await a.call("session.send",{sessionId:session,input:"Must not consume unlisted content",skills:["selected"]});await until(()=>a.events.some(event=>event.turnId===extra.result?.turnId&&event.final));
    assert.equal(a.events.find(event=>event.turnId===extra.result.turnId&&event.final)!.type,"error");assert.equal(f.received.length,0);assert.equal(readFileSync(join(skill.installedPath,"unlisted.txt"),"utf8"),"Human content must be preserved");
  }finally{await f.close();}
});

nativeTest("a later legacy update cannot use legacy removal to leave an older queued immutable version authorized",async()=>{
  const f=fixture();try{
    const a=f.actor();assert.ok((await a.call("skill.publish",a.input("1.0.0"))).result);const session=await a.session();await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const queued=await a.call("session.send",{sessionId:session,input:"Must remain revocable",skills:["selected"]});
    const legacy=await a.call("skill.install",{clientRequestId:"explicit-legacy-selection",agent:"mock:default",name:"selected",scope:"project",projectId:"project-a",source:{kind:"inline",files:{"SKILL.md":"Explicit legacy user content"}}});assert.ok(legacy.result);
    assert.equal((await a.call("skill.uninstall",{agent:"mock:default",name:"selected",scope:"project",projectId:"project-a"})).error?.data?.appCode,"errCapabilityUnsupported");
    assert.equal((await a.call("skill.unpublish",{clientRequestId:"revoke-all-history",agent:"mock:default",name:"selected",projectId:"project-a",baseRevision:legacy.result.skill.revision})).result?.deactivated,true);
    f.release();await until(()=>a.events.some(event=>event.turnId===queued.result.turnId&&event.final));assert.equal(a.events.find(event=>event.turnId===queued.result.turnId&&event.final)!.type,"error");assert.equal(f.received.length,1);
    assert.equal(readFileSync(join(f.root,"a/.agent/skills/selected/SKILL.md"),"utf8"),"Explicit legacy user content");
  }finally{await f.close();}
});

nativeTest("lost publication acknowledgement leaves a complete but unselected tree and never prevents loading the still-selected immutable version",async()=>{
  const f=fixture();try{
    const a=f.actor(),first=(await a.call("skill.publish",a.input("1.0.0"))).result.skill,call=f.broker.call.bind(f.broker);let published:string|undefined;
    f.broker.call=async request=>{const result=await call(request);if(request.operation==="publish_tree"){published=request.destinationName;throw Error("controlled lost native publication acknowledgement");}return result;};
    const input=a.input("2.0.0",first.revision);assert.ok((await a.call("skill.publish",input)).error);assert.ok(published);assert.equal(f.store.skillInstallOperation("account-a",input.clientRequestId)!.state,"unknown");
    assert.equal(f.store.loadSkills("account-a")[0]!.publication!.versionId,first.publication.versionId);assert.ok(existsSync(join(f.root,"a/.agent/skill-versions/selected",published!,"SKILL.md")));
    const session=await a.session(),sent=await a.call("session.send",{sessionId:session,input:"Use the still-selected immutable tree",skills:["selected"]});await until(()=>a.events.some(event=>event.turnId===sent.result?.turnId&&event.final));
    assert.equal(f.received.length,1);assert.ok(f.received[0]!.includes("IMMUTABLE_MARKER_1.0.0"));assert.equal(f.received[0]!.includes("IMMUTABLE_MARKER_2.0.0"),false);
    assert.equal((await a.call("skill.publish",input)).error?.data?.appCode,"errSkillInstallUnconfirmed");
  }finally{await f.close();}
});

test("the actual prepared Canvas bundle publishes and verifies every original file without merging or changing a legacy directory",{skip:!artifact||!process.env.PHONON_CANVAS_SKILL_ARCHIVE?"Prepared local Canvas archive required":false},async()=>{
  const f=fixture();try{
    const bytes=readFileSync(process.env.PHONON_CANVAS_SKILL_ARCHIVE!),source={kind:"archive",format:"tar.gz",contentBase64:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex"),sizeBytes:bytes.length};
    const plan=await prepareSkillArchive({...source,format:"tar.gz"}),a=f.actor(),input={...a.input("archive"),source},reply=await a.call("skill.publish",input);assert.ok(reply.result,JSON.stringify(reply));
    assert.ok(plan.files.length>1000);for(const file of plan.files)assert.deepEqual(readFileSync(join(reply.result.skill.installedPath,file.path)),file.data);
    assert.equal(reply.result.skill.hash,source.sha256);assert.equal(existsSync(join(f.root,"a/.agent/skills/selected")),false);
    const session=await a.session(),sent=await a.call("session.send",{sessionId:session,input:"Read the real published Canvas instructions",skills:["selected"]});assert.ok(sent.result,JSON.stringify(sent));
    // Full-tree verification uses the native broker's bounded 30-second I/O budget.
    await until(()=>a.events.some(event=>event.turnId===sent.result.turnId&&event.final),{timeoutMs:35000,details:()=>({turnId:sent.result.turnId,received:f.received.length,events:a.events.slice(-4).map(event=>({type:event.type,turnId:event.turnId,status:event.status,final:event.final,error:event.error}))})});
    assert.equal(a.events.find(event=>event.turnId===sent.result.turnId&&event.final)!.status,"completed");assert.equal(f.received.length,1);
  }finally{await f.close();}
});
