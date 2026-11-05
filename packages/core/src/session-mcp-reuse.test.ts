import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {AgentInteractionBridge} from './agent-interaction-bridge.js';

const handlers=(fn:(input:any)=>Promise<any>):ConstructorParameters<typeof AgentInteractionBridge>=>[fn,()=>{}];
const reply=async(input:any)=>({requestId:input.requestId,action:'cancel' as const});
function client(env:Record<string,string>){
  return async(method:string,params:unknown={})=>{
    const response=await fetch(env.AGENT_PHONON_MCP_URL!,{method:'POST',headers:{authorization:'Bearer '+env.AGENT_PHONON_INTERACTION_TOKEN,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return await response.json() as any;
  };
}
const call={name:'phonon_request_interaction',arguments:{requestId:'same-request',form:{title:'Question',fields:[]}}};

test('session MCP retains endpoint, token and exact catalog through repeated turns; idle calls are rejected',async()=>{
  let first=0,second=0;
  const bridge=new AgentInteractionBridge(...handlers(async i=>{first++;return reply(i);}));
  try{
    const env=await bridge.listen(),rpc=client(env),catalog=await rpc('tools/list');
    assert.equal((await rpc('tools/call',call)).result.isError,undefined);
    bridge.suspend();assert.equal((await rpc('tools/call',call)).result.isError,true);
    for(let n=0;n<4;n++){
      bridge.rebind(...handlers(async i=>{second++;return reply(i);}));
      assert.deepEqual(await bridge.listen(),env);
      assert.deepEqual(await rpc('tools/list'),catalog);
      assert.equal((await rpc('tools/call',call)).result.isError,undefined);
      bridge.suspend();
    }
    assert.equal(first,1);assert.equal(second,4);
    await bridge.close();await assert.rejects(rpc('tools/list'));
  }finally{await bridge.close();}
});

test('delayed previous-turn response cannot be acknowledged or delivered under a new turn',async()=>{
  let resolve!:(value:any)=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>entered=r);
  const bridge=new AgentInteractionBridge(...handlers(async()=>{entered();return await new Promise(r=>resolve=r);}));
  try{
    const rpc=client(await bridge.listen());const pending=rpc('tools/call',call);await waiting;
    bridge.suspend();bridge.rebind(...handlers(reply));
    resolve({requestId:'same-request',action:'submit',values:{}});
    assert.equal((await pending).result.isError,true);
    const ack=await rpc('tools/call',{name:'phonon_acknowledge_interaction',arguments:{requestId:'same-request',decisionHash:'a'.repeat(64)}});
    assert.equal(ack.result.isError,true);
    assert.equal((await rpc('tools/call',call)).result.isError,undefined);
  }finally{await bridge.close();}
});

test('a slow request body is pinned to admission and cannot invoke the next turn',async()=>{
  let calls=0;
  const bridge=new AgentInteractionBridge(...handlers(async i=>{calls++;return reply(i);}));
  try{
    const env=await bridge.listen();
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:call});
    let finish!:()=>void;
    const response=new Promise<any>((resolve,reject)=>{
      const req=request(env.AGENT_PHONON_MCP_URL!,{method:'POST',headers:{authorization:'Bearer '+env.AGENT_PHONON_INTERACTION_TOKEN,'content-type':'application/json',accept:'application/json, text/event-stream','content-length':Buffer.byteLength(body)}},res=>{
        let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve(JSON.parse(data)));
      });
      req.on('error',reject);req.write(body.slice(0,1));finish=()=>req.end(body.slice(1));
    });
    // Observe receipt of the actual partial HTTP body, not an arbitrary sleep.
    const server=(bridge as unknown as {server:import('node:http').Server}).server;
    await new Promise<void>(resolve=>server.once('request',()=>resolve()));
    bridge.suspend();bridge.rebind(...handlers(async i=>{calls++;return reply(i);}));finish();
    assert.equal((await response).result.isError,true);assert.equal(calls,0);
  }finally{await bridge.close();}
});

test('separate session tokens remain isolated and tool capability changes cannot silently expand a catalog',async()=>{
  const a=new AgentInteractionBridge(...handlers(reply)),b=new AgentInteractionBridge(...handlers(reply));
  try{
    const ea=await a.listen(),eb=await b.listen();assert.notEqual(ea.AGENT_PHONON_INTERACTION_TOKEN,eb.AGENT_PHONON_INTERACTION_TOKEN);
    const response=await fetch(ea.AGENT_PHONON_MCP_URL!,{method:'POST',headers:{authorization:'Bearer '+eb.AGENT_PHONON_INTERACTION_TOKEN},body:'{}'});
    assert.equal(response.status,403);
    a.suspend();assert.throws(()=>a.rebind(undefined,undefined));
    assert.equal((await client(ea)('tools/call',call)).result.isError,true);
  }finally{await a.close();await b.close();}
});


test('late previous-turn suspendIfOwned cannot suspend a newer rebound binding',async()=>{
  let first=0,second=0;
  const bridge=new AgentInteractionBridge(...handlers(async i=>{first++;return reply(i);}));
  try{
    const env=await bridge.listen(),rpc=client(env);
    const oldGeneration=bridge.ownedGeneration();
    assert.equal((await rpc('tools/call',call)).result.isError,undefined);assert.equal(first,1);
    // Interrupt-equivalent: old turn suspends, replacement rebinds.
    bridge.suspend();
    bridge.rebind(...handlers(async i=>{second++;return reply(i);}));
    const newGeneration=bridge.ownedGeneration();
    assert.notEqual(newGeneration,oldGeneration);
    assert.deepEqual(await bridge.listen(),env);
    // Late old finally / abort listener must be a no-op against the new binding.
    assert.equal(bridge.suspendIfOwned(oldGeneration),false);
    assert.equal((await rpc('tools/call',call)).result.isError,undefined);assert.equal(second,1);
    assert.equal(bridge.suspendIfOwned(newGeneration),true);
    assert.equal((await rpc('tools/call',call)).result.isError,true);
  }finally{await bridge.close();}
});

test('close during listen settles the wait and revokes the token instead of hanging',async()=>{
  const bridge=new AgentInteractionBridge(...handlers(reply));
  // Inject a never-completing listen wait to prove close rejects it (P2 mid-bind close).
  let rejectListen!:(error:Error)=>void;
  const stuck=new Promise<void>((_resolve,reject)=>{rejectListen=reject;});
  (bridge as any).listenWait={resolve:()=>{},reject:rejectListen};
  const closed=bridge.close();
  await assert.rejects(stuck,/bridge closed/);
  await closed;
  assert.equal((bridge as any).listenWait,undefined);
  assert.equal((bridge as any).token,"");
  assert.equal((bridge as any).environment,undefined);
  assert.equal((bridge as any).server,undefined);
});
