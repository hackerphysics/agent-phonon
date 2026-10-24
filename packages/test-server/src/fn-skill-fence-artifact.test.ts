import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,realpath,readFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {PhononServer} from "@agent-phonon/server-sdk";

const entry=process.env.PHONON_SKILL_DAEMON_ENTRY;
test("prepared daemon metadata fencing works over actual SDK/WebSocket and preserves unknown target files",{skip:!entry?"Prepared maintained-source daemon required":false},async()=>{
  const {PhononDaemon}=await import(pathToFileURL(resolve(entry!)).href),root=await realpath(await mkdtemp(join(tmpdir(),"phonon-packaged-fence-")));
  const capabilities={nativeSession:false,nativeCompression:false,contextInjection:false,proactiveOutput:false,modelSwitch:false,interrupt:false,injectMidTurn:false,skillManagement:true,hooks:[],streaming:false};
  class Adapter{name="mock";capabilities=capabilities;async discoverAgents(){return [];}async createSession(){throw Error("No model is used for metadata recovery");}}
  const server=new PhononServer({host:"127.0.0.1",port:0,authenticate:async()=>({tenantId:"packaged-fence-owner"})});let daemon:any;
  try{
    const port=await server.listen(),attached=new Promise<any>(done=>server.once("device",done));
    daemon=new PhononDaemon({deviceId:"packaged-fence-"+randomUUID(),dbPath:join(root,"native.db"),workspaceRoot:root,logLevel:"error",hookBridge:{port:0,token:"synthetic-private-hook"},obs:{enabled:false},rescueAgent:{enabled:false},adapters:[],
      servers:[{url:`ws://127.0.0.1:${port}`,deviceKey:"synthetic-device-key",expectedTenantId:"packaged-fence-owner",policy:{allowedAgents:["mock:fence"],allowedProjectRoots:[root],allowSkillRecovery:true,
        allowedMethods:["device.info","discovery.list","project.create","project.get","skill.install","skill.install.status","skill.install.fence","skill.uninstall"]}}]}, {adapters:[new Adapter()]});
    await daemon.start();const device=await attached,info=await device.info();assert.ok(info.capabilities.includes("skill_install_fence_v1"));
    const project=(await device.project.create({name:"Owned recovery",git:false})).project;
    const originalRequestId="oversized-entry-"+randomUUID(),scope={agent:"mock:fence",name:"fixed",scope:"project" as const,projectId:project.projectId,clientRequestId:originalRequestId};
    const content="x".repeat(1024*1024);
    await assert.rejects(device.skill.install({...scope,source:{kind:"inline",files:{"SKILL.md":content}}}));
    const observed=await device.skill.installStatus({...scope,includeRecoveryContext:true});assert.equal(observed.state,"unknown");
    if(observed.state==="not_found"||!observed.recovery)throw Error("exact owned recovery context required");
    const result=await device.skill.fence({clientRequestId:"human-fence-"+randomUUID(),originalRequestId,agent:scope.agent,name:scope.name,scope:scope.scope,projectId:scope.projectId,
      expectedReceiverID:observed.recovery.receiverID,baseRecoveryRevision:observed.recovery.revision});
    assert.equal(result.outcomeKnown,false);assert.equal(result.targetLocked,true);assert.equal(result.filesDeleted,false);assert.equal(result.originalWritesMayContinue,true);
    assert.equal((await readFile(join(project.path,".agent/skills/fixed/SKILL.md"),"utf8")).length,content.length);
    const current=await device.skill.installStatus({...scope,includeRecoveryContext:true});assert.equal(current.state,"unknown");if(current.state==="not_found")throw Error("original operation must remain");assert.equal(current.recovery?.fenceID,result.fenceID);
    await assert.rejects(device.skill.install({...scope,clientRequestId:"cannot-bypass",source:{kind:"inline",files:{"SKILL.md":"Not allowed after an unknown write"}}}));
    await assert.rejects(device.skill.uninstall(scope));
  }finally{await daemon?.stop();await server.close();await rm(root,{recursive:true,force:true});}
});
