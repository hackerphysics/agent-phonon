import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,chmodSync,readdirSync,rmSync,existsSync,renameSync,linkSync,symlinkSync,statSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {spawn,spawnSync} from "node:child_process";
import {NativeFileBroker,NativeFileBrokerError,encodeNativeFileRequest,decodeNativeFileReply,type NativeFileReceipt,type NativeFileRequest} from "./native-file-broker.js";
import {nativeTreeManifest,nativeTreeHash} from "./native-tree.js";

const artifact=process.env.PHONON_FS_BROKER_ARTIFACT_ROOT,verification=process.env.PHONON_FS_BROKER_VERIFICATION_BINARY;
const nativeTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!artifact?"Prepared native tree broker required":false},fn);
const value=(reply:Awaited<ReturnType<NativeFileBroker["call"]>>)=>{assert.ok("data" in reply);return reply as NativeFileReceipt;};
function writable(path:string){chmodSync(path,0o700);for(const row of readdirSync(path,{withFileTypes:true})){const child=join(path,row.name);if(row.isDirectory())writable(child);else if(row.isFile())chmodSync(child,0o600);}}
async function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-tree-"))),root=join(base,"owned");mkdirSync(root);
  const broker=new NativeFileBroker(artifact!),rootIdentity=value(await broker.call({operation:"root",root})).rootIdentity;
  const data=new Map([["SKILL.md",Buffer.from("Exact selected entry")],["nested/helper.bin",Buffer.from([0,255,10,13,65])],["nested/run.sh",Buffer.from("#!/bin/sh\nexit 0\n")],["empty",Buffer.alloc(0)]]);
  const tree=nativeTreeManifest([{path:"nested",kind:"directory",size:0},...[...data].map(([path,bytes])=>({path,kind:"file",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),executable:path.endsWith(".sh")}))]);
  return {base,root,broker,data,tree,rootIdentity,
    request:(destinationName="v1"):NativeFileRequest=>({operation:"publish_tree",root,path:"versions",createParents:true,expectedRootIdentity:rootIdentity,destinationName,tree,treeData:data}),
    async publish(destinationName="v1"){return value(await broker.call(this.request(destinationName)));},
    async verify(identity:string,destinationName="v1"){return value(await broker.call({operation:"verify_tree",root,path:"versions/"+destinationName,expectedRootIdentity:rootIdentity,expectedTreeIdentity:identity,tree}));},
    close(){writable(base);rmSync(base,{recursive:true,force:true});}};
}

