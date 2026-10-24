import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {copyProcessJob} from '../packages/daemon/scripts/copy-process-job.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(work){
 const root=await mkdtemp(path.join(tmpdir(),'phonon-process-package-'));
 try{const source=path.join(root,'source'),output=path.join(root,'output');await mkdir(source);
  const bytes=Buffer.from('synthetic packaging bytes, never executed'),manifest={version:1,platform:'win32',arch:'x64',file:'phonon-process-job.exe',sha256:hash(bytes),sourceSHA256:hash(await readFile(new URL('../packages/core/native/process-job.c',import.meta.url))),toolchain:'zig-0.13.0',bytes:bytes.length};
  for(const[n,b]of [['manifest.json',JSON.stringify(manifest)],['phonon-process-job.exe',bytes],['LICENSE','owned test notice'],['THIRD_PARTY_NOTICES.txt','owned test notice']])await writeFile(path.join(source,n),b);
  await work({root,source,output,manifest,bytes});
 }finally{await rm(root,{recursive:true});}
}
test('copies only prepared runtime files and notices after matching current native source',()=>fixture(async f=>{
 await copyProcessJob(f.source,f.output);assert.deepEqual(await readFile(path.join(f.output,'phonon-process-job.exe')),f.bytes);
 assert.equal(JSON.parse(await readFile(path.join(f.output,'manifest.json'),'utf8')).sourceSHA256,f.manifest.sourceSHA256);
}));
for(const[k,v]of [['sourceSHA256','0'.repeat(64)],['toolchain','unknown'],['sha256','0'.repeat(64)],['bytes',1],['file','foreign.exe']]){
 test('rejects unverified packaging field '+k,()=>fixture(async f=>{
  await writeFile(path.join(f.source,'manifest.json'),JSON.stringify({...f.manifest,[k]:v}));await assert.rejects(copyProcessJob(f.source,f.output));
  assert.equal(await lstat(f.output).catch(e=>e.code==='ENOENT'?null:Promise.reject(e)),null);
 }));
}
test('does not overwrite an existing package destination',()=>fixture(async f=>{
 await mkdir(f.output);await writeFile(path.join(f.output,'keep'),'original');await assert.rejects(copyProcessJob(f.source,f.output));assert.equal(await readFile(path.join(f.output,'keep'),'utf8'),'original');
}));
test('linked executable is rejected before creating a destination',()=>fixture(async f=>{
 await rm(path.join(f.source,'phonon-process-job.exe'));await writeFile(path.join(f.root,'actual'),f.bytes);await symlink('../actual',path.join(f.source,'phonon-process-job.exe'));await assert.rejects(copyProcessJob(f.source,f.output));
 assert.equal(await lstat(f.output).catch(e=>e.code==='ENOENT'?null:Promise.reject(e)),null);
}));
