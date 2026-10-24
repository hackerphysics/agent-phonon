import test from "node:test";
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync,linkSync,renameSync,existsSync,cpSync,appendFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {NativeFileBroker,NativeFileBrokerError,encodeNativeFileRequest,decodeNativeFileReply,type NativeFileRequest,type NativeFileReceipt} from "./native-file-broker.js";

const artifact=process.env.PHONON_FS_BROKER_ARTIFACT_ROOT,verification=process.env.PHONON_FS_BROKER_VERIFICATION_BINARY;
test("file IPC accepts exactly 20 MiB and rejects larger transfers",()=>{
  const request={operation:"write" as const,root:"/owned",path:"photo.jpg",expectedRootIdentity:"p:1:2",data:Buffer.alloc(20*1024*1024)};
  assert.ok(encodeNativeFileRequest(request).length>request.data.length);
  assert.throws(()=>encodeNativeFileRequest({...request,data:Buffer.alloc(20*1024*1024+1)}),NativeFileBrokerError);
  assert.doesNotThrow(()=>encodeNativeFileRequest({...request,operation:"read",data:undefined,maxBytes:20*1024*1024}));
  assert.throws(()=>encodeNativeFileRequest({...request,operation:"read",data:undefined,maxBytes:20*1024*1024+1}),NativeFileBrokerError);
});
const nativeTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!artifact?"Prepare native broker artifacts locally first":false},fn);
const raceTest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!artifact||!verification?"Prepare the separate local verification binary first":false},fn);
function receipt(value:Awaited<ReturnType<NativeFileBroker["call"]>>):NativeFileReceipt{assert.ok("data" in value);return value;}
function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-native-broker-"))),root=join(base,"owned"),outside=join(base,"foreign");
  mkdirSync(root);mkdirSync(outside);writeFileSync(join(outside,"private.txt"),"Foreign content");
  const driver=new NativeFileBroker(artifact!);let binding:Promise<string>|undefined;
  const bind=()=>binding??=driver.call({operation:"root",root}).then(value=>receipt(value).rootIdentity);
  const broker={async call(request:NativeFileRequest){
    return driver.call(request.operation==="root"||request.operation==="probe"?request:{...request,expectedRootIdentity:request.expectedRootIdentity??await bind()});
  }};
  return {base,root,outside,broker,driver,bind,close(){rmSync(base,{recursive:true,force:true});}};
}
async function deny(promise:Promise<unknown>,code:string,mutated=false){
  await assert.rejects(promise,error=>error instanceof NativeFileBrokerError&&error.code===code&&error.mutated===mutated);
}
async function raced(request:NativeFileRequest,mutate:()=>void){
  const root=receipt(await new NativeFileBroker(artifact!).call({operation:"root",root:request.root})).rootIdentity;
  request={...request,expectedRootIdentity:root};
  return await new Promise<NativeFileReceipt>((resolve,reject)=>{
    const child=spawn(verification!,[],{env:{...process.env,PHONON_FS_BROKER_TEST_BARRIER:"1"},stdio:["pipe","pipe","pipe"]});
    const chunks:Buffer[]=[];let diagnostics="",observed=false,cause:unknown;
    const timer=setTimeout(()=>{cause=Error("native test barrier timed out");child.kill();},5000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});child.stdin.on("error",()=>{});
    child.stdout.on("data",(bytes:Buffer)=>chunks.push(bytes));
    child.stderr.on("data",(bytes:Buffer)=>{
      diagnostics+=bytes.toString();
      if(!observed&&diagnostics.includes("PHONON_FS_PARENT_READY\n")){
        observed=true;try{mutate();child.stdin.end(Buffer.from([0xa5]));}catch(error){cause=error;child.kill();}
      }
    });
    child.once("close",code=>{
      clearTimeout(timer);if(cause){reject(cause);return;}
      try{assert.equal(observed,true);resolve(receipt(decodeNativeFileReply(Buffer.concat(chunks),request.operation,code)));}catch(error){reject(error);}
    });
    child.stdin.write(encodeNativeFileRequest(request));
  });
}

