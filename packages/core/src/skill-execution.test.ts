import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,writeFileSync,renameSync,linkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PhononConnection} from "./index.js";
import {PhononStore} from "./store.js";
import {AdapterRegistry} from "./session-engine.js";
import {NativeFileBroker} from "./native-file-broker.js";
import {AgentCapabilities,AgentDescriptor,AgentId,SessionId} from "@agent-phonon/protocol";
import type {AgentAdapter,SendOptions} from "./adapter.js";

const artifact=process.env.PHONON_FS_BROKER_ARTIFACT_ROOT;
const skillTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!artifact?"Prepared local native file broker required":false},fn);
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error("skill turn did not settle");await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-skill-execution-"))),store=new PhononStore(join(root,"native.db")),registry=new AdapterRegistry();
  const capabilities=AgentCapabilities.parse({nativeSession:true,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,
    interrupt:true,injectMidTurn:true,skillManagement:true,reasoningControl:true,hooks:[],streaming:true});
  const received:Array<{input:string;options:SendOptions}>=[],inserted:string[]=[],holds:Array<()=>void>=[];
  const adapter:AgentAdapter={name:"mock",capabilities,async discoverAgents(){return ["mock:default","mock:other"].map(agentId=>AgentDescriptor.parse({agentId,displayName:agentId,adapter:"mock",available:true,models:[{id:"m1",available:true}],capabilities,scannedAt:new Date().toISOString()}));},
    globalSkillDir:agent=>join(root,"global",agent.replace(":","-")),async createSession(params){return {sessionId:params.sessionId,model:params.model,
      async terminate(){for(const release of holds.splice(0))release();},async interrupt(){for(const release of holds.splice(0))release();},
      async insertAtToolGap(input){inserted.push(input);},async send(input,options){received.push({input,options});if(input==="HOLD")await new Promise<void>(resolve=>holds.push(resolve));
        if(options.reasoning)options.acknowledgeReasoning?.("high");
        options.emit({type:"result",sessionId:SessionId.parse(params.sessionId),turnId:options.turnId,seq:0,at:new Date().toISOString(),origin:"solicited",status:"completed",final:true,text:"Controlled skill turn"});}};}};
  registry.register(adapter);
  for(const owner of ["a","b"]){const path=join(root,owner);mkdirSync(path);store.upsertProject({projectId:"project-"+owner,name:owner,path,namespace:"account-"+owner,git:false,createdAt:new Date().toISOString()});}
  let sequence=0;
  const connections:PhononConnection[]=[],stores=[store];
  const actor=(owner:string,broker=true,data=store)=>{
    const replies:Array<Record<string,any>>=[],events:Array<Record<string,any>>=[];
    const options={tenantId:"account-"+owner,registry,store:data,workspaceRoot:root,
      policy:{allowedAgents:[AgentId.parse("mock:default"),AgentId.parse("mock:other")],allowGlobalSkillInstall:true},
      ...(broker?{nativeFileBroker:new NativeFileBroker(artifact!)}:{}),
      transport:{send:(value:string)=>{const message=JSON.parse(value);if(message.method==="stream.event")events.push(message.params);else replies.push(message);},close:()=>{}}};
    const connection=new PhononConnection(options);connections.push(connection);
    return {connection,events,async call(method:string,params:unknown){const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:"2.0",id,method,params}));const reply=replies.find(value=>value.id===id);assert.ok(reply);return reply;},
      async install(name="selected",version="1.2.3",scope:"project"|"global"="project",marker="OWNED_SKILL_MARKER"){
        const source={kind:"inline",files:{"SKILL.md":`---\nname: ${name}\nversion: ${version}\n---\n${marker}\n`}};
        const result=await this.call("skill.install",{agent:"mock:default",name,scope,...(scope==="project"?{projectId:"project-"+owner}:{}),source,clientRequestId:"install-"+ ++sequence});
        assert.ok(result.result,JSON.stringify(result));return result.result.skill;
      },async session(agent="mock:default"){const result=await this.call("session.create",{project:"project-"+owner,agent,model:"m1",verbosity:"messages"});assert.ok(result.result);return result.result.sessionId;}};
  };
  return {root,store,registry,actor,received,inserted,reopen(){const data=new PhononStore(join(root,"native.db"));stores.push(data);return data;},release(){for(const done of holds.splice(0))done();},async close(){for(const done of holds.splice(0))done();for(const connection of connections)await connection.dispose();for(const data of stores)data.close();rmSync(root,{recursive:true,force:true});}};
}

