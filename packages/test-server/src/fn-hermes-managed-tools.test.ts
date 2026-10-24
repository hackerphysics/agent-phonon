import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAdapter } from "../../core/dist/adapters/hermes.js";
import { AgentId } from "@agent-phonon/protocol";
import type { EmployeeProfileTarget } from "@agent-phonon/core";

const posix={skip:process.platform==="win32"};
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-managed-tools-")));
  const employeeId=randomUUID(),nonce=randomUUID(),workspace=join(root,employeeId),receipt=join(root,"invocation.json");
  mkdirSync(workspace,{mode:0o700});writeFileSync(join(workspace,".phonon-employee"),nonce,{mode:0o600});
  const python=join(root,"python3"),entry=join(root,"hermes");
  writeFileSync(python,`#!${process.execPath}\nconst fs=require('fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(text);fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(input));process.stdout.write(JSON.stringify({ok:true,result:{home:${JSON.stringify(join(root,"native"))},documentHashes:{},memoryBytes:0}}));});\n`,{mode:0o700});
  writeFileSync(entry,`#!${python}\n`,{mode:0o700});
  const target:EmployeeProfileTarget={input:{employeeId,revision:1,profileId:randomUUID(),agent:AgentId.parse("hermes:default"),model:"configured-model",name:"Owned fixture",responsibility:"Fixture",documents:{soul:"",agents:"",user:"",tools:""}},runtimeProfile:"phn-"+"a".repeat(40),workspace,nonce};
  return{root,entry,target,receipt,invocation(){return JSON.parse(readFileSync(receipt,"utf8"));},close(){rmSync(root,{recursive:true,force:true});}};
}

test("Hermes managed-profile native tools require the local boolean, not caller input",posix,async()=>{
  for(const flag of [undefined,false,true]){
    const f=fixture();
    try{
      Object.assign(f.target.input,{managedProfileNativeTools:true,hermesManagedProfileNativeTools:true});
      const adapter=new HermesAdapter({env:{binPath:f.entry,managedProfileNativeTools:flag}});
      await adapter.provisionEmployee(f.target);
      assert.equal(f.invocation().managedProfileNativeTools,flag===true);
      assert.equal(f.invocation().workspace,f.target.workspace);
    }finally{f.close();}
  }
  assert.throws(()=>new HermesAdapter({env:{managedProfileNativeTools:"true" as unknown as boolean}}),/must be a boolean/);
});

test("Hermes opt-in never enables existing-profile replays or inspections",posix,async()=>{
  for(const operation of ["replay","inspect"]){
    const f=fixture();
    try{
      const adapter=new HermesAdapter({env:{binPath:f.entry,managedProfileNativeTools:true}});
      if(operation==="replay"){f.target.previousHashes={};await adapter.provisionEmployee(f.target);}
      else await adapter.inspectEmployee(f.target);
      assert.equal(f.invocation().managedProfileNativeTools,false);
    }finally{f.close();}
  }
});

for(const kind of ["wrong-nonce","symlink-marker","hardlink-marker","writable-marker","writable-workspace","workspace-alias","wrong-basename","unmanaged-name","oversized-marker"]){
  test("Hermes Node ownership gate rejects "+kind+" before invoking native code",posix,async()=>{
    const f=fixture();
    try{
      const marker=join(f.target.workspace,".phonon-employee");
      if(kind==="wrong-nonce")writeFileSync(marker,randomUUID());
      if(kind==="symlink-marker"||kind==="hardlink-marker"){
        const copy=join(f.root,"marker-copy");writeFileSync(copy,f.target.nonce,{mode:0o600});rmSync(marker);
        if(kind==="symlink-marker")symlinkSync(copy,marker);else linkSync(copy,marker);
      }
      if(kind==="writable-marker")chmodSync(marker,0o622);
      if(kind==="writable-workspace")chmodSync(f.target.workspace,0o722);
      if(kind==="workspace-alias"){
        const parent=join(f.root,"alias");symlinkSync(f.root,parent);f.target.workspace=join(parent,f.target.input.employeeId);
      }
      if(kind==="wrong-basename")f.target.input.employeeId=randomUUID();
      if(kind==="unmanaged-name")f.target.runtimeProfile="phn-unowned";
      if(kind==="oversized-marker")writeFileSync(marker,"x".repeat(257));
      const adapter=new HermesAdapter({env:{binPath:f.entry,managedProfileNativeTools:true}});
      await assert.rejects(adapter.provisionEmployee(f.target));assert.equal(existsSync(f.receipt),false);
    }finally{f.close();}
  });
}

test("Hermes absent/false opt-in retains generic provisioning behavior",posix,async()=>{
  for(const flag of [undefined,false]){
    const f=fixture();
    try{
      f.target.runtimeProfile="phn-fixture";f.target.workspace=join(f.root,"not-a-managed-workspace");
      await new HermesAdapter({env:{binPath:f.entry,managedProfileNativeTools:flag}}).provisionEmployee(f.target);
      assert.equal(f.invocation().managedProfileNativeTools,false);
    }finally{f.close();}
  }
});
