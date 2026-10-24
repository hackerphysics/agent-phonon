import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AdapterRegistry,PhononStore,type AdapterSession} from '@agent-phonon/core';
import {MockAdapter,TestConn} from './harness.js';

function deferred() { let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve}; }
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture() {
 const root=mkdtempSync(join(tmpdir(),'phonon-workflow-finalization-')),store=new PhononStore(join(root,'state.db'));
 const emitted=deferred(),cleanup=deferred();let sends=0;
 class SlowFinalizationAdapter extends MockAdapter {
  override async createSession(params:Parameters<MockAdapter['createSession']>[0]):Promise<AdapterSession> {
   const original=await super.createSession(params);
   return {...original,sessionId:original.sessionId,model:original.model,
    recoveryCheckpoint:()=>({sessionId:original.sessionId}),
    async send(input,options) { sends++;await original.send(input,options);emitted.resolve();await cleanup.promise; },
    async terminate(){cleanup.resolve();await original.terminate();}
   };
  }
 }
 const registry=new AdapterRegistry();registry.register(new SlowFinalizationAdapter({reply:()=> 'Original final result'}));
 const conn=new TestConn({registry,store,tenantId:'finalization-owner',workspaceRoot:root});
 const project=await conn.call('project.create',{name:'Finalization test',git:false}) as {project:{projectId:string}};
 const run=async(policy?:Record<string,unknown>)=>conn.call('workflow.run',{project:project.project.projectId,
  metadata:{native_run_id:randomUUID(),native_chat:true},
  plan:{mode:'dag',nodes:[{nodeId:'reply',agent:'mock:default',model:'m1'}],finalNodeId:'reply'},...(policy?{policy}:{})}) as Promise<{workflowId:string}>;
 return {conn,run,emitted,cleanup,sends:()=>sends,close:async()=>{cleanup.resolve();await conn.conn.dispose();store.close();rmSync(root,{recursive:true,force:true});}};
}
async function terminal(conn:TestConn,id:string) {
 for(let n=0;n<200;n++){const s=await conn.call('workflow.status',{workflowId:id}) as any;if(['completed','failed','cancelled','timeout'].includes(s.status))return s;await delay(20);}
 throw Error('Original workflow did not settle');
}

test('native final result waits for cleanup beyond the control deadline without failure or another turn',async()=>{
 const f=await fixture();try {
  const run=await f.run();await f.emitted.promise;await delay(2300);
  const pending=await f.conn.call('workflow.status',{workflowId:run.workflowId}) as any;
  assert.equal(pending.status,'running');assert.equal(pending.nodes[0].status,'running');assert.equal(f.sends(),1);
  f.cleanup.resolve();const done=await terminal(f.conn,run.workflowId);
  assert.equal(done.status,'completed');assert.equal(done.finalText,'Original final result');assert.equal(done.nodes[0].result.text,'Original final result');assert.equal(f.sends(),1);
 }finally{await f.close();}
});

test('native cleanup wait remains cancellable and late settlement cannot restore success',async()=>{
 const f=await fixture();try {
  const run=await f.run();await f.emitted.promise;await delay(2300);
  const stopped=await f.conn.call('workflow.cancel',{workflowId:run.workflowId}) as any;assert.equal(stopped.status,'cancelled');
  f.cleanup.resolve();await delay(100);
  assert.equal((await f.conn.call('workflow.status',{workflowId:run.workflowId}) as any).status,'cancelled');assert.equal(f.sends(),1);
 }finally{await f.close();}
});

test('original total timeout remains effective while native finalization is pending',async()=>{
 const f=await fixture();try {
  const run=await f.run({timeoutSeconds:3});await f.emitted.promise;const done=await terminal(f.conn,run.workflowId);
  assert.equal(done.status,'timeout');f.cleanup.resolve();await delay(100);
  assert.equal((await f.conn.call('workflow.status',{workflowId:run.workflowId}) as any).status,'timeout');assert.equal(f.sends(),1);
 }finally{await f.close();}
});
