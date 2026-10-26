import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {TextDecoder} from 'node:util';
import {PhononError} from './rpc.js';
import {spawnSupervised} from './process-supervisor.js';
import {buildChildProcessEnvironment} from './child-env.js';

const outputLimit = 1024 * 1024;
type Status = 'unmodified'|'modified'|'added'|'deleted'|'renamed'|'copied'|'untracked'|'unmerged'|'typeChanged';
export interface ObservedGitFile {path:string;index:Status;worktree:Status}
const invalid = () => new PhononError('errInternal','Git observation is unavailable');

export function displayGitOrigin(raw:string):{state:'configured';url:string}|{state:'unsupported'} {
  if(!raw||Buffer.byteLength(raw)>4096||/[\x00-\x20\x7f-\x9f]/.test(raw)||/^[A-Za-z]:[\\/]/.test(raw)||/^[A-Za-z][A-Za-z0-9+.-]*::/.test(raw))return {state:'unsupported'};
  try {
    let url:URL;
    if(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw))url=new URL(raw);
    else {
      const scp=/^(?:[^/@:]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(raw);
      if(!scp||!scp[2]||scp[2].startsWith('/'))return {state:'unsupported'};
      url=new URL('ssh://'+scp[1]+'/'+scp[2]);
    }
    if(!['https:','http:','ssh:','git:'].includes(url.protocol)||!url.hostname||!url.pathname||url.pathname==='/')return {state:'unsupported'};
    url.username='';url.password='';url.search='';url.hash='';
    const value=url.href;
    if(Buffer.byteLength(value)>2048||/[\x00-\x20\x7f-\x9f]/.test(decodeURIComponent(url.pathname)))return {state:'unsupported'};
    return {state:'configured',url:value};
  }catch{return {state:'unsupported'};}
}

export async function observeWorkspaceGitOrigin(cwd:string,scope:{projectId:string},revalidate:()=>void) {
  const deadline=Date.now()+5000;
  const read=async(args:string[])=>{revalidate();const result=await readGit(cwd,args,deadline);revalidate();return result;};
  const top=await read(['rev-parse','--show-toplevel']);
  if(top.code===128&&top.output===''&&top.error==='fatal: not a git repository (or any of the parent directories): .git\n')
    throw new PhononError('errNotGitRepo','The registered directory is not a Git repository');
  if(top.code!==0)throw invalid();
  const root=realpathSync(top.output.replace(/\n$/,''));
  if(root!==cwd)throw new PhononError('errPolicyDenied','Git repository root differs from the registered workspace');
  const git=await read(['rev-parse','--absolute-git-dir']);if(git.code!==0)throw invalid();
  const gitDir=realpathSync(git.output.replace(/\n$/,''));
  const config=await read(['config','--null','--get-all','remote.origin.url']);
  if(config.code!==0&&config.code!==1)throw invalid();
  const origins=config.code===1?[]:config.output.split('\0');
  if(config.code===0){if(origins.pop()!==''||!origins.length)throw invalid();}
  const origin=origins.length===0?{state:'missing' as const}:origins.length===1?displayGitOrigin(origins[0]!):{state:'unsupported' as const};
  const lastTop=await read(['rev-parse','--show-toplevel']),lastGit=await read(['rev-parse','--absolute-git-dir']);
  if(lastTop.code!==0||lastGit.code!==0||realpathSync(lastTop.output.replace(/\n$/,''))!==root||realpathSync(lastGit.output.replace(/\n$/,''))!==gitDir)throw invalid();
  const lastConfig=await read(['config','--null','--get-all','remote.origin.url']);
  if(lastConfig.code!==config.code||lastConfig.output!==config.output)throw new PhononError('errProjectProvisionChanged','Git origin changed during observation');
  return {...scope,path:cwd,repositoryRoot:root,observedAt:new Date().toISOString(),origin};
}

async function readGit(cwd:string,args:string[],deadline:number):Promise<{code:number;output:string;error:string}> {
  const remaining = deadline-Date.now();
  if(remaining<=0)throw invalid();
  const env=buildChildProcessEnvironment();
  for(const key of Object.keys(env))if(key.toUpperCase().startsWith('GIT_'))delete env[key];
  Object.assign(env,{LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  const supervisor=spawnSupervised('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false',...args],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const child=supervisor.child;child.stdin.end();
  let bytes=0,failed=false,spawnError:Error|undefined;const chunks:Buffer[]=[],errors:Buffer[]=[];
  const timer=setTimeout(()=>{failed=true;void supervisor.terminate();},remaining);
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>outputLimit){failed=true;void supervisor.terminate();}else chunks.push(chunk);});
  child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>outputLimit){failed=true;void supervisor.terminate();}else errors.push(chunk);});
  child.once('error',error=>{spawnError=error;});
  try {
    const code=await new Promise<number>(done=>child.once('close',value=>done(value??-1)));
    if(failed||spawnError)throw invalid();
    let output:string,error:string;try{const decoder=new TextDecoder('utf-8',{fatal:true});output=decoder.decode(Buffer.concat(chunks));error=decoder.decode(Buffer.concat(errors));}catch{throw invalid();}
    return {code,output,error};
  } finally {clearTimeout(timer);if(!supervisor.hasStopped())await supervisor.terminate();}
}

