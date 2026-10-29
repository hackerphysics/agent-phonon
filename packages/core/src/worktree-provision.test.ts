import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync,readdirSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {WorktreeProvisionParams,WorktreeProvisionStatusResult} from '@agent-phonon/protocol';
import {PhononConnection,PhononStore,AdapterRegistry} from './index.js';

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'phonon-worktree-provision-'))),source=join(root,'source'),database=join(root,'state.db');
  mkdirSync(source);const marker={pid:process.pid,nonce:randomUUID()};writeFileSync(join(root,'owner.json'),JSON.stringify(marker));
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,'-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false',...args],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
  git(source,'init','-b','main');writeFileSync(join(source,'tracked.txt'),'base');git(source,'add','.');git(source,'commit','-m','Fixture');
  const stores=[new PhononStore(database)],connections:PhononConnection[]=[],store=stores[0]!;
  store.upsertProject({projectId:'owned-project',namespace:'owner',name:'Source',path:source,git:true,createdAt:new Date().toISOString()});
  let sequence=0;
  function actor(tenant='owner',permission=true,currentStore=store){
    const replies:Array<Record<string,any>>=[];
    const connection=new PhononConnection({tenantId:tenant,store:currentStore,registry:new AdapterRegistry(),workspaceRoot:root,
      policy:{allowedProjectRoots:[root],allowProjectProvision:permission},transport:{send:text=>replies.push(JSON.parse(text)),close(){}}});connections.push(connection);
    return {connection,async call(method:string,params:unknown){const id=++sequence;await connection.handle(JSON.stringify({jsonrpc:'2.0',id,method,params}));return replies.find(row=>row.id===id)!;},
      async input(){const info=(await this.call('device.info',{})).result;assert(info.capabilities.includes('worktree_provision_v1'));return {projectId:'owned-project',clientRequestId:randomUUID(),expectedReceiverID:info.worktreeProvisionReceiverID,name:'Side checkout',baseBranch:'main',newBranch:'feature/'+randomUUID()};}};
  }
  return {root,source,database,store,git,actor,reopen(){const value=new PhononStore(database);stores.push(value);return value;},async close(){
    for(const connection of connections)await connection.dispose();for(const value of stores)value.close();
    assert.deepEqual(JSON.parse(readFileSync(join(root,'owner.json'),'utf8')),marker);rmSync(root,{recursive:true});
  }};
}

test('worktree provisioning accepts fixed scoped input, never caller paths or guessed authority',()=>{
  const input={projectId:'p',clientRequestId:randomUUID(),expectedReceiverID:randomUUID(),name:'Side',baseBranch:'main',newBranch:'feature/side'};
  assert.deepEqual(WorktreeProvisionParams.parse(input),input);
  for(const patch of [{path:'/somewhere'},{remote:'https://example.com/repo'},{owner:'other'},{worktreeId:'chosen'},{force:true}])
    assert.equal(WorktreeProvisionParams.safeParse({...input,...patch}).success,false);
});

test('one RPC creates a real linked checkout registered as an independent namespace workspace and survives reopen',async()=>{
  const f=fixture();try{
    const actor=f.actor(),input=await actor.input(),reply=await actor.call('project.worktree.provision',input);assert(reply.result,JSON.stringify(reply));
    const result=WorktreeProvisionStatusResult.parse(reply.result);assert.equal(result.state,'confirmed');if(result.state!=='confirmed')return;
    assert.equal(result.workspace.namespace,'owner');assert(result.workspace.projectId.startsWith('worktree-'));assert(result.workspace.path.startsWith(f.root+'/worktree-'));
    assert.equal(f.git(result.workspace.path,'branch','--show-current'),input.newBranch);assert.equal(f.git(result.workspace.path,'rev-parse','HEAD'),f.git(f.source,'rev-parse','HEAD'));
    assert.equal(f.git(f.source,'branch','--show-current'),'main');assert.equal(readFileSync(join(result.workspace.path,'tracked.txt'),'utf8'),'base');
    writeFileSync(join(result.workspace.path,'tracked.txt'),'side change');writeFileSync(join(result.workspace.path,'untracked.txt'),'new');
    const status=(await actor.call('project.git.status',{projectId:result.workspace.projectId})).result;
    assert.equal(status.workspace.isWorktree,true);assert.equal(status.workspace.changedFileCount,2);assert.equal(status.branch,input.newBranch);
    assert.equal(readFileSync(join(f.source,'tracked.txt'),'utf8'),'base');
    assert.deepEqual((await actor.call('project.worktree.provision',input)).result,result);
    await actor.connection.dispose();const next=f.actor('owner',true,f.reopen());
    const reference={projectId:input.projectId,clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID};
    assert.deepEqual((await next.call('project.worktree.provision.status',reference)).result,result);
    assert.deepEqual((await next.call('project.worktree.provision',input)).result,result);
    assert.equal(readdirSync(f.root).filter(name=>name.startsWith('worktree-')).length,1);
    assert((await next.call('project.get',{projectId:result.workspace.projectId})).result);
  }finally{await f.close();}
});