nativeTest("native artifacts have three target-compatible binary formats, integrity pins and minimal runtime contents",async()=>{
  const manifest=JSON.parse(readFileSync(join(artifact!,"manifest.json"),"utf8"));
  assert.equal(manifest.schema,2);assert.deepEqual(Object.keys(manifest.targets).sort(),["darwin-arm64","linux-x64","win32-x64"]);
  for(const [target,item] of Object.entries(manifest.targets) as Array<[string,{file:string;sha256:string;size:number}]>){
    const bytes=readFileSync(join(artifact!,item.file));assert.equal(bytes.length,item.size);assert.equal(createHash("sha256").update(bytes).digest("hex"),item.sha256);
    assert.ok(bytes.length<1024*1024);
    if(target==="darwin-arm64"){assert.equal(bytes.readUInt32LE(0),0xfeedfacf);assert.equal(bytes.readUInt32LE(4),0x0100000c);}
    else if(target==="linux-x64"){assert.equal(bytes.subarray(0,4).toString(),"\x7fELF");assert.equal(bytes[4],2);assert.equal(bytes.readUInt16LE(18),62);}
    else{assert.equal(bytes.subarray(0,2).toString(),"MZ");const pe=bytes.readUInt32LE(0x3c);assert.equal(bytes.subarray(pe,pe+4).toString(),"PE\0\0");assert.equal(bytes.readUInt16LE(pe+4),0x8664);}
  }
  assert.ok(readFileSync(join(artifact!,"THIRD_PARTY_NOTICES.txt"),"utf8").includes("musl"));
  assert.ok(readFileSync(join(artifact!,"LICENSE"),"utf8").length>100);
  const binary=readFileSync(join(artifact!,manifest.targets[process.platform+"-"+process.arch].file));
  assert.equal(binary.includes(Buffer.from("PHONON_FS_BROKER_TEST_BARRIER")),false);
  const probe=await new NativeFileBroker(artifact!).call({operation:"probe"});assert.ok("platform" in probe);assert.equal(probe.platform,process.platform);
});

nativeTest("anchored native reads are binary-safe, bounded and return stable root/file identities",async()=>{
  const f=fixture();try{
    const bytes=Buffer.from([0,255,10,13,1,65,66]);writeFileSync(join(f.root,"bytes.bin"),bytes);
    const a=receipt(await f.broker.call({operation:"read",root:f.root,path:"bytes.bin",maxBytes:3}));
    assert.deepEqual(a.data,bytes.subarray(0,3));assert.equal(a.truncated,true);assert.equal(a.sizeBytes,"7");assert.equal(a.mutated,false);
    const b=receipt(await f.broker.call({operation:"read",root:f.root,path:"bytes.bin"}));assert.deepEqual(b.data,bytes);assert.equal(b.truncated,false);assert.equal(b.rootIdentity,a.rootIdentity);assert.equal(b.identity,a.identity);
  }finally{f.close();}
});

nativeTest("native writes are exclusive by default and require explicit overwrite for an existing regular file",async()=>{
  const f=fixture();try{
    const request={operation:"write" as const,root:f.root,path:"owned.txt",data:Buffer.from("Original")};
    assert.equal(receipt(await f.broker.call(request)).mutated,true);
    await deny(f.broker.call({...request,data:Buffer.from("Must not overwrite")}),"exists");
    assert.equal(readFileSync(join(f.root,"owned.txt"),"utf8"),"Original");
    const updated=receipt(await f.broker.call({...request,overwrite:true,data:Buffer.from("Changed")}));assert.equal(updated.sizeBytes,"7");assert.equal(updated.mutated,true);
    assert.equal(readFileSync(join(f.root,"owned.txt"),"utf8"),"Changed");
    assert.equal(statSync(join(f.root,"owned.txt")).mode&0o777,0o600);
  }finally{f.close();}
});

nativeTest("creating parent directories is explicit and newly created directories remain private",async()=>{
  const f=fixture();try{
    await deny(f.broker.call({operation:"write",root:f.root,path:"new/deep/file",data:Buffer.from("A")}),"not_found");
    assert.equal(existsSync(join(f.root,"new")),false);
    await f.broker.call({operation:"write",root:f.root,path:"new/deep/file",data:Buffer.from("A"),createParents:true});
    assert.equal(statSync(join(f.root,"new")).mode&0o777,0o700);
    assert.equal(statSync(join(f.root,"new/deep")).mode&0o777,0o700);
    const made=receipt(await f.broker.call({operation:"mkdir",root:f.root,path:"empty"}));assert.equal(made.kind,"directory");
    const existing=receipt(await f.broker.call({operation:"mkdir",root:f.root,path:"empty"}));assert.equal(existing.mutated,false);
  }finally{f.close();}
});

nativeTest("native stat observes a link without dereferencing it while native reads and writes refuse the same link",async()=>{
  const f=fixture();try{
    symlinkSync(join(f.outside,"private.txt"),join(f.root,"linked"));
    const meta=receipt(await f.broker.call({operation:"stat",root:f.root,path:"linked"}));assert.equal(meta.kind,"symlink");assert.equal(meta.data.length,0);
    await deny(f.broker.call({operation:"read",root:f.root,path:"linked"}),"path_denied");
    await deny(f.broker.call({operation:"write",root:f.root,path:"linked",overwrite:true,data:Buffer.from("Forbidden")}),"path_denied");
    assert.equal(readFileSync(join(f.outside,"private.txt"),"utf8"),"Foreign content");
  }finally{f.close();}
});

