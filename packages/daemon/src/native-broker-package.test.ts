import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,existsSync,rmSync,cpSync,appendFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const source=process.env.PHONON_FS_BROKER_ARTIFACT_ROOT,script=fileURLToPath(new URL("../scripts/copy-native-fs-broker.mjs",import.meta.url));
test("runtime native asset packaging selects actual OS/architecture and refuses stale or modified executables",{skip:!source?"Prepared native artifacts required":false},()=>{
  const root=mkdtempSync(join(tmpdir(),"phonon-native-package-"));
  try{
    const linux=join(root,"linux-native");execFileSync(process.execPath,[script,source!,linux,"linux-x64"]);
    const manifest=JSON.parse(readFileSync(join(linux,"manifest.json"),"utf8"));assert.deepEqual(Object.keys(manifest.targets),["linux-x64"]);
    assert.equal(existsSync(join(linux,"darwin-arm64")),false);assert.equal(existsSync(join(linux,"win32-x64")),false);assert.equal(existsSync(join(linux,"THIRD_PARTY_NOTICES.txt")),true);
    const changed=join(root,"changed");cpSync(source!,changed,{recursive:true});appendFileSync(join(changed,"linux-x64/phonon-fs-broker"),"tampered");
    const rejected=join(root,"must-not-exist"),result=spawnSync(process.execPath,[script,changed,rejected,"linux-x64"]);
    assert.notEqual(result.status,0);assert.equal(existsSync(rejected),false);
    assert.throws(()=>execFileSync(process.execPath,[script,source!,linux,"linux-x64"],{stdio:"pipe"}));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(linux,"manifest.json"),"utf8")).targets),["linux-x64"]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
