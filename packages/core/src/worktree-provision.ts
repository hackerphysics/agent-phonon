import {existsSync,realpathSync,lstatSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {ProjectId,WorktreeProvisionParams,WorktreeProvisionStatusParams,WorktreeProvisionStatusResult,type WorktreeProvisionStatusResult as Result} from '@agent-phonon/protocol';
import {WorktreeProvisionLedger,type WorktreeProvisionRecord} from './worktree-provision-ledger.js';
import {PhononError} from './rpc.js';
import type {PolicyEnforcer} from './policy.js';
import type {ProjectManager} from './project-manager.js';
import {directoryIdentity,assertDirectoryIdentity,assertRegisteredDirectory} from './directory-identity.js';
import {workspacePathKey} from './workspace-paths.js';
import {requestFingerprint} from './idempotency.js';
import {spawnSupervised} from './process-supervisor.js';
import {buildChildProcessEnvironment} from './child-env.js';

const unconfirmed=()=>new PhononError('errProjectProvisionUnconfirmed','Worktree creation outcome is unconfirmed; inspect the original operation');
const branch=(value:string)=>{
  if(value.length>255||!value||value.startsWith('-')||value.startsWith('/')||value.endsWith('/')||value.endsWith('.')||value.includes('..')||value.includes('@{')
    ||!value.split('/').every(part=>!!part&&!part.startsWith('.')&&!part.endsWith('.lock'))||!/^[A-Za-z0-9._/-]+$/.test(value))
    throw new PhononError('errInvalidParams','A valid local branch name is required');
};

function repositoryMetadata(path:string){
  const gitFile=join(path,'.git'),stat=lstatSync(gitFile);
  let gitDir:string,pointer:string|undefined;
  if(stat.isDirectory()&&!stat.isSymbolicLink())gitDir=realpathSync(gitFile);
  else{
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8192)throw unconfirmed();
    pointer=readFileSync(gitFile,'utf8');const value=/^gitdir: (.+)\n?$/.exec(pointer)?.[1];if(!value)throw unconfirmed();
    gitDir=realpathSync(resolve(path,value));
  }
  const commonFile=join(gitDir,'commondir');let commonDir=gitDir,commonPointer:string|undefined;
  if(existsSync(commonFile)){
    const value=lstatSync(commonFile);if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1||value.size>8192)throw unconfirmed();
    commonPointer=readFileSync(commonFile,'utf8');commonDir=realpathSync(resolve(gitDir,commonPointer.replace(/\n$/,'')));
  }
  return {gitDir,commonDir,gitIdentity:directoryIdentity(gitDir),commonIdentity:directoryIdentity(commonDir),pointer,commonPointer};
}