nativeTest("native no-follow traversal refuses symlink roots and parent directories before reading foreign bytes",async()=>{
  const f=fixture();try{
    const alias=join(f.base,"root-alias");symlinkSync(f.root,alias,"dir");symlinkSync(f.outside,join(f.root,"jump"),"dir");
    await deny(f.broker.call({operation:"read",root:alias,path:"anything"}),"path_denied");
    await deny(f.broker.call({operation:"read",root:f.root,path:"jump/private.txt"}),"path_denied");
    await deny(f.broker.call({operation:"write",root:f.root,path:"jump/private.txt",overwrite:true,data:Buffer.from("Forbidden")}),"path_denied");
    assert.equal(readFileSync(join(f.outside,"private.txt"),"utf8"),"Foreign content");
  }finally{f.close();}
});

nativeTest("native file-handle checks refuse hardlinks before read disclosure or truncation",async()=>{
  const f=fixture();try{
    linkSync(join(f.outside,"private.txt"),join(f.root,"hardlink"));
    await deny(f.broker.call({operation:"read",root:f.root,path:"hardlink"}),"path_denied");
    await deny(f.broker.call({operation:"write",root:f.root,path:"hardlink",overwrite:true,data:Buffer.from("Forbidden")}),"path_denied");
    assert.equal(readFileSync(join(f.outside,"private.txt"),"utf8"),"Foreign content");
  }finally{f.close();}
});

nativeTest("invalid relative paths are rejected before any requested parents are created",async()=>{
  const f=fixture();try{
    for(const path of ["new/../escape","new//escape","new/./escape","new/trailing.","new/CON.txt","new/file:stream","new\\escape","/absolute","new/end/"]){
      await deny(f.broker.call({operation:"write",root:f.root,path,data:Buffer.from("Forbidden"),createParents:true}),"path_denied");
      assert.equal(existsSync(join(f.root,"new")),false,path);
    }
  }finally{f.close();}
});

nativeTest("malformed/trailing private IPC cannot create a parent directory or publish anything",async()=>{
  const f=fixture();try{
    const manifest=JSON.parse(readFileSync(join(artifact!,"manifest.json"),"utf8")),binary=join(artifact!,manifest.targets[process.platform+"-"+process.arch].file);
    const packet=encodeNativeFileRequest({operation:"write",root:f.root,expectedRootIdentity:await f.bind(),path:"new/file",createParents:true,data:Buffer.from("A")});
    for(const input of [Buffer.concat([packet,Buffer.from("unexpected")]),packet.subarray(0,-1)]){
      const result=spawnSync(binary,[],{input,timeout:5000});assert.equal(result.status,1);
      assert.throws(()=>decodeNativeFileReply(result.stdout,"write",result.status),error=>error instanceof NativeFileBrokerError&&error.code==="invalid_request"&&!error.mutated);
      assert.equal(existsSync(join(f.root,"new")),false);
    }
  }finally{f.close();}
});

nativeTest("a root replaced before the helper starts cannot reuse an earlier authorized directory identity",async()=>{
  const f=fixture();try{
    const expectedRootIdentity=await f.bind();renameSync(f.root,join(f.base,"original"));mkdirSync(f.root);writeFileSync(join(f.root,"private.txt"),"Replacement content");
    await deny(f.driver.call({operation:"read",root:f.root,path:"private.txt",expectedRootIdentity}),"path_changed");
    await deny(f.driver.call({operation:"write",root:f.root,path:"new/file",createParents:true,data:Buffer.from("Forbidden"),expectedRootIdentity}),"path_changed");
    assert.equal(existsSync(join(f.root,"new")),false);assert.equal(readFileSync(join(f.root,"private.txt"),"utf8"),"Replacement content");
  }finally{f.close();}
});

test("content operations require an explicit expected root identity rather than silently authorizing a path",()=>{
  for(const operation of ["read","write","mkdir","publish_new","stat"] as const)
    assert.throws(()=>encodeNativeFileRequest({operation,root:"/unbound",path:"name"}),error=>error instanceof NativeFileBrokerError&&error.code==="invalid_request"&&!error.mutated);
});