export function parseGitPorcelain(output:string):ObservedGitFile[] {
  if(!output)return [];
  if(!output.endsWith('\0'))throw invalid();
  const records=output.split('\0');records.pop();const files:ObservedGitFile[]=[];
  const code:Record<string,Status>={' ':'unmodified',M:'modified',A:'added',D:'deleted',R:'renamed',C:'copied','?':'untracked',U:'unmerged',T:'typeChanged'};
  for(let i=0;i<records.length;i++){
    const record=records[i]!;
    if(record.length<4||record[2]!==' '||!code[record[0]!]||!code[record[1]!])throw invalid();
    const path=record.slice(3);if(!path||path.length>4096||record.slice(0,2)==='  ')throw invalid();
    const untracked=record.slice(0,2)==='??';
    if(!untracked&&(record[0]==='?'||record[1]==='?'))throw invalid();
    if(/[RC]/.test(record.slice(0,2))){const original=records[++i];if(!original||original.length>4096)throw invalid();}
    files.push({path,index:untracked?'untracked':code[record[0]!]!,worktree:untracked?'untracked':code[record[1]!]!});
  }
  return files;
}

export async function observeWorkspaceGit(cwd:string,scope:{projectId:string;worktreeId?:string},revalidate:()=>void) {
  const deadline=Date.now()+10000;
  const required=async(args:string[])=>{revalidate();const result=await readGit(cwd,args,deadline);revalidate();if(result.code!==0)throw invalid();return result.output;};
  const line=(value:string)=>value.endsWith('\n')?value.slice(0,-1):value;
  revalidate();
  const top=await readGit(cwd,['rev-parse','--show-toplevel'],deadline);revalidate();
  // Only Git's exact C-locale no-repository diagnostic proves this state. Other
  // failures (ownership, permissions, corruption or transport) remain unavailable.
  if(top.code===128&&top.output===''&&top.error==='fatal: not a git repository (or any of the parent directories): .git\n')
    throw new PhononError('errNotGitRepo','The registered directory is not a Git repository');
  if(top.code!==0)throw invalid();
  const root=realpathSync(line(top.output));
  if(root!==cwd)throw new PhononError('errPolicyDenied','Git repository root differs from the registered workspace');
  const gitDir=realpathSync(resolve(cwd,line(await required(['rev-parse','--absolute-git-dir']))));
  const commonDir=realpathSync(resolve(cwd,line(await required(['rev-parse','--git-common-dir']))));
  const identity=async()=>{
    revalidate();const result=await readGit(cwd,['symbolic-ref','--quiet','--short','HEAD'],deadline);revalidate();
    if(result.code!==0&&result.code!==1)throw invalid();
    const branch=result.code===0?line(result.output):'HEAD';if(!branch||branch.length>1024)throw invalid();
    const commit=await readGit(cwd,['rev-parse','--verify','--quiet','HEAD'],deadline);revalidate();
    if(commit.code!==0&&commit.code!==1)throw invalid();
    const head=commit.code===0?line(commit.output):undefined;if(head&&!/^[a-f0-9]{40,64}$/.test(head))throw invalid();
    return {branch,detached:result.code===1,head};
  };
  const before=await identity();
  const files=parseGitPorcelain(await required(['status','--porcelain=v1','-z','--untracked-files=all']));
  revalidate();
  const tracking=await readGit(cwd,['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}'],deadline);revalidate();
  let upstream:string|undefined,ahead:number|undefined,behind:number|undefined;
  if(tracking.code===0){
    upstream=line(tracking.output);
    const counts=await required(['rev-list','--left-right','--count',`${upstream}...HEAD`]);
    const match=/^(\d+)\s+(\d+)\s*$/.exec(counts);if(!match)throw invalid();
    behind=Number(match[1]);ahead=Number(match[2]);if(!Number.isSafeInteger(ahead)||!Number.isSafeInteger(behind))throw invalid();
  }else if(tracking.code!==128&&tracking.code!==1)throw invalid();
  const after=await identity();
  if(JSON.stringify(before)!==JSON.stringify(after))throw new PhononError('errProjectProvisionChanged','Git checkout changed during observation');
  if(realpathSync(line(await required(['rev-parse','--show-toplevel'])))!==root
    ||realpathSync(resolve(cwd,line(await required(['rev-parse','--absolute-git-dir']))))!==gitDir
    ||realpathSync(resolve(cwd,line(await required(['rev-parse','--git-common-dir']))))!==commonDir)throw invalid();
  revalidate();
  const untrackedFileCount=files.filter(file=>file.index==='untracked').length;
  return {branch:after.branch,isClean:files.length===0,...(upstream?{upstream,ahead,behind}:{}),files,workspace:{...scope,path:cwd,repositoryRoot:root,isWorktree:gitDir!==commonDir,detached:after.detached,
    ...(after.head?{head:after.head}:{}),observedAt:new Date().toISOString(),changedFileCount:files.length,trackedChangedFileCount:files.length-untrackedFileCount,untrackedFileCount}};
}
