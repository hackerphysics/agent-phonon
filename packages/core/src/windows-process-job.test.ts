import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsJobEvidence,spawnWindowsProcessJob} from './windows-process-job.js';
const start={version:1,phase:'started',pid:123,active:1,code:0},empty={...start,phase:'empty',active:0,code:17};
const send=(proof:WindowsJobEvidence,value:unknown)=>proof.push(Buffer.from(JSON.stringify(value)+'\n'));
test('job evidence confirms only ordered original PID and zero native accounting',()=>{
 const p=new WindowsJobEvidence();assert(p.alive());const bytes=Buffer.from(JSON.stringify(start)+'\n'+JSON.stringify(empty)+'\n');
 for(const b of bytes)p.push(Buffer.from([b]));assert.equal(p.alive(),false);
});
for(const [label,rows]of Object.entries({missingStart:[empty],foreignPID:[start,{...empty,pid:456}],activeChild:[start,{...empty,active:1}],duplicate:[start,empty,empty],extraField:[start,{...empty,ignored:true}],negativeCode:[start,{...empty,code:-1}],fractionalPID:[{...start,pid:1.5},empty],refused:[{...start,phase:'refused'},empty]})){
 test('job proof stays unconfirmed: '+label,()=>{const p=new WindowsJobEvidence();for(const row of rows)send(p,row);assert(p.alive());});
}
test('truncated, oversized, malformed and channel-error evidence remains unconfirmed',()=>{
 for(const bytes of [Buffer.from('{'),Buffer.alloc(4097,65),Buffer.from('not json\n')]){const p=new WindowsJobEvidence();p.push(bytes);send(p,start);send(p,empty);assert(p.alive());}
 const p=new WindowsJobEvidence();send(p,start);send(p,empty);p.fail();assert(p.alive());
});
test('non-Windows hosts do not spawn a native Windows helper',()=>{
 if(process.platform==='win32')return;
 assert.equal(spawnWindowsProcessJob('node',[],{stdio:['pipe','pipe','pipe']},'/must-not-read'),undefined);
});
