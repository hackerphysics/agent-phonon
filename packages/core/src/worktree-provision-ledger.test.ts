import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,realpathSync,rmSync,chmodSync,symlinkSync,writeFileSync,statSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID,createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {WorktreeProvisionLedger,type WorktreeProvisionInput,type WorktreeProvisionRecord} from "./worktree-provision-ledger.js";
import {PhononError} from "./rpc.js";
import {workspacePathKey} from "./workspace-paths.js";

function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),"phonon-worktree-ledger-test-")));
  const database=join(base,"worktrees.sqlite");
  return {base,database,cleanup(){rmSync(base,{recursive:true,force:true});}};
}
function payload(base:string,overrides:Partial<WorktreeProvisionInput>={}):WorktreeProvisionInput{
  const requestID=overrides.request_id??randomUUID();
  const path=overrides.path??join(base,"worktrees",`wt-${randomUUID()}`);
  const row:WorktreeProvisionInput={
    tenant:"account-a",request_id:requestID,request_hash:createHash("sha256").update(requestID).digest("hex"),receiver_id:randomUUID(),project_id:"project-a",
    source_path:"/repos/app",source_identity:"dir:1:2",source_common_dir:"/repos/app/.git",source_common_identity:"dir:3:4",
    base_commit:"a".repeat(40),base_branch:"main",new_branch:`feature/${randomUUID()}`,name:"Worktree",workspace_id:`workspace-${randomUUID()}`,
    path,path_key:workspacePathKey(path),created_at:new Date().toISOString()};
  return Object.assign(row,overrides);
}
function code(fn:()=>unknown):string{
  try{fn();}catch(error){return error instanceof PhononError?error.appCode:`unexpected:${(error as Error).message}`;}
  return "no-error";
}