nativeTest("atomic publication to a new name preserves its identity and never overwrites even an empty existing target",async()=>{
  const f=fixture();try{
    mkdirSync(join(f.root,"staged"));writeFileSync(join(f.root,"staged/SKILL.md"),"New source");
    const before=receipt(await f.broker.call({operation:"stat",root:f.root,path:"staged"}));
    const published=receipt(await f.broker.call({operation:"publish_new",root:f.root,path:"staged",destinationName:"published"}));
    assert.equal(published.identity,before.identity);assert.equal(published.mutated,true);assert.equal(existsSync(join(f.root,"staged")),false);
    assert.equal(readFileSync(join(f.root,"published/SKILL.md"),"utf8"),"New source");
    mkdirSync(join(f.root,"another"));mkdirSync(join(f.root,"existing"));
    await deny(f.broker.call({operation:"publish_new",root:f.root,path:"another",destinationName:"existing"}),"exists");
    assert.equal(existsSync(join(f.root,"another")),true);assert.equal(existsSync(join(f.root,"existing")),true);
  }finally{f.close();}
});

nativeTest("publication cannot use a symlink source, path-selected destination or cross-parent target",async()=>{
  const f=fixture();try{
    symlinkSync(f.outside,join(f.root,"staged"),"dir");
    await deny(f.broker.call({operation:"publish_new",root:f.root,path:"staged",destinationName:"published"}),"path_denied");
    await deny(f.broker.call({operation:"publish_new",root:f.root,path:"staged",destinationName:"../escape"}),"path_denied");
    assert.equal(readFileSync(join(f.outside,"private.txt"),"utf8"),"Foreign content");assert.equal(existsSync(join(f.root,"published")),false);
  }finally{f.close();}
});

nativeTest("tampered executable bytes and escaped manifest paths are refused before spawn",async()=>{
  const f=fixture(),copy=join(f.base,"artifacts");try{
    cpSync(artifact!,copy,{recursive:true});const manifest=JSON.parse(readFileSync(join(copy,"manifest.json"),"utf8")),entry=manifest.targets[process.platform+"-"+process.arch];
    appendFileSync(join(copy,entry.file),"tampered");await deny(new NativeFileBroker(copy).call({operation:"probe"}),"unsupported");
    entry.file="../borrowed";writeFileSync(join(copy,"manifest.json"),JSON.stringify(manifest));await deny(new NativeFileBroker(copy).call({operation:"probe"}),"unsupported");
  }finally{f.close();}
});

test("unconfirmed private broker replies never manufacture a successful mutation receipt",()=>{
  for(const output of [Buffer.alloc(0),Buffer.from("not json\n"),Buffer.from('{"ok":true}\n'),Buffer.from('{"ok":false,"code":"exists","mutated":false}\nextra')]){
    assert.throws(()=>decodeNativeFileReply(output,"publish_new",0),error=>error instanceof NativeFileBrokerError&&error.code==="transport_unconfirmed"&&error.mutated);
  }
});

raceTest("a root swap between anchored open and use cannot disclose replacement bytes or overwrite the other tree",async()=>{
  const f=fixture();try{
    writeFileSync(join(f.root,"private.txt"),"Owned content");
    await deny(raced({operation:"read",root:f.root,path:"private.txt"},()=>{renameSync(f.root,join(f.base,"old"));symlinkSync(f.outside,f.root,"dir");}),"path_changed");
    assert.equal(readFileSync(join(f.outside,"private.txt"),"utf8"),"Foreign content");
  }finally{f.close();}
});

raceTest("a parent swap after directory handles are opened is refused before the first write",async()=>{
  const f=fixture();try{
    mkdirSync(join(f.root,"parent"));writeFileSync(join(f.root,"parent/private.txt"),"Owned content");
    await deny(raced({operation:"write",root:f.root,path:"parent/private.txt",overwrite:true,data:Buffer.from("Forbidden")},()=>{renameSync(join(f.root,"parent"),join(f.root,"old"));symlinkSync(f.outside,join(f.root,"parent"),"dir");}),"path_changed");
    assert.equal(readFileSync(join(f.root,"old/private.txt"),"utf8"),"Owned content");assert.equal(readFileSync(join(f.outside,"private.txt"),"utf8"),"Foreign content");
  }finally{f.close();}
});

raceTest("a competing destination created immediately before publication is retained unchanged",async()=>{
  const f=fixture();try{
    mkdirSync(join(f.root,"stage"));writeFileSync(join(f.root,"stage/SKILL.md"),"Prepared source");
    await deny(raced({operation:"publish_new",root:f.root,path:"stage",destinationName:"winner"},()=>{mkdirSync(join(f.root,"winner"));writeFileSync(join(f.root,"winner/SKILL.md"),"Concurrent human content");}),"exists");
    assert.equal(readFileSync(join(f.root,"winner/SKILL.md"),"utf8"),"Concurrent human content");assert.equal(readFileSync(join(f.root,"stage/SKILL.md"),"utf8"),"Prepared source");
  }finally{f.close();}
});