skillTest("actual structured skill selection loads owned installed content/path/version instead of binding an object into SQLite",async()=>{
  const f=fixture();try{
    const a=f.actor("a"),skill=await a.install(),session=await a.session();
    f.store.envSet({tenantId:"account-a",scope:"skill",projectId:"project-a",agent:"mock:default",skillName:"selected",name:"SKILL_SETTING",value:"scoped-runtime-value",secret:true,updatedAt:new Date().toISOString()});
    const response=await a.call("session.send",{sessionId:session,input:"Original task",skills:[{name:"selected",scope:"project",version:"1.2.3",force:true}]});
    assert.ok(response.result,JSON.stringify(response));await until(()=>a.events.some(event=>event.turnId===response.result.turnId&&event.final));
    assert.equal(f.received.length,1);assert.ok(f.received[0]!.input.includes("OWNED_SKILL_MARKER"));
    const context=JSON.parse(f.received[0]!.input.split("\n")[1]!);assert.equal(context.skills[0].baseDirectory,skill.installedPath);
    assert.ok(f.received[0]!.input.includes('"version":"1.2.3"'));assert.ok(f.received[0]!.input.includes("Original task"));
    assert.equal(f.received[0]!.input.includes("[object Object]"),false);assert.equal(f.received[0]!.input.includes("scoped-runtime-value"),false);
    assert.deepEqual(f.received[0]!.options.skills,["selected"]);assert.equal(f.received[0]!.options.environment?.SKILL_SETTING,"scoped-runtime-value");
  }finally{await f.close();}
});

skillTest("skill authority withdrawn during asynchronous runtime preparation is checked again at actual dispatch",async()=>{
  const f=fixture();let release!:()=>void;
  try{
    const a=f.actor("a");await a.install();const session=await a.session();let entered!:()=>void;
    const arrived=new Promise<void>(done=>{entered=done;}),gate=new Promise<void>(done=>{release=done;});
    const previous=f.registry.inventory.list.bind(f.registry.inventory);
    f.registry.inventory.list=async()=>{entered();await gate;return (await previous()).map(agent=>({...agent,models:agent.models.map(model=>({...model,reasoningLevels:["high" as const]}))}));};
    const response=await a.call("session.send",{sessionId:session,input:"Must not start after withdrawal",skills:["selected"],reasoning:{level:"high"}});assert.ok(response.result);
    await arrived;f.store.deleteSkill({tenantId:"account-a",agent:"mock:default",name:"selected",scope:"project",projectId:"project-a"});release();
    await until(()=>a.events.some(event=>event.turnId===response.result.turnId&&event.final));assert.equal(f.received.length,0);
    assert.equal(a.events.find(event=>event.turnId===response.result.turnId&&event.final)!.type,"error");
  }finally{release?.();await f.close();}
});

skillTest("receiver-confirmed entry identity survives a new connection/store without being exposed as a public grant",async()=>{
  const f=fixture();try{
    const a=f.actor("a");await a.install();const reconnected=f.actor("a",true,f.reopen()),session=await reconnected.session();
    const result=await reconnected.call("session.send",{sessionId:session,input:"After reopen",skills:[{name:"selected",scope:"project",version:"1.2.3"}]});assert.ok(result.result);
    await until(()=>reconnected.events.some(event=>event.turnId===result.result.turnId&&event.final));assert.equal(f.received.length,1);assert.ok(f.received[0]!.input.includes("OWNED_SKILL_MARKER"));
    const metadata=await reconnected.call("skill.list",{});assert.equal(JSON.stringify(metadata).includes("installationId"),false);assert.equal(JSON.stringify(metadata).includes("rootIdentity"),false);
  }finally{await f.close();}
});

skillTest("an uncertain auxiliary-file update blocks new and already-queued skill use even when SKILL.md bytes still match",async()=>{
  const f=fixture();try{
    const a=f.actor("a"),original=await a.install(),entry=readFileSync(join(original.installedPath,"SKILL.md"),"utf8"),session=await a.session();
    await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const queued=await a.call("session.send",{sessionId:session,input:"Must not consume partial helpers",skills:["selected"]});assert.equal(queued.result?.disposition,"queued");
    const manager=(a.connection as unknown as {skills:{writeSkillFile:(...args:any[])=>Promise<void>}}).skills,write=manager.writeSkillFile.bind(manager);let writes=0;
    manager.writeSkillFile=async(...args)=>{if(++writes===3)throw Error("controlled incomplete auxiliary update");await write(...args);};
    try{assert.ok((await a.call("skill.install",{clientRequestId:"partial-helper-update",agent:"mock:default",name:"selected",scope:"project",projectId:"project-a",
      source:{kind:"inline",files:{"SKILL.md":entry,"helper.txt":"Unconfirmed auxiliary bytes","second.txt":"Must not complete"}}})).error);}finally{manager.writeSkillFile=write;}
    assert.equal(readFileSync(join(original.installedPath,"SKILL.md"),"utf8"),entry);assert.equal(readFileSync(join(original.installedPath,"helper.txt"),"utf8"),"Unconfirmed auxiliary bytes");
    assert.equal((await a.call("session.send",{sessionId:session,input:"Must not admit partial skill",skills:["selected"]})).error?.data?.appCode,"errSkillInstallUnconfirmed");
    f.release();await until(()=>a.events.some(event=>event.turnId===queued.result.turnId&&event.final));
    assert.equal(a.events.find(event=>event.turnId===queued.result.turnId&&event.final)!.type,"error");assert.equal(f.received.length,1);
  }finally{await f.close();}
});