test("the receiver is stable per tenant and is only created on demand",()=>{
  const f=fixture();
  try{
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      assert.equal(ledger.receiver("account-a",false),undefined);
      const first=ledger.receiver("account-a");
      assert.ok(first);
      assert.equal(ledger.receiver("account-a"),first);
      assert.notEqual(ledger.receiver("account-b"),first);
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("a prepared worktree survives reopen without a second preparation",()=>{
  const f=fixture();
  try{
    const input=payload(f.base);
    const first=new WorktreeProvisionLedger(f.database);
    let row:WorktreeProvisionRecord|undefined;
    try{row=first.prepare(input);}finally{first.close();}
    assert.ok(row);
    assert.equal(row.state,"prepared");
    assert.equal(row.claim,null);
    assert.equal(row.directory_identity,null);
    const reopened=new WorktreeProvisionLedger(f.database);
    try{
      const again=reopened.prepare(input);
      assert.equal(again.request_id,row.request_id);
      assert.equal(again.path,row.path);
      assert.equal(again.state,"prepared");
      assert.equal(reopened.get("account-a",input.request_id)?.created_at,row.created_at);
      assert.equal(reopened.workspace("account-a",input.workspace_id)?.request_id,input.request_id);
      assert.equal(reopened.workspace("account-b",input.workspace_id),undefined);
    }finally{reopened.close();}
  }finally{f.cleanup();}
});

test("the same request id with a different payload hash is rejected",()=>{
  const f=fixture();
  try{
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      const input=payload(f.base);
      ledger.prepare(input);
      assert.equal(code(()=>ledger.prepare({...input,request_hash:createHash("sha256").update("other").digest("hex"),new_branch:"feature/other"})),"errInvalidParams");
      assert.equal(code(()=>ledger.prepare({...input,path:join(f.base,"worktrees","moved"),path_key:workspacePathKey(join(f.base,"worktrees","moved"))})),"errProjectProvisionChanged");
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("a replaced source repository or a foreign receiver is refused",()=>{
  const f=fixture();
  try{
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      const input=payload(f.base);
      ledger.prepare(input);
      assert.equal(code(()=>ledger.prepare({...payload(f.base),receiver_id:input.receiver_id,source_path:input.source_path,source_identity:"dir:9:9",source_common_identity:"dir:9:9"})),"errProjectProvisionChanged");
      assert.equal(code(()=>ledger.prepare({...payload(f.base),receiver_id:randomUUID()})),"errProjectProvisionChanged");
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("only one controller dispatches a prepared worktree and a claim is consumed once",()=>{
  const f=fixture();
  try{
    const input=payload(f.base);
    const a=new WorktreeProvisionLedger(f.database);
    const b=new WorktreeProvisionLedger(f.database);
    try{
      const row=a.prepare(input);
      const results=[a.claim(row,"claim-a"),b.claim(row,"claim-b")];
      assert.equal(results.filter(Boolean).length,1);
      const winner=results[0]?"claim-a":"claim-b";
      assert.equal(a.claim(row,winner),false);
      const loser=winner==="claim-a"?"claim-b":"claim-a";
      assert.equal(a.claim(row,loser),false);
      assert.equal(a.get("account-a",input.request_id)?.claim,winner);
    }finally{a.close();b.close();}
  }finally{f.cleanup();}
});

test("confirmation is terminal and confirmation identities cannot be rewritten",()=>{
  const f=fixture();
  try{
    const input=payload(f.base);
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      const row=ledger.prepare(input);
      assert.equal(ledger.claim(row,"claim-a"),true);
      ledger.confirm(row,"claim-a","dir:5:6","/repos/app/.git/worktrees/wt","dir:7:8");
      const confirmed=ledger.get("account-a",input.request_id)!;
      assert.equal(confirmed.state,"confirmed");
      assert.equal(confirmed.directory_identity,"dir:5:6");
      assert.equal(confirmed.git_directory,"/repos/app/.git/worktrees/wt");
      assert.equal(confirmed.git_identity,"dir:7:8");
      assert.equal(ledger.settle(confirmed,"failed"),false);
      assert.equal(ledger.claim(row,"claim-b"),false);
      assert.equal(code(()=>ledger.confirm(row,"claim-a","dir:5:6","/repos/app/.git/worktrees/wt","dir:7:8")),"errProjectProvisionUnconfirmed");
      const raw=new DatabaseSync(f.database);
      try{
        assert.throws(()=>raw.exec("UPDATE worktrees SET directory_identity='dir:1:1'"));
        assert.throws(()=>raw.exec("UPDATE worktrees SET state='unknown'"));
        assert.throws(()=>raw.exec("DELETE FROM worktrees"));
      }finally{raw.close();}
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("an unsettled dispatch never returns to prepared and is never dispatched twice",()=>{
  const f=fixture();
  try{
    const input=payload(f.base);
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      const row=ledger.prepare(input);
      assert.equal(ledger.claim(row,"claim-a"),true);
      const dispatched=ledger.get("account-a",input.request_id)!;
      assert.equal(dispatched.state,"dispatched");
      assert.equal(dispatched.claim,"claim-a");
      assert.equal(ledger.settle({...dispatched,claim:"claim-other"},"unknown"),false);
      assert.equal(ledger.get("account-a",input.request_id)?.state,"dispatched");
      assert.equal(ledger.settle(dispatched,"unknown"),true);
      assert.equal(ledger.settle(dispatched,"failed"),false);
      assert.equal(ledger.claim(row,"claim-b"),false);
      assert.equal(ledger.get("account-a",input.request_id)?.state,"unknown");
      const raw=new DatabaseSync(f.database);
      try{assert.throws(()=>raw.exec("UPDATE worktrees SET state='prepared'"));}
      finally{raw.close();}
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("invalid identities and malformed commits are refused",()=>{
  const f=fixture();
  try{
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      assert.equal(code(()=>ledger.prepare(payload(f.base,{source_identity:"dir:zz:1"}))),"errInvalidParams");
      assert.equal(code(()=>ledger.prepare(payload(f.base,{base_commit:"a".repeat(39)}))),"errInvalidParams");
      const input=payload(f.base);
      const row=ledger.prepare(input);
      assert.equal(ledger.claim(row,"claim-a"),true);
      assert.equal(code(()=>ledger.confirm(row,"claim-a","dir:5:6","/repos/app/.git","not-an-identity")),"errInvalidParams");
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("long target keys are accepted within the bounded limit",()=>{
  const f=fixture();
  try{
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      const deep=join(f.base,"worktrees",...Array.from({length:24},()=>"segment-with-a-long-name"));
      const longKey=join(f.base,"k").padEnd(4000,"x");
      const row=ledger.prepare(payload(f.base,{path:deep,path_key:longKey}));
      assert.equal(row.path_key,longKey);
      assert.equal(code(()=>ledger.prepare(payload(f.base,{path:join(deep,"other"),path_key:"y".repeat(4097)}))),"errInvalidParams");
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("tenant worktree history is capped and overlapping targets are reported",()=>{
  const f=fixture();
  try{
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      const input=payload(f.base);
      const first=ledger.prepare(input);
      const raw=new DatabaseSync(f.database);
      try{
        raw.exec("BEGIN IMMEDIATE");
        for(let index=1;index<1000;index++){
          const row=payload(f.base,{new_branch:`feature/bulk-${index}`,workspace_id:`workspace-bulk-${index}`,path:join(f.base,"worktrees",`bulk-${index}`),path_key:workspacePathKey(join(f.base,"worktrees",`bulk-${index}`))});
          raw.prepare(`INSERT INTO worktrees(tenant,request_id,request_hash,receiver_id,project_id,source_path,source_identity,source_common_dir,source_common_identity,base_commit,base_branch,new_branch,name,workspace_id,path,path_key,state,claim,directory_identity,git_directory,git_identity,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,NULL,?)`).run(row.tenant,row.request_id,row.request_hash,row.receiver_id,row.project_id,row.source_path,row.source_identity,row.source_common_dir,row.source_common_identity,row.base_commit,row.base_branch,row.new_branch,row.name,row.workspace_id,row.path,row.path_key,row.created_at);
        }
        raw.exec("COMMIT");
      }finally{raw.close();}
      assert.equal(code(()=>ledger.prepare(payload(f.base,{receiver_id:input.receiver_id}))),"errTenantQuotaExceeded");
      assert.equal(ledger.overlapping(workspacePathKey(join(first.path,"child")))?.request_id,input.request_id);
      assert.equal(ledger.overlapping(workspacePathKey(join(f.base,"elsewhere"))),undefined);
    }finally{ledger.close();}
  }finally{f.cleanup();}
});

test("a loosened or replaced ledger file stops the sidecar",()=>{
  const f=fixture();
  try{
    const ledger=new WorktreeProvisionLedger(f.database);
    try{
      assert.equal(statSync(f.database).mode&0o777,0o600);
      chmodSync(f.database,0o644);
      assert.equal(code(()=>ledger.receiver("account-a",false)),"errProjectProvisionChanged");
    }finally{ledger.close();}
    chmodSync(f.database,0o600);
    rmSync(f.database);
    const target=join(f.base,"elsewhere.sqlite");
    writeFileSync(target,"");
    chmodSync(target,0o600);
    symlinkSync(target,f.database);
    assert.equal(code(()=>new WorktreeProvisionLedger(f.database)),"errProjectProvisionChanged");
    assert.equal(existsSync(f.database),true);
  }finally{f.cleanup();}
});
