import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,realpath,rm,readdir,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {PhononServer} from "@agent-phonon/server-sdk";
import {randomUUID} from "node:crypto";

const entry=process.env.PHONON_SKILL_DAEMON_ENTRY;
async function writableFixture(path:string):Promise<void>{
  await chmod(path,0o700);for(const row of await readdir(path,{withFileTypes:true})){const value=join(path,row.name);if(row.isDirectory())await writableFixture(value);else if(row.isFile())await chmod(value,0o600);}
}
for(const publication of ["legacy","immutable"] as const)test(`prepared daemon loads ${publication} scoped skill bytes through its packaged broker over actual WebSocket RPC`,{skip:!entry?"Prepare a maintained-source daemon with native assets first":false},async()=>{
  const {PhononDaemon}=await import(pathToFileURL(resolve(entry!)).href),root=await realpath(await mkdtemp(join(tmpdir(),"phonon-packaged-skill-ws-")));
  const received:string[]=[],capabilities={nativeSession:true,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,interrupt:false,injectMidTurn:false,skillManagement:true,hooks:[],streaming:true};
  class Adapter{
    name="mock";capabilities=capabilities;
    async discoverAgents(){return [{agentId:"mock:packaged",displayName:"Controlled packaged runtime",adapter:"mock",available:true,models:[{id:"fixture-model",available:true}],capabilities,scannedAt:new Date().toISOString()}];}
    async createSession(params:any){return {sessionId:params.sessionId,model:params.model,async terminate(){},async send(input:string,options:any){received.push(input);options.emit({type:"result",sessionId:params.sessionId,turnId:options.turnId,origin:"solicited",seq:0,at:new Date().toISOString(),status:"completed",final:true,text:"PACKAGED_SKILL_RESULT"});}};}
  }
  const server=new PhononServer({host:"127.0.0.1",port:0,authenticate:async()=>({tenantId:"packaged-owner"})});
  let daemon:any;
  try{
    const port=await server.listen(),attached=new Promise<any>(resolve=>server.once("device",resolve));
    daemon=new PhononDaemon({deviceId:"packaged-skill-"+randomUUID(),dbPath:join(root,"native.db"),workspaceRoot:root,logLevel:"error",
      hookBridge:{port:0,token:"controlled-local-hook-token"},obs:{enabled:false},rescueAgent:{enabled:false},adapters:[],
      servers:[{url:`ws://127.0.0.1:${port}`,deviceKey:"synthetic-local-device-key",expectedTenantId:"packaged-owner",policy:{allowedAgents:["mock:packaged"],allowedProjectRoots:[root],allowedMethods:["device.info","discovery.list","project.create","project.get","skill.install","skill.install.status","skill.publish","skill.unpublish","session.create","session.send","stream.ack"]}}]},
      {adapters:[new Adapter()]});
    await daemon.start();const device=await attached;
    const info=await device.info();assert.ok(info.skillReceiverID);assert.ok(info.capabilities.includes("skill_install_receiver_identity_v1"));
    const project=(await device.project.create({name:"Packaged skill",git:false})).project;
    const clientRequestId="packaged-skill-"+randomUUID(),scope={agent:"mock:packaged",name:"selected",scope:"project" as const,projectId:project.projectId,clientRequestId};
    const source={kind:"inline",files:{"SKILL.md":"---\nversion: 1.2.3\n---\nPACKAGED_EXACT_SKILL_BYTES\n"}};
    const installed=(publication==="immutable"?await device.skill.publish({...scope,baseRevision:null,expectedReceiverID:info.skillReceiverID,source}):await device.skill.install({...scope,source})).skill;
    assert.equal(installed.version,"1.2.3");
    const status=await device.skill.installStatus(scope);assert.equal(status.state,"confirmed");if(status.state!=="confirmed")throw Error("exact native install receipt required");assert.deepEqual(status.result.skill,installed);
    assert.equal(status.receiverID,undefined);
    const proof=await device.skill.installStatus({...scope,includeReceiverIdentity:true});assert.equal(proof.state,"confirmed");
    if(proof.state!=="confirmed")throw Error("original receiver proof required");assert.equal(proof.receiverID,info.skillReceiverID);assert.deepEqual(proof.result.skill,installed);
    const session=await device.createSession({project:project.projectId,agent:"mock:packaged",model:"fixture-model",verbosity:"messages"});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const finished=new Promise<any>((resolve,reject)=>{timer=setTimeout(()=>reject(Error("packaged skill turn did not finish")),5000);session.on("stream",(event:any)=>{if(event.final){clearTimeout(timer);resolve(event);}});});
    await device.call("session.send",{sessionId:session.sessionId,input:"Original packaged task",skills:[{name:"selected",scope:"project",version:"1.2.3",force:true}]});
    const final=await finished;assert.equal(final.status,"completed");assert.equal(final.text,"PACKAGED_SKILL_RESULT");
    assert.equal(received.length,1);assert.ok(received[0]!.includes("PACKAGED_EXACT_SKILL_BYTES"));assert.ok(received[0]!.includes("Original packaged task"));
    const context=JSON.parse(received[0]!.split("\n")[1]!);assert.equal(context.skills[0].baseDirectory,installed.installedPath);
    if(publication==="immutable")assert.equal((await device.skill.unpublish({...scope,clientRequestId:"unpublish-"+clientRequestId,baseRevision:installed.revision!})).deactivated,true);
  }finally{await daemon?.stop();await server.close();await writableFixture(root);await rm(root,{recursive:true,force:true});}
});
