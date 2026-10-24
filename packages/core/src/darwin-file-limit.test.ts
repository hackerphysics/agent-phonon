import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {darwinFileRead,darwinFileWrite} from "./darwin-file-broker.js";

test("macOS broker carries 20 MiB plus base64 overhead and verifies the same bytes",{skip:process.platform!=="darwin"},async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-photo-broker-"))),bytes=Buffer.alloc(20*1024*1024,0x56);
  const hash=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
  try {
    const written=await darwinFileWrite(root,"photo.bin",bytes,false,false);assert.equal(written.sizeBytes,bytes.length);
    const read=await darwinFileRead(root,"photo.bin",bytes.length);assert.equal(read.sizeBytes,bytes.length);assert.equal(read.truncated,false);
    assert.equal(hash(Buffer.from(read.data,"base64")),hash(bytes));
    await assert.rejects(darwinFileWrite(root,"too-large.bin",Buffer.alloc(bytes.length+1),false,false));
    await assert.rejects(darwinFileRead(root,"photo.bin",bytes.length+1));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
