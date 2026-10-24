import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {ConversationArchive} from "./conversation-archive.js";

test("v3 upgrade preserves existing blob proof and accepts a full 20 MiB archive",()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-photo-archive-")),path=join(root,"archive.sqlite"),authority="https://agents.example.test",owner="owner";
  const scope={conversationId:randomUUID(),archiveEpoch:randomUUID(),projectId:null},quota=100*1024*1024;
  let archive=new ConversationArchive(path);
  try {
    const initial=archive.status(authority,owner,scope);
    archive.append(authority,owner,{...scope,afterSequence:"0",afterHash:initial.headHash,entries:[{sequence:"1",recordId:randomUUID(),kind:"message",entityId:randomUUID(),revision:"1",payloadJSON:'{"text":"Original"}'}]},quota);
    const oldData=Buffer.from("Existing bytes"),old={...scope,blobId:randomUUID(),sha256:createHash("sha256").update(oldData).digest("hex"),sizeBytes:oldData.length};
    archive.writeBlob(authority,owner,{...old,offset:0,data:oldData.toString("base64")},quota);archive.close();
    const legacy=new DatabaseSync(path);
    const sql=String(legacy.prepare("SELECT sql FROM sqlite_master WHERE name='conversation_archive_blobs'").get()!.sql);
    legacy.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    legacy.exec(sql.replace('"conversation_archive_blobs"',"conversation_archive_blobs_legacy").replace("20971520","10485760"));
    legacy.exec("INSERT INTO conversation_archive_blobs_legacy SELECT * FROM conversation_archive_blobs; DROP TABLE conversation_archive_blobs; ALTER TABLE conversation_archive_blobs_legacy RENAME TO conversation_archive_blobs; PRAGMA user_version=3; COMMIT;");
    legacy.close();
    archive=new ConversationArchive(path);
    assert.equal(archive.blobStatus(authority,owner,old).complete,true);
    assert.deepEqual(Buffer.from(archive.readBlob(authority,owner,old).data,"base64"),oldData);
    const bytes=Buffer.alloc(20*1024*1024,0x47),blob={...scope,blobId:randomUUID(),sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    for(let offset=0;offset<bytes.length;offset+=256*1024)archive.writeBlob(authority,owner,{...blob,offset,data:bytes.subarray(offset,offset+256*1024).toString("base64")},quota);
    assert.equal(archive.blobStatus(authority,owner,blob).complete,true);
    const digest=createHash("sha256");
    for(let offset=0;offset<bytes.length;offset+=256*1024)digest.update(Buffer.from(archive.readBlob(authority,owner,{...blob,offset}).data,"base64"));
    assert.equal(digest.digest("hex"),blob.sha256);
    assert.throws(()=>archive.blobStatus(authority,owner,{...blob,sizeBytes:bytes.length+1}));
  } finally { archive.close();rmSync(root,{recursive:true,force:true}); }
});
