import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile,writeFile,mkdir,rm,lstat,rename,statfs} from "node:fs/promises";
import {join,resolve,dirname,relative,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";

const repository=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const within=(parent,path)=>{const rel=relative(parent,path);return !rel||!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../");};
async function absent(path){try{await lstat(path);}catch(error){if(error.code==="ENOENT")return;throw error;}throw Error("Build path already exists: "+path);}

export async function buildNativeFileBroker({root,zig,verification,signal,runCompiler}={}){
 if(!root||!zig||process.platform!=="darwin"||process.arch!=="arm64")throw Error("Local macOS arm64 host, new output folder and --zig <0.13.0 executable> required");
 root=resolve(root);zig=resolve(zig);verification=verification?resolve(verification):undefined;
 const work=root+".build",owner="phonon-native-fs-build-v1",active=new Set();
 if(verification&&(within(root,verification)||within(work,verification)))throw Error("Verification output must be outside runtime and build directories");
 await absent(root);await absent(work);if(verification)await absent(verification);
 const space=await statfs(dirname(root));if(space.bavail*space.bsize<1024*1024*1024)throw Error("At least 1 GiB free local build space required");
 let interrupted=false,created=false,complete=false,workCreated=false,verificationCreated=false,saving=Promise.resolve(),failure,workIdentity,rootIdentity;
 const resources={owner,pid:process.pid,root,work,verification:verification??null,children:[]};
 const persist=()=>{const text=JSON.stringify(resources,null,2)+"\n";saving=saving.then(async()=>{await writeFile(join(work,"resources.next"),text,{mode:0o600});await rename(join(work,"resources.next"),join(work,"resources.json"));});return saving;};
 const interrupt=()=>{interrupted=true;for(const child of active)try{process.kill(-child.pid,"SIGTERM");}catch{}};
 signal?.addEventListener("abort",interrupt,{once:true});
 async function compile(command,args,env,{capture=false,timeout=300000}={}){
  if(interrupted||signal?.aborted)throw Error("Native broker build interrupted");
  if(runCompiler)return runCompiler(command,args,env);
  let output="";
  await new Promise((done,fail)=>{
   const child=spawn(command,args,{cwd:repository,env,detached:true,stdio:["ignore","pipe","pipe"]});
   active.add(child);if(child.pid)resources.children.push(child.pid);if(workCreated)void persist().catch(()=>{});
   let timedOut=false,kill;
   const stop=()=>{try{process.kill(-child.pid,"SIGTERM");}catch{}if(!kill)kill=setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}},2000);};
   const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
   const onAbort=()=>stop();signal?.addEventListener("abort",onAbort,{once:true});
   child.stdout.on("data",bytes=>{if(capture){output+=String(bytes);if(output.length>4096)stop();}else process.stdout.write(bytes);});
   child.stderr.on("data",bytes=>process.stderr.write(bytes));
   let spawnError;child.once("error",error=>spawnError=error);
   child.once("close",code=>{
    clearTimeout(timer);clearTimeout(kill);signal?.removeEventListener("abort",onAbort);active.delete(child);resources.children=resources.children.filter(pid=>pid!==child.pid);
    const settled=workCreated?persist():Promise.resolve();
    void settled.then(()=>spawnError?fail(spawnError):interrupted||signal?.aborted?fail(Error("Native broker build interrupted")):timedOut?fail(Error("Native broker compiler deadline")):code===0?done():fail(Error("Native broker compiler failed: "+code))).catch(fail);
   });
  });return output;
 }
 try{
  if(signal?.aborted)throw Error("Native broker build interrupted");
  await mkdir(work,{mode:0o700});workCreated=true;workIdentity=await lstat(work);await persist();
  const version=(await compile(zig,["version"],process.env,{capture:true,timeout:10000})).trim();
  if(version!=="0.13.0")throw Error("Pinned Zig 0.13.0 required");
  const source=join(repository,"packages/core/native/fs-broker.c"),treeSource=join(repository,"packages/core/native/fs-tree.inc"),cryptoSource=join(repository,"packages/core/native/tree-crypto.zig");
  const before=await readFile(source),treeBefore=await readFile(treeSource),cryptoBefore=await readFile(cryptoSource);
  const cache=join(work,"cache"),localCache=join(work,"local-cache");await mkdir(cache);await mkdir(localCache);
  const env={...process.env,ZIG_GLOBAL_CACHE_DIR:cache,ZIG_LOCAL_CACHE_DIR:localCache};
  await mkdir(root,{mode:0o700});created=true;rootIdentity=await lstat(root);const targets={};let darwinCrypto;
  const common=["-std=c11","-O2","-Wall","-Wextra","-Werror",source];
  for(const [target,triple,file] of[["darwin-arm64",null,"phonon-fs-broker"],["linux-x64","x86_64-linux-musl","phonon-fs-broker"],["win32-x64","x86_64-windows-gnu","phonon-fs-broker.exe"]]){
   process.stdout.write(JSON.stringify({phase:"compiling",target})+"\n");
   const folder=join(root,target);await mkdir(folder);const crypto=join(work,target+"-crypto.o");
   await compile(zig,["build-obj",cryptoSource,"-target",triple??"aarch64-macos","-O","ReleaseSmall","-fPIC","-femit-bin="+crypto],env);
   if(target==="darwin-arm64")darwinCrypto=crypto;
   const path=join(folder,file),args=triple?["cc","-target",triple,...common,crypto,"-s",...(target==="linux-x64"?["-static"]:["-ladvapi32"]),"-o",path]:[...common,crypto,"-o",path];
   await compile(triple?zig:"/usr/bin/clang",args,env);
   const bytes=await readFile(path);targets[target]={file:target+"/"+file,sha256:digest(bytes),size:bytes.length};
  }
  let verificationBytes;
  if(verification){
   const temporary=join(work,"phonon-fs-broker-test");await compile("/usr/bin/clang",[...common,darwinCrypto,"-DPHONON_FS_BROKER_TEST_HOOKS","-o",temporary],env);verificationBytes=await readFile(temporary);
  }
  if(digest(await readFile(source))!==digest(before)||digest(await readFile(treeSource))!==digest(treeBefore)||digest(await readFile(cryptoSource))!==digest(cryptoBefore))throw Error("Broker source changed during compilation");
  const manifest={schema:2,sourceSha256:digest(before),treeSha256:digest(treeBefore),cryptoSha256:digest(cryptoBefore),toolchain:{zig:version,zigPackage:"@ryoppippi/zig-darwin-arm64@0.13.0"},targets};
  await writeFile(join(root,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");await writeFile(join(root,"LICENSE"),await readFile(join(repository,"LICENSE")));
  const toolchain=dirname(zig),notices=[];
  for(const [name,path] of[["Zig standard library (SHA-256 and UTF-8 validation) and compiler runtime",join(toolchain,"LICENSE")],["musl libc",join(toolchain,"lib/libc/musl/COPYRIGHT")],["mingw-w64",join(toolchain,"lib/libc/mingw/COPYING")]])notices.push(name+"\n\n"+await readFile(path,"utf8"));
  await writeFile(join(root,"THIRD_PARTY_NOTICES.txt"),notices.join("\n\n--------------------\n\n"));
  if(interrupted||signal?.aborted)throw Error("Native broker build interrupted");
  if(verificationBytes){await writeFile(verification,verificationBytes,{flag:"wx",mode:0o755});verificationCreated=true;}
  if(interrupted||signal?.aborted)throw Error("Native broker build interrupted");
  complete=true;return {root,manifest,verification:verificationBytes?{path:verification,sha256:digest(verificationBytes)}:null};
 }catch(error){failure=error;throw error;}
 finally{
  signal?.removeEventListener("abort",interrupt);
  try{
   await saving;
   if(active.size)throw Error("Native build still owns compiler processes");
   if(workCreated){const metadata=JSON.parse(await readFile(join(work,"resources.json"),"utf8")),value=await lstat(work);
    if(metadata.owner!==owner||metadata.pid!==process.pid||metadata.work!==work||!value.isDirectory()||value.isSymbolicLink()||value.dev!==workIdentity.dev||value.ino!==workIdentity.ino)throw Error("Native build cleanup ownership changed");
    if(created&&!complete){const output=await lstat(root);if(!output.isDirectory()||output.isSymbolicLink()||output.dev!==rootIdentity.dev||output.ino!==rootIdentity.ino)throw Error("Native output cleanup ownership changed");await rm(root,{recursive:true,force:true});}
    if(verificationCreated&&!complete)await rm(verification,{force:true});
    await rm(work,{recursive:true,force:true});
   }
  }catch(error){if(!failure)throw error;process.stderr.write("Native build cleanup requires inspection: "+String(error)+"\n");}
 }
}
