import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptWriter, PhononStore } from "@agent-phonon/core";

const formerRetention = { owner:"phonon-dev", maxBytes:8*1024*1024, maxFiles:2, maxAgeDays:7 };
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"phonon-session-retain-"));
  return {dir,writer:new TranscriptWriter(dir),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test("transcript retention: Dev meta does not opt a session into automatic deletion",()=>{
  const f=fixture();try{
    f.writer.append("s-dev","meta",{sessionId:"s-dev",workflowAttr:{devTrace:true}});
    const row=JSON.parse(readFileSync(f.writer.pathFor("s-dev"),"utf8"));
    assert.equal(row.retention,undefined);
  }finally{f.cleanup();}
});

test("transcript retention: large Dev input stays complete and is never rotated",()=>{
  const f=fixture();try{
    f.writer.append("s-large","meta",{sessionId:"s-large",workflowAttr:{devTrace:true}});
    const input="x".repeat(9*1024*1024);
    f.writer.append("s-large","input",{input});
    const rows=readFileSync(f.writer.pathFor("s-large"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(rows[1].input,input);
    assert(rows.every(row=>row.retention_truncated===undefined));
    assert.equal(existsSync(f.writer.pathFor("s-large")+".1"),false);
  }finally{f.cleanup();}
});

test("transcript retention: reopening an old retention header preserves both existing files",()=>{
  const f=fixture();try{
    const file=f.writer.pathFor("s-legacy");
    const previous=JSON.stringify({kind:"meta",sessionId:"s-legacy",retention:formerRetention})+"\n"+JSON.stringify({kind:"input",input:"old".repeat(3*1024*1024)})+"\n";
    writeFileSync(file,previous,{mode:0o600});writeFileSync(file+".1","previous archive\n",{mode:0o600});
    new TranscriptWriter(f.dir).append("s-legacy","event",{text:"new event"});
    assert(readFileSync(file,"utf8").startsWith(previous));
    assert(readFileSync(file,"utf8").includes("new event"));
    assert.equal(readFileSync(file+".1","utf8"),"previous archive\n");
  }finally{f.cleanup();}
});

test("transcript retention: new writes do not garbage collect aged Dev or ordinary sessions",()=>{
  const f=fixture();try{
    const old=new Date(Date.now()-90*86400000);
    const legacy=JSON.stringify({kind:"meta",sessionId:"s-old",retention:formerRetention})+"\n";
    for(const [name,data] of [["s-old.jsonl",legacy],["s-old.jsonl.1",legacy],["s-ordinary.jsonl","ordinary history\n"]]){
      const file=join(f.dir,name!);writeFileSync(file,data!,{mode:0o600});utimesSync(file,old,old);
    }
    f.writer.append("s-active","meta",{sessionId:"s-active",workflowAttr:{devTrace:true}});
    for(const name of ["s-old.jsonl","s-old.jsonl.1","s-ordinary.jsonl"])assert(existsSync(join(f.dir,name)),name);
  }finally{f.cleanup();}
});

test("transcript retention: delivery ACK removes pending events but not session history",()=>{
  const f=fixture();const store=new PhononStore(join(f.dir,"phonon.db"));try{
    f.writer.append("s-ack","input",{input:"retained history"});
    const before=readFileSync(f.writer.pathFor("s-ack"),"utf8");
    store.outboxAdd("tenant","s-ack",0,JSON.stringify({text:"delivery event"}),new Date().toISOString());
    assert.equal(store.outboxLoad("tenant").length,1);
    store.outboxAck("tenant","s-ack",0);
    assert.equal(store.outboxLoad("tenant").length,0);
    assert.equal(readFileSync(f.writer.pathFor("s-ack"),"utf8"),before);
  }finally{store.close();f.cleanup();}
});

test("transcript retention: explicit user deletion remains possible and new files stay private",()=>{
  const f=fixture();try{
    f.writer.append("s-user","input",{input:"history"});const file=f.writer.pathFor("s-user");
    if(process.platform!=="win32")assert.equal(statSync(file).mode&0o777,0o600);
    rmSync(file);assert.equal(existsSync(file),false);
    assert.throws(()=>readFileSync(file,"utf8"),{code:"ENOENT"});
  }finally{f.cleanup();}
});
