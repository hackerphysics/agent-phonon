import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AdapterRegistry,PhononStore} from '@agent-phonon/core';
import {MockAdapter,TestConn} from './harness.js';

test('retained Dev chat waits for the original adapter invocation to settle before completion or reuse',async()=>{
 const root=mkdtempSync(join(tmpdir(),'phonon-dev-chat-settle-')),store=new PhononStore(join(root,'state.db'));
 let release!:()=>void,emitted!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{emitted=resolve;});
 const adapter=new MockAdapter({reply:()=>{calls++;return 'Original reply';}}),create=adapter.createSession.bind(adapter);
 adapter.createSession=async p=>{const session=await create(p),send=session.send.bind(session);session.send=async(input,options)=>{await send(input,options);if(calls===1){emitted();await gate;}};return session;};
 const registry=new AdapterRegistry();registry.register(adapter);const conn=new TestConn({registry,store,workspaceRoot:root,tenantId:'owned-dev-chat'});
 try{
  const {project}=await conn.call('project.create',{name:'Dev chat settlement'}) as any;
  const run=await conn.call('workflow.run',{project:project.projectId,metadata:{dev_chat:true},plan:{mode:'dag',nodes:[{nodeId:'reply',agent:'mock:default',model:'m1'}],finalNodeId:'reply'}}) as any;
  await seen;await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await conn.call('workflow.status',{workflowId:run.workflowId}) as any).status,'running');
  release();let completed:any;
  for(let n=0;n<100;n++){completed=await conn.call('workflow.status',{workflowId:run.workflowId});if(completed.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(completed.status,'completed');const session=completed.nodes[0].sessionId;
  assert.equal((await conn.call('session.status',{sessionId:session}) as any).status,'idle');
  const second=await conn.call('workflow.run',{project:project.projectId,metadata:{dev_chat:true},plan:{mode:'dag',nodes:[{nodeId:'reply',agent:'mock:default',model:'m1',sessionId:session}],finalNodeId:'reply'}}) as any;
  let next:any;for(let n=0;n<100;n++){next=await conn.call('workflow.status',{workflowId:second.workflowId});if(next.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(next.status,'completed');assert.equal(next.nodes[0].sessionId,session);assert.equal(calls,2);
 }finally{release();await conn.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}
});
