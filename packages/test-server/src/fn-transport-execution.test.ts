import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AdapterRegistry,PhononClient,RpcPeer} from '@agent-phonon/core';
import {PhononServer,type PhononDevice} from '@agent-phonon/server-sdk';
import {MockAdapter} from './harness.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(yes=>setTimeout(yes,10));}throw Error('transport execution condition timed out');}

for(const offlineCompletion of [true,false])test(`lost sockets retain the original turn; completion ${offlineCompletion?'offline':'after reconnect'} never starts another attempt`,{timeout:15000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'phonon-transport-execution-')),started=deferred(),finish=deferred(),devices:PhononDevice[]=[];
 const server=new PhononServer({host:'127.0.0.1',port:0,authenticate:async()=>({tenantId:'owner'})});server.on('device',device=>devices.push(device));
 const registry=new AdapterRegistry(),adapter=new MockAdapter();let sends=0,aborts=0,sessionId='',turnId='';
 const create=adapter.createSession.bind(adapter);
 adapter.createSession=async params=>{const session=await create(params);sessionId=params.sessionId;
  session.send=async(_input,options)=>{sends++;turnId=options.turnId;let completed=false;options.signal?.addEventListener('abort',()=>{if(!completed)aborts++;finish.resolve();},{once:true});started.resolve();await finish.promise;completed=true;
   options.emit({type:'result',sessionId:params.sessionId as never,turnId:options.turnId,seq:0,at:new Date().toISOString(),text:'offline completed',status:'completed',final:true} as never);};return session;};registry.register(adapter);
 const client=new PhononClient({serverUrl:`ws://127.0.0.1:${await server.listen()}`,deviceId:'offline-native',registry,expectedTenantId:'owner',trustLocal:true,workspaceRoot:root});
 try{
  await client.connect();const original=client.connection!,device=devices[0]!;
  const project=((await device.call('project.create',{name:'offline',git:false})) as any).project.projectId;
  const workflow:any=await device.call('workflow.run',{project,clientRequestId:'native-'+randomUUID(),metadata:{native_run_id:randomUUID(),native_chat:true},plan:{mode:'dag',nodes:[{nodeId:'reply',agent:'mock:default',model:'m1',input:'only once'}]}});
  await started.promise;device.disconnect();await until(()=>!client.connection);
  assert.equal(original.isDisposed,false);assert.equal(aborts,0);
  if(offlineCompletion){finish.resolve();await until(()=>(original as any).workflows.status(workflow.workflowId).status==='completed');}
  await client.connect();assert.equal(client.connection,original);assert.equal(sends,1);assert.equal(aborts,0);
  if(!offlineCompletion){assert.equal((original as any).workflows.status(workflow.workflowId).status,'running');finish.resolve();await until(()=>(original as any).workflows.status(workflow.workflowId).status==='completed');}
  const replacement=devices.at(-1)!;const status:any=await replacement.call('workflow.status',{workflowId:workflow.workflowId});
  assert.equal(status.status,'completed');assert.equal(status.nodes[0]?.sessionId,sessionId);assert.equal(status.nodes[0]?.turnId,turnId);
  const events:any=await replacement.call('workflow.events.list',{workflowId:workflow.workflowId,fromSeq:0,limit:200});
  assert.ok(events.events.some((event:any)=>event.type==='workflow.status'&&event.status==='completed'));
 }finally{finish.resolve();await client.close();await server.close();rmSync(root,{recursive:true,force:true});}
});

test('detached RPC preserves human decision identity, rejects uncertain effects, and fences late old replies',async()=>{
 const first:string[]=[],second:string[]=[],gate=deferred();
 const peer=new RpcPeer({send:data=>first.push(data),close(){}},async()=>{await gate.promise;return 'late';});
 try{
  const requestId=randomUUID(),decision=peer.requestRaw('interaction.request',{requestId},0);
  const uncertain=assert.rejects(peer.requestRaw('document.send',{requestId:'original-publication'},0),/unconfirmed/);
  const late=peer.handle(JSON.stringify({jsonrpc:'2.0',id:900,method:'slow'}));
  peer.detachTransport('network lost');await uncertain;
  peer.attachTransport({send:data=>second.push(data),close(){}});
  gate.resolve();await late;assert.equal(second.length,1);assert.equal(second[0],first[0]);
  const wire=JSON.parse(second[0]!);await peer.handle(JSON.stringify({jsonrpc:'2.0',id:wire.id,result:{requestId,action:'submit',values:{approve:false}}}));
  assert.deepEqual(await decision,{requestId,action:'submit',values:{approve:false}});
  assert.equal(second.some(data=>JSON.parse(data).method==='document.send'),false);
  peer.detachTransport('second outage');
  const offlineID=randomUUID(),offline=peer.requestRaw('interaction.request',{requestId:offlineID},0);
  const count=second.length;assert.equal(second.length,count);
  peer.attachTransport({send:data=>second.push(data),close(){}});
  const newWire=JSON.parse(second.at(-1)!);assert.equal(newWire.params.requestId,offlineID);
  await peer.handle(JSON.stringify({jsonrpc:'2.0',id:newWire.id,result:{requestId:offlineID,action:'cancel'}}));
  assert.deepEqual(await offline,{requestId:offlineID,action:'cancel'});
 }finally{gate.resolve();peer.dispose();}
});
