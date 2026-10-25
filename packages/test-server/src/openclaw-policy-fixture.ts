import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

/** Adapter-only boundary mock. Actual RPC proofs and native enforcement have separate tests. */
export function qualifyOpenClawTestGateway(gateway:any,options:{cwd:string;model:string;agent:string;onConfirm?:(count:number)=>unknown|Promise<unknown>}) {
  assert.ok(Object.hasOwn(gateway,"rpc")&&Object.hasOwn(gateway,"connect"),"Use only with an explicit test transport");
  const originalRpc=gateway.rpc.bind(gateway),originalConnect=gateway.connect.bind(gateway),originalClose=gateway.close?.bind(gateway);
  const connected=Object.hasOwn(gateway,"isConnected")?gateway.isConnected.bind(gateway):undefined;
  const epoch=Object.hasOwn(gateway,"connectionEpoch")?gateway.connectionEpoch.bind(gateway):()=>1;
  let key="",online=false,closed=false,confirmations=0;
  const nativeSessionId=randomUUID(),cwd=realpathSync(options.cwd);
  const grants=new Map<string,{generation:string;epoch:number}>(),ownedRuns=new Set<string>();
  gateway.connect=async()=>{assert(!closed);await originalConnect();online=true;};
  gateway.close=()=>{closed=true;online=false;originalClose?.();};
  gateway.isConnected=()=>!closed&&(connected?connected():online);
  gateway.connectionEpoch=epoch;
  gateway.supportsCapability=(capability:string)=>capability==="session-settings-cas-v1";
  gateway.rpc=async(method:string,params:any)=>{
    if(method==="sessions.create") {
      assert.equal(params.model,options.model);assert.equal(realpathSync(params.cwd),cwd);
      assert.equal(params.key.split(":")[1],options.agent);key=params.key;
      return {...await originalRpc(method,params),key,sessionId:nativeSessionId};
    }
    if(method==="chat.history") {
      assert.equal(params.sessionKey,key);assert.equal(params.agentId,options.agent);
      return {sessionKey:key,sessionId:nativeSessionId,messages:[],totalMessages:0,pendingInputs:{items:[],total:0},
        sessionInfo:{key,sessionId:nativeSessionId,createdAt:1,model:options.model,spawnedCwd:cwd,
          hasActiveRun:false,activeRunIds:[],activeLeafEntryId:null,archived:false,status:"idle"}};
    }
    return originalRpc(method,params);
  };
  gateway.bindNoninteractivePolicy=async(input:any)=>{
    assert.equal(input.sessionKey,key);assert.equal(input.sessionId,nativeSessionId);
    assert.equal(input.agentId,options.agent);assert.equal(input.model,options.model);
    assert.equal(gateway.isConnected(),true);
    const generation=randomUUID(),boundEpoch=epoch();
    grants.set(input.runId,{generation,epoch:boundEpoch});ownedRuns.add(input.runId);
    const confirm=async()=>{
      assert.equal(gateway.isConnected(),true);assert.equal(epoch(),boundEpoch);
      assert.equal(grants.get(input.runId)?.generation,generation);
      await options.onConfirm?.(++confirmations);
    };
    const release=async()=>{if(grants.get(input.runId)?.generation===generation)grants.delete(input.runId);};
    await confirm();
    return {epoch:boundEpoch,confirm,release};
  };
  gateway.rpcOnConnection=async(boundEpoch:number,method:string,params:any,timeout?:number)=>{
    assert.equal(gateway.isConnected(),true);assert.equal(epoch(),boundEpoch);
    if(method==="agent.wait"){assert(ownedRuns.has(params.runId));return gateway.rpc(method,params,timeout);}
    assert.equal(params.sessionKey,key);
    if(method==="chat.send")assert.equal(grants.get(params.idempotencyKey)?.epoch,boundEpoch);
    else {assert.equal(method,"chat.abort");assert(ownedRuns.has(params.runId));}
    return gateway.rpc(method,params,timeout);
  };
  return {nativeSessionId,confirmations:()=>confirmations,activePolicies:()=>grants.size};
}
