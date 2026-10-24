import {readFile,writeFile,mkdir,rm,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceFile=fileURLToPath(new URL('../../core/native/process-job.c',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function copyProcessJob(source,destination){
 source=await realpath(source);const manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
 if(manifest.version!==1||manifest.platform!=='win32'||manifest.arch!=='x64'||manifest.file!=='phonon-process-job.exe'||manifest.toolchain!=='zig-0.13.0'
  ||manifest.sourceSHA256!==hash(await readFile(sourceFile)))throw Error('Prepared process-job source/toolchain mismatch');
 const file=path.join(source,manifest.file),info=await lstat(file),bytes=await readFile(file);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==manifest.bytes||info.size>1024*1024||hash(bytes)!==manifest.sha256)throw Error('Prepared process-job checksum mismatch');
 const license=await readFile(path.join(source,'LICENSE')),notices=await readFile(path.join(source,'THIRD_PARTY_NOTICES.txt'));
 let created=false,complete=false;try{await mkdir(destination);created=true;await writeFile(path.join(destination,manifest.file),bytes);await writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');await writeFile(path.join(destination,'LICENSE'),license);await writeFile(path.join(destination,'THIRD_PARTY_NOTICES.txt'),notices);complete=true;}
 finally{if(created&&!complete)await rm(destination,{recursive:true});}
}