test('parallel controllers have one creation claim and a retry cannot change the branch or use foreign namespace',async()=>{
  const f=fixture();try{
    const a=f.actor(),b=f.actor(),input=await a.input();
    const replies=await Promise.all([a.call('project.worktree.provision',input),b.call('project.worktree.provision',input)]);
    assert(replies.some(r=>r.result?.state==='confirmed'),JSON.stringify(replies));
    assert(replies.every(r=>!r.error),JSON.stringify(replies));
    const status=(await a.call('project.worktree.provision.status',{projectId:input.projectId,clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result;
    assert.equal(status.state,'confirmed');assert.equal(readdirSync(f.root).filter(name=>name.startsWith('worktree-')).length,1);
    const changed=await a.call('project.worktree.provision',{...input,newBranch:'other'});assert.equal(changed.error?.data?.appCode,'errInvalidParams');
    const foreign=f.actor('other');assert((await foreign.call('project.worktree.provision',input)).error);
    assert((await foreign.call('project.get',{projectId:status.workspace.projectId})).error);
  }finally{await f.close();}
});

test('read-only policy can observe an existing receipt but cannot create or revive missing authority',async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input(),reply=await a.call('project.worktree.provision',input);assert(reply.result);
    const readonly=f.actor('owner',false),info=(await readonly.call('device.info',{})).result;assert(!info.capabilities.includes('worktree_provision_v1'));
    assert.equal((await readonly.call('project.worktree.provision',input)).error?.data?.appCode,'errPolicyDenied');
    assert.equal((await readonly.call('project.worktree.provision.status',{projectId:input.projectId,clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result.state,'confirmed');
    assert((await a.call('project.worktree.provision',{...input,clientRequestId:randomUUID(),expectedReceiverID:randomUUID()})).error);
  }finally{await f.close();}
});

test('bad local branch names and an uncommitted source refuse before any checkout allocation',async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input();
    for(const newBranch of ['-bad','../bad','bad..name','a//b','x.lock','a@{b','with space'])assert((await a.call('project.worktree.provision',{...input,newBranch})).error,newBranch);
    f.git(f.source,'symbolic-ref','HEAD','refs/heads/unborn');
    assert((await a.call('project.worktree.provision',{...input,baseBranch:'unborn'})).error);
    assert.equal(readdirSync(f.root).filter(name=>name.startsWith('worktree-')).length,0);
  }finally{await f.close();}
});

test('registered worktrees ignore historical device and inode numbers but still reject a changed Git pointer',async()=>{
  for(const corruption of ['historicalIdentity','gitPointer']){
    const f=fixture();try{
      const a=f.actor(),input=await a.input(),reply=await a.call('project.worktree.provision',input);assert(reply.result,JSON.stringify(reply));
      const target=reply.result.workspace.path;
      if(corruption==='historicalIdentity'){
        const ledger=new DatabaseSync(f.database+'.worktrees.sqlite');
        try{
          ledger.exec('DROP TRIGGER worktree_identity_immutable');
          ledger.prepare("UPDATE worktrees SET source_identity='dir:123:1',source_common_identity='dir:123:2',directory_identity='dir:123:3',git_identity='dir:123:4' WHERE workspace_id=?").run(reply.result.workspace.projectId);
        }finally{ledger.close();}
        const record=f.store.loadProjects().find(row=>row.projectId===reply.result.workspace.projectId)!;
        f.store.upsertProject({...record,directoryIdentity:'dir:123:3'});
        assert((await a.call('project.get',{projectId:record.projectId})).result);
        const status=await a.call('project.git.status',{projectId:record.projectId});
        assert(status.result,JSON.stringify(status));assert.equal(status.result.workspace.isWorktree,true);
        assert.equal((await a.call('project.worktree.provision.status',{projectId:input.projectId,clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).result.state,'confirmed');
      }else{
        writeFileSync(join(target,'.git'),'gitdir: '+join(f.source,'.git')+'\n');
        assert((await a.call('project.worktree.provision.status',{projectId:input.projectId,clientRequestId:input.clientRequestId,expectedReceiverID:input.expectedReceiverID})).error);
        assert((await a.call('project.get',{projectId:reply.result.workspace.projectId})).error);
      }
    }finally{await f.close();}
  }
});

test('an interrupted dispatch remains unknown on read and is never repeated',async()=>{
  const f=fixture();try{
    const a=f.actor(),input=await a.input();const info=(await a.call('device.info',{})).result;assert(info.worktreeProvisionReceiverID);
    const {WorktreeProvisionLedger}=await import('./worktree-provision-ledger.js'),{requestFingerprint}=await import('./idempotency.js'),{directoryIdentity}=await import('./directory-identity.js');
    const ledger=new WorktreeProvisionLedger(f.database+'.worktrees.sqlite');
    try{
      const row=ledger.prepare({tenant:'owner',request_id:input.clientRequestId,request_hash:requestFingerprint(input),receiver_id:input.expectedReceiverID,project_id:input.projectId,
        source_path:f.source,source_identity:directoryIdentity(f.source),source_common_dir:join(f.source,'.git'),source_common_identity:directoryIdentity(join(f.source,'.git')),
        base_commit:f.git(f.source,'rev-parse','HEAD'),base_branch:'main',new_branch:input.newBranch,name:input.name,workspace_id:'worktree-'+randomUUID(),path:join(f.root,'uncertain'),path_key:join(f.root,'uncertain'),created_at:new Date().toISOString()});
      assert(ledger.claim(row,'original'));const current=ledger.get('owner',input.clientRequestId)!;ledger.settle(current,'unknown');
    }finally{ledger.close();}
    assert.equal((await a.call('project.worktree.provision',input)).result.state,'unknown');
    assert(!existsSync(join(f.root,'uncertain')));
  }finally{await f.close();}
});
