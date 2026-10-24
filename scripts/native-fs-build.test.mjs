import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,lstat,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {buildNativeFileBroker} from "./native-fs-build.mjs";
import {copyNativeFileBroker} from "../packages/daemon/scripts/copy-native-fs-broker.mjs";

const local={skip:process.platform!=="darwin"||process.arch!=="arm64"};
async function fixture(run){
 const base=await mkdtemp(join(tmpdir(),"phonon-native-build-test-")),marker={pid:process.pid,purpose:"native-build-lifecycle-test"};
 try{
  await writeFile(join(base,"owner.json"),JSON.stringify(marker),{flag:"wx",mode:0o600});
  const root=join(base,"runtime"),zig=join(base,"toolchain","zig"),verification=join(base,"verification");
  for(const folder of["toolchain/lib/libc/musl","toolchain/lib/libc/mingw"])await mkdir(join(base,folder),{recursive:true});
  for(const path of["toolchain/LICENSE","toolchain/lib/libc/musl/COPYRIGHT","toolchain/lib/libc/mingw/COPYING"])await writeFile(join(base,path),"Synthetic lifecycle-test notice\n");
  const calls=[];
  const runCompiler=async(command,args,env)=>{
   calls.push({command,args,env});if(args[0]==="version")return "0.13.0\n";
   const object=args.find(arg=>arg.startsWith("-femit-bin=")),output=object?.slice("-femit-bin=".length)??args[args.indexOf("-o")+1];
   await writeFile(output,"SYNTHETIC BUILD-LIFECYCLE TEST, NEVER A RUNTIME ASSET\n");return "";
  };
  await run({base,root,zig,verification,calls,runCompiler});
 }finally{
  const st=await lstat(base),current=JSON.parse(await readFile(join(base,"owner.json"),"utf8"));
  if(st.isSymbolicLink()||!st.isDirectory()||current.pid!==process.pid||current.purpose!==marker.purpose)throw Error("Unsafe test fixture cleanup");
  await rm(base,{recursive:true,force:true});
 }
}
const absent=async path=>assert.rejects(access(path),error=>error.code==="ENOENT");