nativeTest("one-shot rooted publication preserves all binary/empty/executable content and read-only verification returns the same tree identity",async()=>{
  const f=await fixture();try{
    const published=await f.publish();assert.equal(published.kind,"directory");assert.equal(published.mutated,true);
    for(const [path,data]of f.data)assert.deepEqual(readFileSync(join(f.root,"versions/v1",path)),data);
    assert.equal(statSync(join(f.root,"versions/v1/nested/run.sh")).mode&0o777,0o500);
    assert.equal(statSync(join(f.root,"versions/v1/SKILL.md")).mode&0o777,0o400);
    assert.equal((await f.verify(published.identity)).identity,published.identity);assert.equal((await f.verify(published.identity)).mutated,false);
    assert.equal(nativeTreeHash(f.tree),nativeTreeHash([...f.tree].reverse()));
    const probe=await f.broker.call({operation:"probe"});assert.ok("extensions" in probe);assert.deepEqual(probe.extensions,["publish_tree_v1","verify_tree_v1"]);
  }finally{f.close();}
});
nativeTest("a new publication never overwrites an existing destination and preserves its separate staging tree after uncertainty",async()=>{
  const f=await fixture();try{
    mkdirSync(join(f.root,"versions/v1"),{recursive:true});writeFileSync(join(f.root,"versions/v1/human.txt"),"Preserve the human destination");
    await assert.rejects(f.publish(),error=>error instanceof NativeFileBrokerError&&error.code==="exists"&&error.mutated);
    assert.equal(readFileSync(join(f.root,"versions/v1/human.txt"),"utf8"),"Preserve the human destination");
    assert.equal(existsSync(join(f.root,"versions/.stage-v1/SKILL.md")),true);
  }finally{f.close();}
});
nativeTest("tree verification refuses modified content, unexpected entries, hardlinks and links without returning foreign bytes",async()=>{
  const f=await fixture();try{
    const published=await f.publish(),root=join(f.root,"versions/v1"),entry=join(root,"SKILL.md");
    chmodSync(entry,0o600);writeFileSync(entry,"Human edited entry");chmodSync(entry,0o400);await assert.rejects(f.verify(published.identity));
    chmodSync(entry,0o600);writeFileSync(entry,f.data.get("SKILL.md")!);chmodSync(entry,0o400);await f.verify(published.identity);
    chmodSync(root,0o700);writeFileSync(join(root,"extra"),"Unlisted");chmodSync(root,0o500);await assert.rejects(f.verify(published.identity));
    chmodSync(root,0o700);rmSync(join(root,"extra"));rmSync(entry);const outside=join(f.base,"private.txt");writeFileSync(outside,"PRIVATE_FOREIGN_BYTES");linkSync(outside,entry);chmodSync(root,0o500);
    await assert.rejects(f.verify(published.identity));assert.equal(readFileSync(outside,"utf8"),"PRIVATE_FOREIGN_BYTES");
    chmodSync(root,0o700);rmSync(entry);symlinkSync(outside,entry);chmodSync(root,0o500);await assert.rejects(f.verify(published.identity));
  }finally{f.close();}
});
nativeTest("root replacement and tree replacement cannot borrow earlier publication identities",async()=>{
  const f=await fixture();try{
    const published=await f.publish();renameSync(join(f.root,"versions/v1"),join(f.root,"versions/kept"));mkdirSync(join(f.root,"versions/v1"));
    await assert.rejects(f.verify(published.identity),error=>error instanceof NativeFileBrokerError&&error.code==="path_changed"&&!error.mutated);
    renameSync(f.root,join(f.base,"original"));mkdirSync(f.root);
    await assert.rejects(f.publish("replacement"),error=>error instanceof NativeFileBrokerError&&error.code==="path_changed"&&!error.mutated);
    assert.equal(existsSync(join(f.root,"versions")),false);
  }finally{f.close();}
});
nativeTest("malformed, trailing and incomplete tree IPC cannot create even parent directories",async()=>{
  const f=await fixture();try{
    const metadata=JSON.parse(readFileSync(join(artifact!,"manifest.json"),"utf8")),binary=join(artifact!,metadata.targets[process.platform+"-"+process.arch].file),request=f.request(),wire=encodeNativeFileRequest(request);
    for(const input of [wire.subarray(0,-1),Buffer.concat([wire,Buffer.from("unexpected")])]){
      const result=spawnSync(binary,[],{input,timeout:5000});assert.equal(result.status,1);
      assert.throws(()=>decodeNativeFileReply(result.stdout,"publish_tree",result.status),error=>error instanceof NativeFileBrokerError&&!error.mutated);
      assert.equal(existsSync(join(f.root,"versions")),false);
    }
  }finally{f.close();}
});
test("tree manifests and codecs reject aliased/unlisted data, missing parents, bad hashes and read-side mutation options",()=>{
  for(const entries of [[{path:"../escape",kind:"directory",size:0}],[{path:"one/file",kind:"file",size:0,sha256:"a".repeat(64)}],
    [{path:"same",kind:"directory",size:0},{path:"SAME",kind:"directory",size:0}]])assert.throws(()=>nativeTreeManifest(entries));
  assert.throws(()=>encodeNativeFileRequest({operation:"verify_tree",root:"/owned",path:"v1",expectedRootIdentity:"p:1:2",expectedTreeIdentity:"p:1:3",createParents:true,tree:[]}));
});
test("a competing file inserted before final publication cannot hide behind a previously verified entry list",{skip:!artifact||!verification?"Separate native tree verification binary required":false},async()=>{
  const f=await fixture();try{
    const request=f.request(),wire=encodeNativeFileRequest(request);
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(verification!,[],{env:{...process.env,PHONON_FS_BROKER_TREE_BARRIER:"1"},stdio:["pipe","pipe","pipe"]});const chunks:Buffer[]=[];let error="",ready=false;
      const timer=setTimeout(()=>{child.kill();reject(Error("tree barrier did not become ready"));},5000);child.stdin.on("error",()=>{});child.on("error",reject);child.stdout.on("data",bytes=>chunks.push(bytes));
      child.stderr.on("data",bytes=>{error+=bytes.toString();if(!ready&&error.includes("PHONON_FS_TREE_READY")){ready=true;const stage=join(f.root,"versions/.stage-v1");chmodSync(stage,0o700);writeFileSync(join(stage,"human-extra"),"Must not activate");chmodSync(stage,0o500);child.stdin.end(Buffer.from([0xa6]));}});
      child.on("close",code=>{clearTimeout(timer);try{assert.equal(ready,true);assert.throws(()=>decodeNativeFileReply(Buffer.concat(chunks),"publish_tree",code),cause=>cause instanceof NativeFileBrokerError&&cause.mutated);assert.equal(existsSync(join(f.root,"versions/v1")),false);resolve();}catch(cause){reject(cause);}});child.stdin.write(wire);
    });
  }finally{f.close();}
});