skillTest("an allowed second runtime can load an unambiguous owned Project skill but cannot borrow another runtime's global skill",async()=>{
  const f=fixture();try{
    const a=f.actor("a");await a.install("project-shared","1.2.3","project","SHARED_PROJECT_MARKER");await a.install("global-private","1.2.3","global","RUNTIME_GLOBAL_MARKER");
    const session=await a.session("mock:other"),shared=await a.call("session.send",{sessionId:session,input:"Shared Project",skills:[{name:"project-shared",scope:"project"}]});assert.ok(shared.result);
    await until(()=>a.events.some(event=>event.turnId===shared.result.turnId&&event.final));assert.equal(f.received.length,1);assert.ok(f.received[0]!.input.includes("SHARED_PROJECT_MARKER"));
    const global=await a.call("session.send",{sessionId:session,input:"Must not borrow global",skills:[{name:"global-private",scope:"global",force:true}]});assert.equal(global.error?.data?.appCode,"errSkillNotFound");assert.equal(f.received.length,1);
  }finally{await f.close();}
});

skillTest("skill insertion loads the exact document into the active turn without claiming a new model invocation",async()=>{
  const f=fixture();try{
    const a=f.actor("a");await a.install();const session=await a.session();const held=await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const inserted=await a.call("session.send",{sessionId:session,input:"Injected task",skills:[{name:"selected",scope:"project",force:false}],whenBusy:"inject",turnId:held.result.turnId});
    assert.equal(inserted.result?.disposition,"injected");assert.equal(inserted.result?.turnId,held.result.turnId);
    assert.equal(f.received.length,1);assert.equal(f.inserted.length,1);assert.ok(f.inserted[0]!.includes("OWNED_SKILL_MARKER"));assert.ok(f.inserted[0]!.includes("Injected task"));
    f.release();await until(()=>a.events.some(event=>event.turnId===held.result.turnId&&event.final));
  }finally{await f.close();}
});

skillTest("untrusted selection fields, empty names and unbounded selections cannot reach the loader or model",async()=>{
  const f=fixture();try{
    const a=f.actor("a");await a.install();const session=await a.session();
    for(const skills of [[{name:"selected",scope:"project",path:"/foreign",owner:"forged"}], ["../foreign"], [""], Array(17).fill("selected")]){
      const response=await a.call("session.send",{sessionId:session,input:"Must not start",skills});assert.equal(response.error?.data?.appCode,"errInvalidParams");
    }
    assert.equal(f.received.length,0);
  }finally{await f.close();}
});

skillTest("queued selections recheck live Project ownership after the original source was admitted",async()=>{
  const f=fixture();try{
    const a=f.actor("a");await a.install();const session=await a.session();await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const queued=await a.call("session.send",{sessionId:session,input:"Queued after removal",skills:["selected"]});assert.equal(queued.result?.disposition,"queued");
    f.store.deleteProject("project-a");f.release();await until(()=>a.events.some(event=>event.turnId===queued.result.turnId&&event.final));
    assert.equal(a.events.find(event=>event.turnId===queued.result.turnId&&event.final)!.type,"error");assert.equal(f.received.length,1);
  }finally{await f.close();}
});

skillTest("a same-byte reinstall still cannot replace the original queued installation identity",async()=>{
  const f=fixture();try{
    const a=f.actor("a");const old=await a.install();const session=await a.session();await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const queued=await a.call("session.send",{sessionId:session,input:"Frozen original install",skills:["selected"]});assert.equal(queued.result?.disposition,"queued");
    const next=await a.install();assert.equal(next.hash,old.hash);f.release();await until(()=>a.events.some(event=>event.turnId===queued.result.turnId&&event.final));
    assert.equal(a.events.find(event=>event.turnId===queued.result.turnId&&event.final)!.type,"error");assert.equal(f.received.length,1);
  }finally{await f.close();}
});

skillTest("a selected entry cannot become a foreign hardlink after its receipt was confirmed",async()=>{
  const f=fixture();try{
    const a=f.actor("a"),skill=await a.install(),session=await a.session(),outside=join(f.root,"b/private.txt");writeFileSync(outside,"PRIVATE_B_BYTES");
    rmSync(join(skill.installedPath,"SKILL.md"));linkSync(outside,join(skill.installedPath,"SKILL.md"));
    const response=await a.call("session.send",{sessionId:session,input:"Must not disclose",skills:["selected"]});
    if(response.result)await until(()=>a.events.some(event=>event.turnId===response.result.turnId&&event.final));else assert.ok(response.error);
    assert.equal(f.received.length,0);assert.equal(JSON.stringify(a.events).includes("PRIVATE_B_BYTES"),false);
  }finally{await f.close();}
});

