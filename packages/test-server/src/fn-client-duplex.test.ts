import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry,PhononClient } from "@agent-phonon/core";
import { PhononServer,type PhononDevice } from "@agent-phonon/server-sdk";
import { MockAdapter } from "./harness.js";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function within<T>(operation:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("duplex request blocked")),2000);})]);}finally{clearTimeout(timer);}}

test("real client dispatches reverse-RPC proofs and replies while a tool-gap request is still pending",{timeout:10000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-duplex-")),started=deferred(),gapStarted=deferred(),gap=deferred(),finish=deferred();
  const server=new PhononServer({host:"127.0.0.1",port:0,authenticate:async(_id,key)=>key==="test-device-key"?{tenantId:"owner"}:null});
  let device:PhononDevice|undefined,options:any,sessionID="";
  server.on("device",value=>{
    device=value;
    value.setConversationMessageHandler(async(params:any)=>{
      const status=await value.call("session.status",{sessionId:params.sessionId});
      assert.equal(status.status,"running");
      return {status:"not_found",requestId:params.requestId};
    });
  });
  const adapter=new MockAdapter({caps:{injectMidTurn:true}}),original=adapter.createSession.bind(adapter),registry=new AdapterRegistry();
  adapter.createSession=async params=>{
    const session=await original(params);sessionID=params.sessionId;
    session.send=async(_input,context)=>{options=context;started.resolve();context.signal?.addEventListener("abort",finish.resolve,{once:true});await finish.promise;
      context.emit({type:"result",sessionId:params.sessionId as never,turnId:context.turnId,seq:0,at:new Date().toISOString(),text:"done",status:"completed",final:true} as never);};
    session.insertAtToolGap=async(_input,context)=>{gapStarted.resolve();context.signal.addEventListener("abort",gap.resolve,{once:true});await gap.promise;if(context.signal.aborted)throw new Error("gap ended");};
    return session;
  };
  registry.register(adapter);
  const client=new PhononClient({serverUrl:`ws://127.0.0.1:${await server.listen()}`,deviceId:"duplex",deviceKey:"test-device-key",expectedTenantId:"owner",registry,trustLocal:true,workspaceRoot:root});
  let insertion:Promise<any>|undefined;
  try{
    await client.connect();assert.ok(device);
    const project=((await device.call("project.create",{name:"duplex",git:false})) as {project:{projectId:string}}).project.projectId;
    await device.call("workflow.run",{project,metadata:{native_run_id:randomUUID(),native_chat:true},plan:{mode:"dag",nodes:[{nodeId:"reply",agent:"mock:default",model:"m1",input:"hold"}],finalNodeId:"reply"}});
    await within(started.promise);
    let acknowledged=false;
    insertion=device.call("session.send",{sessionId:sessionID,input:"steer",whenBusy:"inject",turnId:options.turnId,clientRequestId:randomUUID()}).then(result=>{acknowledged=true;return result;});
    await within(gapStarted.promise);
    const requestId=randomUUID(),result=await within(options.conversationMessage({operation:"status",requestId}));
    assert.deepEqual(result,{status:"not_found",requestId});assert.equal(acknowledged,false);
    gap.resolve();assert.equal((await within(insertion)).disposition,"injected");
  }finally{
    gap.resolve();finish.resolve();await insertion?.catch(()=>{});client.close();await server.close();rmSync(root,{recursive:true,force:true});
  }
});