test("native build defaults to runtime artifacts only, bounds both Zig caches and removes the owned workspace",local,()=>fixture(async f=>{
 const result=await buildNativeFileBroker({...f,verification:undefined});assert.equal(result.verification,null);assert.deepEqual(Object.keys(result.manifest.targets),["darwin-arm64","linux-x64","win32-x64"]);
 await absent(f.root+".build");await absent(f.verification);
 assert.deepEqual((await readdir(f.root)).sort(),["LICENSE","THIRD_PARTY_NOTICES.txt","darwin-arm64","linux-x64","manifest.json","win32-x64"].sort());
 assert.equal(f.calls.filter(call=>call.args.includes("-DPHONON_FS_BROKER_TEST_HOOKS")).length,0);
 for(const call of f.calls.filter(call=>call.args[0]!=="version")){
  assert.equal(call.env.ZIG_GLOBAL_CACHE_DIR,join(f.root+".build","cache"));assert.equal(call.env.ZIG_LOCAL_CACHE_DIR,join(f.root+".build","local-cache"));
 }
 for(const record of Object.values(result.manifest.targets))assert.equal(record.sha256,createHash("sha256").update(await readFile(join(f.root,record.file))).digest("hex"));
}));
test("verification helper is retained only at an explicit external new file",local,()=>fixture(async f=>{
 const result=await buildNativeFileBroker({...f,verification:f.verification});assert.equal(result.verification.path,f.verification);
 assert.equal(result.verification.sha256,createHash("sha256").update(await readFile(f.verification)).digest("hex"));
 await absent(f.root+".build");assert.equal(f.calls.filter(call=>call.args.includes("-DPHONON_FS_BROKER_TEST_HOOKS")).length,1);
}));
test("compiler failure removes incomplete runtime/cache but preserves original failure",local,()=>fixture(async f=>{
 await assert.rejects(buildNativeFileBroker({...f,runCompiler:async(...args)=>{if(args[1].includes("x86_64-linux-musl"))throw Error("Original compile failure");return f.runCompiler(...args);}}),/Original compile failure/);
 await absent(f.root);await absent(f.root+".build");await absent(f.verification);
}));
test("missing required notices refuse a candidate and clean every owned build directory",local,()=>fixture(async f=>{
 await rm(join(dirname(f.zig),"lib/libc/mingw/COPYING"));
 await assert.rejects(buildNativeFileBroker({...f,verification:f.verification}),error=>error.code==="ENOENT");
 await absent(f.root);await absent(f.root+".build");await absent(f.verification);
}));
test("existing output or build roots are never overwritten or cleaned",local,()=>fixture(async f=>{
 for(const path of[f.root,f.root+".build"]){await mkdir(path);await writeFile(join(path,"keep.txt"),"Existing unrelated state");
  await assert.rejects(buildNativeFileBroker(f),/already exists/);assert.equal(await readFile(join(path,"keep.txt"),"utf8"),"Existing unrelated state");await rm(path,{recursive:true});}
 assert.equal(f.calls.length,0);
}));
test("two builders cannot share the same writable output/cache workspace",local,()=>fixture(async f=>{
 let entered,release;const ready=new Promise(done=>entered=done),gate=new Promise(done=>release=done);
 const first=buildNativeFileBroker({...f,verification:undefined,runCompiler:async(...args)=>{if(args[1][0]==="version"){entered();await gate;}return f.runCompiler(...args);}});void first.catch(()=>{});
 try{
  await ready;await assert.rejects(buildNativeFileBroker(f),/already exists/);
  const manifest=JSON.parse(await readFile(join(f.root+".build","resources.json"),"utf8"));assert.equal(manifest.pid,process.pid);assert.equal(manifest.root,f.root);
  release();await first;await absent(f.root+".build");
 }finally{release();await first.catch(()=>{});}
}));
test("verification output inside runtime/cache is rejected before any compiler invocation",local,()=>fixture(async f=>{
 for(const path of[join(f.root,"test-helper"),join(f.root+".build","helper")])await assert.rejects(buildNativeFileBroker({...f,verification:path}),/outside runtime and build/);
 assert.equal(f.calls.length,0);await absent(f.root);await absent(f.root+".build");
}));
test("an existing verification file is preserved and prevents any build",local,()=>fixture(async f=>{
 await writeFile(f.verification,"Retained original test evidence\n",{flag:"wx"});
 await assert.rejects(buildNativeFileBroker({...f,verification:f.verification}),/already exists/);
 assert.equal(await readFile(f.verification,"utf8"),"Retained original test evidence\n");assert.equal(f.calls.length,0);await absent(f.root);await absent(f.root+".build");
}));
test("stale source metadata fails the normal packaging gate before creating a runtime",local,()=>fixture(async f=>{
 const stale=join(f.base,"stale");await mkdir(stale);await writeFile(join(stale,"manifest.json"),JSON.stringify({schema:2,sourceSha256:"0".repeat(64),treeSha256:"0".repeat(64),cryptoSha256:"0".repeat(64),toolchain:{zig:"0.13.0",zigPackage:"@ryoppippi/zig-darwin-arm64@0.13.0"},targets:{}}));
 await assert.rejects(copyNativeFileBroker(stale,f.root,"linux-x64"),/source\/toolchain does not match/);await absent(f.root);
}));
test("wrong pinned version allocates no output/cache",local,()=>fixture(async f=>{
 await assert.rejects(buildNativeFileBroker({...f,runCompiler:async()=>"0.14.0\n"}),/Pinned Zig 0.13.0/);
 await absent(f.root);await absent(f.root+".build");
}));
test("cancelled build removes allocated outputs without persisting a verification helper",local,()=>fixture(async f=>{
 const controller=new AbortController();
 await assert.rejects(buildNativeFileBroker({...f,signal:controller.signal,runCompiler:async(...args)=>{const value=await f.runCompiler(...args);if(args[1][0]==="build-obj")controller.abort();return value;}}),/interrupted/);
 await absent(f.root);await absent(f.root+".build");await absent(f.verification);
}));
test("signal kills and drains a real task-owned compiler process before cleanup",local,()=>fixture(async f=>{
 const ready=join(f.base,"compiler-ready");await writeFile(f.zig,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';if(process.argv[2]==='version'){process.stdout.write('0.13.0\\n');}else{writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}\n`,{mode:0o755});
 const controller=new AbortController(),build=buildNativeFileBroker({root:f.root,zig:f.zig,signal:controller.signal});void build.catch(()=>{});
 let pid;
 try{
  const deadline=Date.now()+10000;
  while(pid===undefined){try{pid=Number(await readFile(ready,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;if(Date.now()>deadline)throw Error("Synthetic compiler did not start");await new Promise(done=>setTimeout(done,20));}}
  controller.abort();await assert.rejects(build,/interrupted/);assert.throws(()=>process.kill(pid,0),error=>error.code==="ESRCH");
  await absent(f.root);await absent(f.root+".build");
 }finally{controller.abort();await build.catch(()=>{});}
}));
test("missing compiler executable fails without allocating output or cache",local,()=>fixture(async f=>{
 await assert.rejects(buildNativeFileBroker({root:f.root,zig:f.zig}),error=>error.code==="ENOENT");await absent(f.root);await absent(f.root+".build");
}));
