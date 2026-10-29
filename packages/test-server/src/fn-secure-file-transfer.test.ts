import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,realpath,readFile,writeFile,mkdir,rename,symlink,unlink,rm,lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry,PhononStore } from "@agent-phonon/core";
import { MockAdapter,TestConn } from "./harness.js";

test("secure file transfer rejects special files and symlink substitution, preserves binary bounds and exclusive writes",{skip:!["darwin","linux"].includes(process.platform),timeout:15000},async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"phonon-broker-adversarial-"))),outside=await realpath(await mkdtemp(join(tmpdir(),"phonon-broker-outside-")));
  const store=new PhononStore(join(root,"state.db")),registry=new AdapterRegistry();registry.register(new MockAdapter());
  const tc=new TestConn({registry,store,workspaceRoot:root,trustLocal:true});
  try{
    const created=await tc.call("project.create",{name:"safe",git:false})as any,projectId=created.project.projectId,project=created.project.path;
    const capabilities=(await tc.call("device.info",{})as any).capabilities;
    assert.ok(capabilities.includes(process.platform==="darwin"?"secure_file_transfer_darwin_v1":"secure_file_broker_linux_v1"));
    const bytes=Buffer.from([0,1,2,250,251,252]);
    await tc.call("file.write",{projectId,path:"binary.bin",encoding:"base64",data:bytes.toString("base64"),overwrite:false});
    const binary=await tc.call("file.read",{projectId,path:"binary.bin",encoding:"base64",maxBytes:3})as any;
    assert.deepEqual(Buffer.from(binary.data,"base64"),bytes.subarray(0,3));assert.equal(binary.sizeBytes,6);assert.equal(binary.truncated,true);
    await tc.call("file.write",{projectId,path:"empty.bin",data:"",overwrite:false});
    assert.equal((await tc.call("file.read",{projectId,path:"empty.bin",encoding:"base64",maxBytes:1})as any).sizeBytes,0);
    const writes=await Promise.allSettled(["first","second"].map(data=>tc.call("file.write",{projectId,path:"exclusive.txt",data,overwrite:false})));
    assert.equal(writes.filter(result=>result.status==="fulfilled").length,1);assert.ok(["first","second"].includes(await readFile(join(project,"exclusive.txt"),"utf8")));
    await promisify(execFile)("/usr/bin/mkfifo",[join(project,"pipe")]);
    const before=Date.now();await assert.rejects(tc.call("file.read",{projectId,path:"pipe",encoding:"base64"}));
    await assert.rejects(tc.call("file.write",{projectId,path:"pipe",data:"not a file"}));assert.ok(Date.now()-before<3000,"special-file rejection must not wait for a FIFO peer");
    await writeFile(join(outside,"secret.txt"),"outside secret");await symlink(join(outside,"secret.txt"),join(project,"final-link"));
    await assert.rejects(tc.call("file.read",{projectId,path:"final-link"}));await assert.rejects(tc.call("file.write",{projectId,path:"final-link",data:"changed"}));
    await mkdir(join(project,"changing"));await writeFile(join(project,"changing","secret.txt"),"inside file");
    await rename(join(project,"changing"),join(project,"pinned"));
    await assert.rejects(tc.call("file.write",{projectId,path:"changing/new.txt",data:"inside only",createDirs:false}));
    await assert.rejects(lstat(join(project,"changing")),{code:"ENOENT"});
    await tc.call("file.write",{projectId,path:"changing/new.txt",data:"inside only"});
    assert.equal(await readFile(join(project,"changing","new.txt"),"utf8"),"inside only");
    await rm(join(project,"changing"),{recursive:true});await symlink(outside,join(project,"changing"));
    await assert.rejects(tc.call("file.read",{projectId,path:"changing/secret.txt"}));
    await assert.rejects(tc.call("file.write",{projectId,path:"changing/new.txt",data:"outside forbidden"}));
    await unlink(join(project,"changing"));await rename(join(project,"pinned"),join(project,"changing"));
    let swapping=true;
    let swapFailure:unknown;
    const swap=(async()=>{for(let count=0;count<60&&swapping;count++){
      await rename(join(project,"changing"),join(project,"pinned"));await symlink(outside,join(project,"changing"));
      await new Promise(resolve=>setTimeout(resolve,1));await unlink(join(project,"changing"));await rename(join(project,"pinned"),join(project,"changing"));
    }})().catch(error=>{swapFailure=error;});
    try{
      for(let count=0;count<4;count++){
        try{const value=await tc.call("file.read",{projectId,path:"changing/secret.txt"})as any;assert.equal(value.data,"inside file");}catch(error){assert.notEqual((error as Error).name,"AssertionError");}
        // Parent creation is checked above; do not let the writer rebuild the swap fixture.
        try{await tc.call("file.write",{projectId,path:"changing/new.txt",data:"inside only",overwrite:false,createDirs:false});}catch{}
      }
    }finally{swapping=false;await swap;}
    assert.ifError(swapFailure);
    assert.equal(await readFile(join(outside,"secret.txt"),"utf8"),"outside secret");await assert.rejects(readFile(join(outside,"new.txt")));
  }finally{await tc.conn.dispose();store.close();await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
