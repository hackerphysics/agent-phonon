import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile,symlink,rename,stat} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {NativeFileBroker,NativeFileBrokerError,encodeNativeFileRequest,decodeNativeFileReply,type NativeFileReceipt} from "./native-file-broker.js";

const artifact=process.env.PHONON_EXCLUSIVE_MKDIR_ARTIFACT_ROOT,binary=process.env.PHONON_EXCLUSIVE_MKDIR_TEST_BINARY,verification=process.env.PHONON_EXCLUSIVE_MKDIR_VERIFICATION_BINARY;
const nativeTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!artifact&&!binary?"Prepared exclusive-mkdir helper required":false},fn);
async function driver(){
  const broker=new NativeFileBroker(artifact??"not-a-runtime-artifact");
  if(binary){
    assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"),process.env.PHONON_EXCLUSIVE_MKDIR_TEST_SHA256);
    // Local filesystem-only test binary, never a packaged/runtime integrity claim.
    Object.defineProperty(broker,"binary",{value:async()=>binary});
  }
  return broker;
}
const receipt=(value:Awaited<ReturnType<NativeFileBroker["call"]>>):NativeFileReceipt=>{assert.ok("data" in value);return value;};
test("exclusive directory wire operation cannot downgrade to legacy mkdir or create uncontrolled parents",()=>{
  const request={operation:"mkdir_new" as const,root:"/owned",path:"new",expectedRootIdentity:"p:1:2"};
  assert.equal(encodeNativeFileRequest(request)[4],9);
  assert.equal(encodeNativeFileRequest({...request,operation:"mkdir"})[4],3);
  for(const patch of[{overwrite:true},{createParents:true},{data:Buffer.alloc(0)},{destinationName:"other"}])assert.throws(()=>encodeNativeFileRequest({...request,...patch}),NativeFileBrokerError);
  assert.throws(()=>encodeNativeFileRequest({...request,expectedRootIdentity:undefined}),NativeFileBrokerError);
  assert.throws(()=>encodeNativeFileRequest({...request,extendedProbe:true}),NativeFileBrokerError);
});
test("extension discovery is opt-in and leaves old probe framing unchanged",()=>{
  const ordinary=encodeNativeFileRequest({operation:"probe"}),extended=encodeNativeFileRequest({operation:"probe",extendedProbe:true});
  assert.equal(ordinary.readUInt32LE(16),0);assert.equal(extended.readUInt32LE(16),1);
  assert.deepEqual(ordinary.subarray(0,16),extended.subarray(0,16));
});
test("lost exclusive-create responses remain uncertain physical mutations",()=>{
  assert.throws(()=>decodeNativeFileReply(Buffer.from("truncated"),"mkdir_new",1),error=>error instanceof NativeFileBrokerError&&error.code==="transport_unconfirmed"&&error.mutated);
});
async function fixture(){
  const base=await realpath(await mkdtemp(join(tmpdir(),"phonon-exclusive-mkdir-"))),root=join(base,"owned"),foreign=join(base,"foreign");
  try{
    await writeFile(join(base,"owner.json"),JSON.stringify({pid:process.pid,purpose:"exclusive-mkdir-tests"}));
    await mkdir(root);await mkdir(foreign);await writeFile(join(foreign,"keep.txt"),"Foreign original");
    const broker=await driver(),identity=receipt(await broker.call({operation:"root",root})).identity;
    return {base,root,foreign,broker,identity,async close(){
      const owner=JSON.parse(await readFile(join(base,"owner.json"),"utf8"));
      if(owner.pid!==process.pid||owner.purpose!=="exclusive-mkdir-tests")throw Error("Exclusive mkdir fixture ownership changed");
      await rm(base,{recursive:true,force:true});
    }};
  }catch(error){await rm(base,{recursive:true,force:true});throw error;}
}
nativeTest("extended discovery advertises exclusive creation without changing legacy probe contents",async()=>{
  const broker=await driver(),ordinary=await broker.call({operation:"probe"}),extended=await broker.call({operation:"probe",extendedProbe:true});
  assert.ok("extensions" in ordinary&&"extensions" in extended);
  assert.deepEqual(ordinary.extensions,["publish_tree_v1","verify_tree_v1"]);assert.deepEqual(extended.extensions,[...ordinary.extensions!,"exclusive_mkdir_v1"]);
});
nativeTest("exclusive mkdir creates one private anchored directory and refuses the same existing target",async()=>{
  const f=await fixture();try{
    const request={operation:"mkdir_new" as const,root:f.root,path:"new",expectedRootIdentity:f.identity},made=receipt(await f.broker.call(request));
    assert.equal(made.mutated,true);assert.equal(made.kind,"directory");assert.equal(made.rootIdentity,f.identity);
    if(process.platform!=="win32")assert.equal((await stat(join(f.root,"new"))).mode&0o777,0o700);
    await writeFile(join(f.root,"new","kept.txt"),"Owned contents");
    await assert.rejects(f.broker.call(request),error=>error instanceof NativeFileBrokerError&&error.code==="exists"&&!error.mutated);
    assert.equal(await readFile(join(f.root,"new","kept.txt"),"utf8"),"Owned contents");
    assert.equal(receipt(await f.broker.call({...request,operation:"mkdir"})).mutated,false);
  }finally{await f.close();}
});
nativeTest("exclusive mkdir cannot adopt linked/file targets or create absent parents",async()=>{
  const f=await fixture();try{
    await symlink(f.foreign,join(f.root,"link"),"dir");await writeFile(join(f.root,"file"),"Original file");
    for(const path of["link","file","missing/leaf","../foreign","link/child"]){
      await assert.rejects(f.broker.call({operation:"mkdir_new",root:f.root,path,expectedRootIdentity:f.identity}),NativeFileBrokerError);
    }
    assert.equal(existsSync(join(f.root,"missing")),false);assert.equal(existsSync(join(f.foreign,"child")),false);
    assert.equal(await readFile(join(f.foreign,"keep.txt"),"utf8"),"Foreign original");assert.equal(await readFile(join(f.root,"file"),"utf8"),"Original file");
  }finally{await f.close();}
});
nativeTest("only one competing process may claim the same exclusive directory",async()=>{
  const f=await fixture();try{
    const request={operation:"mkdir_new" as const,root:f.root,path:"winner",expectedRootIdentity:f.identity};
    const results=await Promise.allSettled([f.broker.call(request),f.broker.call(request)]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    const loser=results.find(r=>r.status==="rejected") as PromiseRejectedResult;
    assert.ok(loser.reason instanceof NativeFileBrokerError&&loser.reason.code==="exists"&&!loser.reason.mutated);
  }finally{await f.close();}
});
nativeTest("a replaced root is rejected before exclusive creation",async()=>{
  const f=await fixture();try{
    await rename(f.root,join(f.base,"original"));await mkdir(f.root);
    await assert.rejects(f.broker.call({operation:"mkdir_new",root:f.root,path:"new",expectedRootIdentity:f.identity}),error=>error instanceof NativeFileBrokerError&&error.code==="path_changed"&&!error.mutated);
    assert.equal(existsSync(join(f.root,"new")),false);
  }finally{await f.close();}
});
test("an old prepared helper fails closed before an exclusive create without falling back",{skip:!process.env.PHONON_LEGACY_BROKER_ROOT?"Legacy helper required":false},async()=>{
  const root=process.env.PHONON_LEGACY_BROKER_ROOT!,f=await fixture();try{
    await assert.rejects(new NativeFileBroker(root).call({operation:"mkdir_new",root:f.root,path:"new",expectedRootIdentity:f.identity}),error=>error instanceof NativeFileBrokerError&&error.code==="unsupported"&&!error.mutated);
    assert.equal(existsSync(join(f.root,"new")),false);
  }finally{await f.close();}
});
test("exclusive mkdir detects parent replacement at the actual anchored native boundary",{skip:!artifact&&!binary||!verification?"Dedicated verification helper required":false},async()=>{
  const f=await fixture();try{
    await mkdir(join(f.root,"parent"));
    const request={operation:"mkdir_new" as const,root:f.root,path:"parent/new",expectedRootIdentity:f.identity};
    await assert.rejects(new Promise((done,fail)=>{
      const child=spawn(verification!,[],{env:{PATH:"/usr/bin:/bin",PHONON_FS_BROKER_TEST_BARRIER:"1"},stdio:["pipe","pipe","pipe"]}),chunks:Buffer[]=[];
      let seen=false,diagnostic="",cause:unknown;const timer=setTimeout(()=>{cause=Error("Native mkdir barrier deadline");child.kill();},5000);
      child.once("error",error=>{clearTimeout(timer);fail(error);});child.stdin.on("error",()=>{});child.stdout.on("data",bytes=>chunks.push(bytes));
      child.stderr.on("data",bytes=>{diagnostic+=String(bytes);if(!seen&&diagnostic.includes("PHONON_FS_PARENT_READY\n")){
        seen=true;void(async()=>{await rename(join(f.root,"parent"),join(f.root,"original-parent"));await symlink(f.foreign,join(f.root,"parent"),"dir");child.stdin.end(Buffer.from([0xa5]));})().catch(error=>{cause=error;child.kill();});
      }});
      child.once("close",code=>{clearTimeout(timer);if(cause){fail(cause);return;}try{assert.equal(seen,true);done(decodeNativeFileReply(Buffer.concat(chunks),"mkdir_new",code));}catch(error){fail(error);}});
      child.stdin.write(encodeNativeFileRequest(request));
    }),error=>error instanceof NativeFileBrokerError&&error.code==="path_changed"&&!error.mutated);
    assert.equal(existsSync(join(f.foreign,"new")),false);assert.equal(existsSync(join(f.root,"original-parent/new")),false);
  }finally{await f.close();}
});