async function git(cwd:string,args:string[],deadline:number,revalidate:()=>void){
  revalidate();const remaining=deadline-Date.now();if(remaining<=0)throw unconfirmed();
  const env=buildChildProcessEnvironment();for(const key of Object.keys(env))if(key.toUpperCase().startsWith('GIT_'))delete env[key];
  Object.assign(env,{LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  const supervisor=spawnSupervised('git',['--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','submodule.recurse=false',...args],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  supervisor.child.stdin.end();const chunks:Buffer[]=[],errors:Buffer[]=[];let bytes=0,failed=false,spawnError=false;
  const append=(target:Buffer[]) => (value:Buffer)=>{bytes+=value.length;if(bytes>1024*1024){failed=true;void supervisor.terminate();}else target.push(value);};
  supervisor.child.stdout.on('data',append(chunks));supervisor.child.stderr.on('data',append(errors));supervisor.child.once('error',()=>{spawnError=true;});
  const timer=setTimeout(()=>{failed=true;void supervisor.terminate();},remaining);
  try{
    const code=await new Promise<number|null>(done=>supervisor.child.once('close',done));
    if(failed||spawnError||code!==0)throw unconfirmed();
    const decoder=new TextDecoder('utf-8',{fatal:true}),output=decoder.decode(Buffer.concat(chunks));
    revalidate();return output.endsWith('\n')?output.slice(0,-1):output;
  }finally{clearTimeout(timer);if(!supervisor.hasStopped())await supervisor.terminate();}
}

/** One committed dispatch per request. Uncertain Git effects are never replayed or removed. */
export class WorktreeProvisioner{
  private ledger?:WorktreeProvisionLedger;private closed=false;private tasks=new Set<Promise<Result>>();
  constructor(private tenant:string,private path:string|undefined,private policy:PolicyEnforcer,private projects:ProjectManager){}
  private data(){
    if(!this.path||this.closed||process.platform==='win32')throw new PhononError('errCapabilityUnsupported','Durable worktree provisioning is unavailable');
    return this.ledger??=new WorktreeProvisionLedger(this.path);
  }
  private current(method:'project.worktree.provision'|'project.worktree.provision.status'){
    if(this.closed)throw unconfirmed();this.policy.assertMethodAllowed(method);this.policy.assertProjectPath(this.policy.workspaceRoot);
    if(method==='project.worktree.provision')this.policy.assertProjectProvision();
  }
  capability(){
    if(!this.path||this.closed||process.platform==='win32'||!this.policy.policy.allowProjectProvision)return undefined;
    try{this.current('project.worktree.provision');this.current('project.worktree.provision.status');directoryIdentity(this.policy.workspaceRoot);return this.data().receiver(this.tenant);}
    catch{return undefined;}
  }
  assertWorkspace(id:string,path:string){
    if(!id.startsWith('worktree-')){
      if(this.path&&(this.ledger||existsSync(this.path))){
        const row=this.data().overlapping(workspacePathKey(path));
        if(row&&(path===row.path||workspacePathKey(path).startsWith(row.path_key+'/')))throw unconfirmed();
      }
      return;
    }
    if(!this.path||!this.ledger&&!existsSync(this.path))throw unconfirmed();
    const row=this.data().workspace(this.tenant,id);
    if(!row||row.state!=='confirmed'||row.path!==path||!row.directory_identity||!row.git_directory||!row.git_identity)throw unconfirmed();
    this.policy.assertProjectPath(row.source_path);assertRegisteredDirectory(row.source_path);
    this.projects.assertRepositoryPath(row.source_common_dir);this.projects.assertRepositoryPath(row.git_directory);
    assertRegisteredDirectory(row.source_common_dir);
    assertRegisteredDirectory(path);assertRegisteredDirectory(row.git_directory);
    const file=join(path,'.git'),stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8192)throw unconfirmed();
    const pointer=/^gitdir: (.+)\n?$/.exec(readFileSync(file,'utf8'))?.[1];
    if(!pointer||realpathSync(resolve(path,pointer))!==row.git_directory)throw unconfirmed();
    const commonFile=join(row.git_directory,'commondir'),commonStat=lstatSync(commonFile);
    if(!commonStat.isFile()||commonStat.isSymbolicLink()||commonStat.nlink!==1||commonStat.size>8192
      ||realpathSync(resolve(row.git_directory,readFileSync(commonFile,'utf8').replace(/\n$/,'')))!==row.source_common_dir)throw unconfirmed();
  }
  private track(task:Promise<Result>){this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;}
  provision(raw:unknown){return this.track(this.perform(raw));}
  status(raw:unknown){return this.track(this.read(raw));}
  private rowScope(row:WorktreeProvisionRecord,projectId:string){
    if(row.project_id!==projectId)throw new PhononError('errInvalidParams','Worktree operation belongs to another project');
    const source=this.projects.get(projectId);if(source.employeeId||source.path!==row.source_path)throw unconfirmed();
    assertRegisteredDirectory(source.path);this.projects.assertRepositoryPath(row.source_common_dir);assertRegisteredDirectory(row.source_common_dir);
    this.policy.assertProjectPath(row.path);
  }
  private view(row:WorktreeProvisionRecord):Result{
    const base={clientRequestId:row.request_id,receiverID:row.receiver_id,projectId:ProjectId.parse(row.project_id)};
    if(row.state==='confirmed'){
      this.assertWorkspace(row.workspace_id,row.path);
      const workspace=this.projects.registerPreparedWorktree({projectId:row.workspace_id,namespace:this.tenant,name:row.name,path:row.path,git:true,
        directoryIdentity:row.directory_identity!,createdAt:row.created_at});
      return WorktreeProvisionStatusResult.parse({...base,state:'confirmed',found:true,outcomeKnown:true,dispatchClaimed:true,workspace,
        directoryIdentity:row.directory_identity,branch:row.new_branch,baseCommit:row.base_commit});
    }
    if(row.state==='prepared')return {...base,state:'prepared',found:true,outcomeKnown:false,dispatchClaimed:false};
    if(row.state==='failed')return {...base,state:'failed',found:true,outcomeKnown:true,dispatchClaimed:true,reasonCode:'creation_refused'};
    return {...base,state:row.state,found:true,outcomeKnown:false,dispatchClaimed:true};
  }
  private async read(raw:unknown):Promise<Result>{
    this.current('project.worktree.provision.status');const input=WorktreeProvisionStatusParams.parse(raw);
    this.projects.get(input.projectId);const db=this.data(),receiverID=db.receiver(this.tenant,false);
    if(receiverID!==input.expectedReceiverID)throw unconfirmed();
    const row=db.get(this.tenant,input.clientRequestId);
    if(!row)return {clientRequestId:input.clientRequestId,receiverID,projectId:input.projectId,state:'not_found',found:false,outcomeKnown:false};
    this.rowScope(row,input.projectId);return this.view(row);
  }
  private async perform(raw:unknown):Promise<Result>{
    this.current('project.worktree.provision');this.current('project.worktree.provision.status');const input=WorktreeProvisionParams.parse(raw);
    branch(input.baseBranch);branch(input.newBranch);
    if(/[\x00-\x1f\x7f-\x9f]/.test(input.name))throw new PhononError('errInvalidParams');
    const db=this.data();if(db.receiver(this.tenant,false)!==input.expectedReceiverID)throw unconfirmed();
    const requestHash=requestFingerprint(input);let row=db.get(this.tenant,input.clientRequestId);
    if(row){if(row.request_hash!==requestHash)throw new PhononError('errInvalidParams','Worktree retry differs');this.rowScope(row,input.projectId);return this.view(row);}
    const source=this.projects.get(input.projectId);if(source.employeeId)throw new PhononError('errPolicyDenied');
    const sourceIdentity=directoryIdentity(source.path),rootIdentity=directoryIdentity(this.policy.workspaceRoot),deadline=Date.now()+30000;
    const metadata=repositoryMetadata(source.path);
    this.projects.assertRepositoryPath(metadata.gitDir);this.projects.assertRepositoryPath(metadata.commonDir);
    const validate=()=>{
      this.current('project.worktree.provision');assertDirectoryIdentity(this.policy.workspaceRoot,rootIdentity);
      const current=this.projects.get(input.projectId);if(current.path!==source.path||current.employeeId)throw unconfirmed();assertDirectoryIdentity(source.path,sourceIdentity);
      if(JSON.stringify(repositoryMetadata(source.path))!==JSON.stringify(metadata))throw unconfirmed();
      this.projects.assertRepositoryPath(metadata.gitDir);this.projects.assertRepositoryPath(metadata.commonDir);
    };
    const top=realpathSync(await git(source.path,['rev-parse','--show-toplevel'],deadline,validate));if(top!==source.path)throw new PhononError('errPolicyDenied','Source must be its repository root');
    const common=realpathSync(resolve(source.path,await git(source.path,['rev-parse','--git-common-dir'],deadline,validate))),commonIdentity=directoryIdentity(common);
    if(common!==metadata.commonDir||commonIdentity!==metadata.commonIdentity)throw unconfirmed();
    this.projects.assertRepositoryPath(common);
    const commit=await git(source.path,['rev-parse','--verify','refs/heads/'+input.baseBranch+'^{commit}'],deadline,validate);if(!/^[a-f0-9]{40,64}$/.test(commit))throw unconfirmed();
    row=db.get(this.tenant,input.clientRequestId);
    if(row){if(row.request_hash!==requestHash)throw new PhononError('errInvalidParams');this.rowScope(row,input.projectId);return this.view(row);}
    const workspaceID='worktree-'+randomUUID(),path=join(this.policy.workspaceRoot,workspaceID);
    this.projects.assertPreparedPathAvailable(path);if(existsSync(path))throw new PhononError('errProjectExists');
    validate();assertDirectoryIdentity(common,commonIdentity);
    row=db.prepare({tenant:this.tenant,request_id:input.clientRequestId,request_hash:requestHash,receiver_id:input.expectedReceiverID,
      project_id:input.projectId,source_path:source.path,source_identity:sourceIdentity,source_common_dir:common,source_common_identity:commonIdentity,
      base_commit:commit,base_branch:input.baseBranch,new_branch:input.newBranch,name:input.name,workspace_id:workspaceID,path,path_key:workspacePathKey(path),created_at:new Date().toISOString()});
    if(row.request_hash!==requestHash)throw new PhononError('errInvalidParams');
    this.rowScope(row,input.projectId);const claim=randomUUID();if(!db.claim(row,claim))return this.view(db.get(this.tenant,input.clientRequestId)!);
    row=db.get(this.tenant,input.clientRequestId)!;
    try{
      validate();assertDirectoryIdentity(common,commonIdentity);this.projects.reservePreparedPath(row.path);
      await git(source.path,['worktree','add','-b',input.newBranch,'--',row.path,row.base_commit],deadline,validate);
      const identity=directoryIdentity(row.path);this.policy.assertProjectPath(row.path);
      const check=()=>{validate();assertDirectoryIdentity(common,commonIdentity);assertDirectoryIdentity(row!.path,identity);};
      const actualRoot=realpathSync(await git(row.path,['rev-parse','--show-toplevel'],deadline,check));
      const actualCommon=realpathSync(resolve(row.path,await git(row.path,['rev-parse','--git-common-dir'],deadline,check)));
      const gitDir=realpathSync(await git(row.path,['rev-parse','--absolute-git-dir'],deadline,check)),gitIdentity=directoryIdentity(gitDir);
      this.projects.assertRepositoryPath(gitDir);
      const head=await git(row.path,['rev-parse','--verify','HEAD'],deadline,check),ref=await git(row.path,['symbolic-ref','--short','HEAD'],deadline,check);
      if(actualRoot!==row.path||actualCommon!==common||head!==row.base_commit||ref!==row.new_branch||gitDir===common)throw unconfirmed();
      check();db.confirm(row,claim,identity,gitDir,gitIdentity);return this.view(db.get(this.tenant,input.clientRequestId)!);
    }catch(error){db.settle(row,'unknown');throw error;}
  }
  async dispose(){this.closed=true;await Promise.allSettled([...this.tasks]);this.ledger?.close();}
}
