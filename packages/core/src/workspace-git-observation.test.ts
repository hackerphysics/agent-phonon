import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ProjectManager} from './project-manager.js';
import {parseGitPorcelain,observeWorkspaceGit} from './workspace-git-observation.js';
import {GitStatusResult} from '@agent-phonon/protocol';

async function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'phonon-git-observation-')));
  const manager=new ProjectManager(()=>[],{namespace:'git-observation',workspaceRoot:root});
  try {
    const project=await manager.create({name:'Observation',path:join(root,'repo'),git:true});
    const git=(...args:string[])=>execFileSync('git',['-C',project.path,'-c','core.hooksPath='+join(root,'no-hooks'),'-c','commit.gpgSign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    return {root,manager,project,git,close:()=>rmSync(root,{recursive:true,force:true})};
  }catch(error){rmSync(root,{recursive:true,force:true});throw error;}
}

test('Git observation preserves unstaged columns and counts each changed file once',async()=>{
  const f=await fixture();try{
    writeFileSync(join(f.project.path,'tracked.txt'),'one\n');writeFileSync(join(f.project.path,'.gitignore'),'ignored\n');
    f.git('add','.');f.git('commit','-m','Fixture');
    writeFileSync(join(f.project.path,'tracked.txt'),'two\n');
    const unstaged=await f.manager.gitStatus({projectId:f.project.projectId});
    assert.deepEqual(unstaged.files,[{path:'tracked.txt',index:'unmodified',worktree:'modified'}]);
    f.git('add','tracked.txt');writeFileSync(join(f.project.path,'tracked.txt'),'three\n');
    mkdirSync(join(f.project.path,'nested'));writeFileSync(join(f.project.path,'nested','a'),'a');writeFileSync(join(f.project.path,'nested','b'),'b');writeFileSync(join(f.project.path,'ignored'),'ignored');
    const result=await f.manager.gitStatus({projectId:f.project.projectId});
    assert.equal(GitStatusResult.safeParse(result).success,true);
    assert.equal(result.workspace.changedFileCount,3);assert.equal(result.workspace.trackedChangedFileCount,1);assert.equal(result.workspace.untrackedFileCount,2);
    assert.equal(result.workspace.path,f.project.path);assert.equal(result.workspace.isWorktree,false);assert.equal(result.isClean,false);
    assert.deepEqual(result.files.find(file=>file.path==='tracked.txt'),{path:'tracked.txt',index:'modified',worktree:'modified'});
    assert(!result.files.some(file=>file.path==='ignored'));
  }finally{f.close();}
});

test('Git observation preserves rename destinations and Unicode/newline filenames',async()=>{
  const f=await fixture();try{
    writeFileSync(join(f.project.path,'old'),'one');f.git('add','.');f.git('commit','-m','Fixture');
    const name='renamed-\u4e2d\nfile';renameSync(join(f.project.path,'old'),join(f.project.path,name));f.git('add','-A');
    const result=await f.manager.gitStatus({projectId:f.project.projectId});
    assert.deepEqual(result.files,[{path:name,index:'renamed',worktree:'unmodified'}]);assert.equal(result.workspace.changedFileCount,1);
  }finally{f.close();}
});

test('Git observation reports live worktree branch, clean state and detached HEAD',async()=>{
  const f=await fixture();try{
    f.git('commit','--allow-empty','-m','Fixture');const base=f.git('branch','--show-current');
    const wt=await f.manager.worktreeCreate({projectId:f.project.projectId,baseBranch:base,newBranch:'observation-side',path:join(f.root,'side')});
    const result=await f.manager.gitStatus({projectId:f.project.projectId,worktreeId:wt.worktreeId});
    assert.equal(result.branch,'observation-side');assert.equal(result.workspace.isWorktree,true);assert.equal(result.workspace.worktreeId,wt.worktreeId);assert.equal(result.workspace.path,wt.path);assert.equal(result.workspace.changedFileCount,0);assert.equal(result.isClean,true);
    f.git('checkout','--detach');const detached=await f.manager.gitStatus({projectId:f.project.projectId});assert.equal(detached.branch,'HEAD');assert.equal(detached.workspace.detached,true);assert.match(detached.workspace.head!,/^[a-f0-9]{40}$/);
    await assert.rejects(f.manager.gitStatus({projectId:'foreign',worktreeId:wt.worktreeId}));
    await assert.rejects(f.manager.gitStatus({projectId:f.project.projectId,worktreeId:'foreign'}));
  }finally{f.close();}
});

test('Git observation supports an unborn branch but never invents clean facts for non-Git or parent repositories',async()=>{
  const f=await fixture();try{
    const unborn=await f.manager.gitStatus({projectId:f.project.projectId});assert.equal(unborn.workspace.detached,false);assert.equal(unborn.workspace.head,undefined);assert.equal(unborn.workspace.changedFileCount,0);
    const plain=await f.manager.create({name:'Plain',path:join(f.root,'plain'),git:false});await assert.rejects(f.manager.gitStatus({projectId:plain.projectId}));
    mkdirSync(join(f.project.path,'child'));await assert.rejects(observeWorkspaceGit(join(f.project.path,'child'),{projectId:'child'},()=>{}),/repository root/);
    let checks=0;await assert.rejects(observeWorkspaceGit(f.project.path,{projectId:f.project.projectId},()=>{if(++checks>2)throw Error('source changed');}),/source changed/);
  }finally{f.close();}
});

test('Porcelain parser rejects incomplete/unknown records and preserves conflict/type changes',()=>{
  for(const value of [' M missing terminator','?? \0','R  new\0','Z  unknown\0','   unchanged\0'])assert.throws(()=>parseGitPorcelain(value));
  assert.deepEqual(parseGitPorcelain('UU conflict\0 T type\0'),[{path:'conflict',index:'unmerged',worktree:'unmerged'},{path:'type',index:'unmodified',worktree:'typeChanged'}]);
});
