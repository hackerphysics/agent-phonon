import {existsSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams,SpawnOptions} from 'node:child_process';
import {quoteWinArg} from './proc.js';

export interface WindowsProcessJob {
  child:ChildProcessWithoutNullStreams;
  alive():boolean;
  stop(force:boolean):void;
}

/** Only the helper's private fd may supply these records, never agent stdout. */
export class WindowsJobEvidence {
  private buffer='';private started:number|undefined;private empty=false;private invalid=false;
  push(bytes:Buffer){
    if(this.invalid)return;this.buffer+=bytes.toString('utf8');if(this.buffer.length>4096){this.fail();return;}
    for(let end;(end=this.buffer.indexOf('\n'))>=0;){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);try{
      const value=JSON.parse(line);
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='active,code,phase,pid,version'
        ||value.version!==1||!Number.isSafeInteger(value.pid)||value.pid<1||!Number.isSafeInteger(value.code)||value.code<0||value.code>0xffffffff)throw Error('Invalid job evidence');
      if(value.phase==='started'&&this.started===undefined&&!this.empty&&value.active===1&&value.code===0)this.started=value.pid;
      else if(value.phase==='empty'&&value.pid===this.started&&!this.empty&&value.active===0)this.empty=true;
      else throw Error('Unexpected job evidence');
    }catch{this.fail();}}
  }
  fail(){this.invalid=true;}
  alive(){return this.invalid||!this.empty||!!this.buffer;}
}

export function spawnWindowsProcessJob(command:string,args:readonly string[],options:SpawnOptions,artifactRoot?:string):WindowsProcessJob|undefined {
  if(process.platform!=='win32'||options.shell||!Array.isArray(options.stdio)||options.stdio.length!==3||options.stdio.some(v=>v!=='pipe'))return;
  const root=artifactRoot??join(dirname(fileURLToPath(import.meta.url)),'native-process');
  if(!existsSync(root))return;
  if(lstatSync(root).isSymbolicLink())throw Error('Linked native process-job directory');
  const canonical=realpathSync(root),manifestFile=join(canonical,'manifest.json'),metadata=lstatSync(manifestFile);
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||metadata.size>4096)throw Error('Invalid native process-job manifest file');
  const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
  if(manifest.version!==1||manifest.platform!=='win32'||manifest.arch!==process.arch||manifest.file!=='phonon-process-job.exe'||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw Error('Invalid native process-job manifest');
  const binary=join(canonical,manifest.file),stat=lstatSync(binary);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>1024*1024||realpathSync(binary)!==resolve(binary)||createHash('sha256').update(readFileSync(binary)).digest('hex')!==manifest.sha256)throw Error('Unverified native process-job executable');
  const invocation=/\.exe$/i.test(command)?[command,...args]:[join(process.env.SystemRoot??'C:\\Windows','System32/cmd.exe'),'/d','/s','/c',[quoteWinArg(command),...args.map(quoteWinArg)].join(' ')];
  const child=spawn(binary,invocation,{...options,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
  const proof=new WindowsJobEvidence();
  const events=child.stdio[3],control=child.stdio[4];
  if(!events||!('on'in events)||!control||!('write'in control))throw Error('Native process-job evidence channel unavailable');
  events.on('data',(bytes:Buffer)=>proof.push(bytes));
  events.on('error',()=>proof.fail());control.on('error',()=>{});
  return {child,alive:()=>proof.alive(),stop:force=>{if(force&&!control.destroyed)control.write('F');}};
}
