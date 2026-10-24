import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [output,zig]=process.argv.slice(2);assert(output&&zig&&path.isAbsolute(output)&&path.isAbsolute(zig));
assert.equal(execFileSync(zig,['version'],{encoding:'utf8'}).trim(),'0.13.0');
const work=output+'.build',owner='phonon-windows-process-job-build-v1',source=repo+'/packages/core/native/process-job.c',bytes=await readFile(source),hash=b=>createHash('sha256').update(b).digest('hex');
await mkdir(work,{mode:0o700});await writeFile(work+'/.owner',JSON.stringify({owner,pid:process.pid,output}),{flag:'wx',mode:0o600});let child,created=false,passed=false;
try{
 await mkdir(output,{mode:0o700});created=true;
 child=spawn(zig,['cc','-target','x86_64-windows-gnu','-municode','-std=c11','-O2','-Wall','-Wextra','-Werror',source,'-s','-o',output+'/phonon-process-job.exe'],{cwd:repo,env:{...process.env,ZIG_GLOBAL_CACHE_DIR:work+'/global',ZIG_LOCAL_CACHE_DIR:work+'/local'},stdio:['ignore','inherit','inherit']});
 await writeFile(work+'/process.json',JSON.stringify({owner,pid:process.pid,childPID:child.pid}),{mode:0o600});
 const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)});child=undefined;assert.equal(code,0);assert.equal(hash(await readFile(source)),hash(bytes));
 const manifest={version:1,platform:'win32',arch:'x64',file:'phonon-process-job.exe',sha256:hash(await readFile(output+'/phonon-process-job.exe')),sourceSHA256:hash(bytes),toolchain:'zig-0.13.0',bytes:(await lstat(output+'/phonon-process-job.exe')).size};
 await writeFile(output+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');await writeFile(output+'/LICENSE',await readFile(repo+'/LICENSE'));
 await writeFile(output+'/THIRD_PARTY_NOTICES.txt',await readFile(path.dirname(zig)+'/lib/libc/mingw/COPYING'));
 passed=true;console.log(JSON.stringify(manifest));
}finally{
 if(!child){assert.equal(JSON.parse(await readFile(work+'/.owner','utf8')).owner,owner);await rm(work,{recursive:true});if(created&&!passed)await rm(output,{recursive:true});}
}
