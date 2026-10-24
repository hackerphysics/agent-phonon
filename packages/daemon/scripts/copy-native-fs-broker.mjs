import {readFile,writeFile,mkdir,rm,lstat,realpath} from "node:fs/promises";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";

const repository=resolve(dirname(fileURLToPath(import.meta.url)),"../../.."),digest=bytes=>createHash("sha256").update(bytes).digest("hex");
export async function copyNativeFileBroker(source,destination,target){
  source=await realpath(resolve(source));destination=resolve(destination);
  const metadata=JSON.parse(await readFile(join(source,"manifest.json"),"utf8"));
  if(metadata.schema!==2||metadata.toolchain?.zig!=="0.13.0"||metadata.toolchain.zigPackage!=="@ryoppippi/zig-darwin-arm64@0.13.0"
    ||metadata.sourceSha256!==digest(await readFile(join(repository,"packages/core/native/fs-broker.c")))
    ||metadata.treeSha256!==digest(await readFile(join(repository,"packages/core/native/fs-tree.inc")))
    ||metadata.cryptoSha256!==digest(await readFile(join(repository,"packages/core/native/tree-crypto.zig"))))throw Error("Prepared native file broker source/toolchain does not match maintained source");
  const known=["darwin-arm64","linux-x64","win32-x64"],selected=target?[target]:known,targets={};
  if(selected.some(value=>!known.includes(value)))throw Error("Unsupported native artifact target");
  for(const key of selected){
    const record=metadata.targets?.[key],file=key+"/phonon-fs-broker"+(key==="win32-x64"?".exe":"");
    if(!record||record.file!==file||typeof record.sha256!=="string"||!/^[a-f0-9]{64}$/.test(record.sha256))throw Error("Native artifact manifest is unconfirmed");
    const path=join(source,file),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.size)throw Error("Prepared native file broker integrity mismatch");
    const bytes=await readFile(path);
    if(digest(bytes)!==record.sha256)throw Error("Prepared native file broker integrity mismatch");
    targets[key]={record,bytes};
  }
  const notices={};for(const name of ["LICENSE","THIRD_PARTY_NOTICES.txt"])notices[name]=await readFile(join(source,name));
  let created=false,complete=false;
  try{
    await mkdir(destination);created=true;
    for(const [key,{record,bytes}]of Object.entries(targets)){
      await mkdir(join(destination,key));await writeFile(join(destination,record.file),bytes,{mode:0o755});
    }
    for(const [name,bytes]of Object.entries(notices))await writeFile(join(destination,name),bytes);
    await writeFile(join(destination,"manifest.json"),JSON.stringify({...metadata,targets:Object.fromEntries(Object.entries(targets).map(([key,value])=>[key,value.record]))},null,2)+"\n");
    complete=true;return {destination,targets:selected,sourceSha256:metadata.sourceSha256};
  }finally{if(created&&!complete)await rm(destination,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(!process.argv[2]||!process.argv[3])throw Error("Prepared artifact folder and a new runtime/native folder required");
  process.stdout.write(JSON.stringify(await copyNativeFileBroker(process.argv[2],process.argv[3],process.argv[4]))+"\n");
}