skillTest("legacy or manually seeded metadata cannot manufacture a receiver-confirmed execution receipt",async()=>{
  const f=fixture();try{
    const a=f.actor("a"),skill=await a.install(),session=await a.session();
    f.store.upsertSkill({...skill,tenantId:"account-a"});
    const response=await a.call("session.send",{sessionId:session,input:"Must not infer confirmation",skills:["selected"]});
    assert.equal(response.error?.data?.appCode,"errSkillScopeInvalid");assert.equal(f.received.length,0);assert.equal(readFileSync(join(skill.installedPath,"SKILL.md"),"utf8").includes("OWNED_SKILL_MARKER"),true);
  }finally{await f.close();}
});

skillTest("missing, foreign and wrong-version selections are refused without invoking a model",async()=>{
  const f=fixture();try{
    const a=f.actor("a"),b=f.actor("b");await b.install("private", "1.2.3", "global", "FOREIGN_SECRET");await a.install();const session=await a.session();
    for(const selection of ["missing",{name:"private",scope:"global",force:true},{name:"selected",scope:"project",version:"9.9.9",force:false}]){
      const response=await a.call("session.send",{sessionId:session,input:"Must not start",skills:[selection]});assert.ok(response.error);assert.equal(f.received.length,0);
      assert.equal(JSON.stringify(response).includes("FOREIGN_SECRET"),false);
    }
  }finally{await f.close();}
});

skillTest("project precedence and explicit global scope use their actual owned documents",async()=>{
  const f=fixture();try{
    const a=f.actor("a");await a.install("same","1.0.0","global","GLOBAL_MARKER");await a.install("same","2.0.0","project","PROJECT_MARKER");const session=await a.session();
    for(const selection of ["same",{name:"same",scope:"global",version:"1.0.0",force:false}]){
      const response=await a.call("session.send",{sessionId:session,input:"Use requested scope",skills:[selection]});assert.ok(response.result,JSON.stringify(response));await until(()=>a.events.some(event=>event.turnId===response.result.turnId&&event.final));
    }
    assert.ok(f.received[0]!.input.includes("PROJECT_MARKER"));assert.equal(f.received[0]!.input.includes("GLOBAL_MARKER"),false);
    assert.ok(f.received[1]!.input.includes("GLOBAL_MARKER"));assert.equal(f.received[1]!.input.includes("PROJECT_MARKER"),false);
  }finally{await f.close();}
});

skillTest("queued selection cannot silently adopt a replacement installation",async()=>{
  const f=fixture();try{
    const a=f.actor("a");await a.install();const session=await a.session();await a.call("session.send",{sessionId:session,input:"HOLD"});await until(()=>f.received.length===1);
    const queued=await a.call("session.send",{sessionId:session,input:"Queued task",skills:[{name:"selected",version:"1.2.3",scope:"project"}]});assert.equal(queued.result?.disposition,"queued");
    await a.install("selected","2.0.0","project","REPLACEMENT_MARKER");f.release();
    await until(()=>a.events.some(event=>event.turnId===queued.result.turnId&&event.final));
    const event=a.events.find(event=>event.turnId===queued.result.turnId&&event.final)!;assert.equal(event.type,"error");assert.equal(f.received.length,1);
  }finally{await f.close();}
});

skillTest("changed instructions and a replaced root never borrow an old confirmed skill receipt",async()=>{
  const f=fixture();try{
    const a=f.actor("a"),skill=await a.install(),session=await a.session();
    writeFileSync(join(skill.installedPath,"SKILL.md"),"Unconfirmed human edit");
    const changed=await a.call("session.send",{sessionId:session,input:"Must not run",skills:["selected"]});
    if(changed.result)await until(()=>a.events.some(event=>event.turnId===changed.result.turnId&&event.final));else assert.ok(changed.error);
    assert.equal(f.received.length,0);
    await a.install();const project=join(f.root,"a"),old=join(f.root,"old-a");renameSync(project,old);mkdirSync(project);mkdirSync(join(project,".agent/skills/selected"),{recursive:true});
    writeFileSync(join(project,".agent/skills/selected/SKILL.md"),readFileSync(join(old,".agent/skills/selected/SKILL.md")));
    const replaced=await a.call("session.send",{sessionId:session,input:"Must not adopt root",skills:["selected"]});
    if(replaced.result)await until(()=>a.events.some(event=>event.turnId===replaced.result.turnId&&event.final));else assert.ok(replaced.error);
    assert.equal(f.received.length,0);
  }finally{await f.close();}
});
