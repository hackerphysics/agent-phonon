import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {applyWindowsRuntimeEnvironment,rotatingWindowsLog} from './windows-service-entry.mjs';

test('Windows service preserves identity and disables runtime dependency installs',()=>{
 const env={HOME:'personal',USERPROFILE:'personal',EXISTING:'kept'};
 applyWindowsRuntimeEnvironment({version:1,hermesHome:'D:/Hermes',environment:{PATH:'prepared-node',COPILOT_CACHE_HOME:'prepared-cache'}},env);
 assert.equal(env.HOME,'personal');assert.equal(env.USERPROFILE,'personal');assert.equal(env.EXISTING,'kept');
 assert.equal(env.HERMES_HOME,'D:/Hermes');assert.equal(env.PATH,'prepared-node');
 for(const name of ['HERMES_DISABLE_LAZY_INSTALLS','PYTHONDONTWRITEBYTECODE','PIP_NO_INDEX','UV_OFFLINE'])assert.equal(env[name],'1');
});

test('Windows service validates all environment keys before applying any value',()=>{
 for(const bad of [{HOME:'other'},{NODE_OPTIONS:'--require bad'},{PYTHONPATH:'other'},{PATH:'bad\0path'},{COPILOT_MODEL:3}]){
  const env={HOME:'personal'};
  assert.throws(()=>applyWindowsRuntimeEnvironment({version:1,hermesHome:'D:/Hermes',environment:{COPILOT_MODEL:'valid',...bad}},env));
  assert.deepEqual(env,{HOME:'personal'});
 }
 assert.throws(()=>applyWindowsRuntimeEnvironment({version:2},{}));
});

test('Windows service retains only current and one verified rotating log',async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'phonon-windows-log-')),log=join(root,'daemon.log'),calls=[];
 let stream;
 try{
  const secure=(operation,file,options)=>{calls.push({operation,file,options});if(operation==='create')fs.writeFileSync(file,options.content,{flag:'wx'});};
  stream=rotatingWindowsLog(log,secure);
  fs.writeFileSync(log,Buffer.alloc(5*1024*1024));fs.writeFileSync(log+'.1','previous');
  stream.write('new');stream.end();await once(stream,'finish');
  assert.equal(fs.readFileSync(log,'utf8'),'new');assert.equal(fs.statSync(log+'.1').size,5*1024*1024);
  assert.deepEqual(fs.readdirSync(root).sort(),['daemon.log','daemon.log.1']);
  assert(calls.some(c=>c.operation==='inspect'&&c.file===log+'.1'&&c.options.private===true));
 }finally{stream?.destroy();fs.rmSync(root,{recursive:true});}
});

test('Windows service propagates an unconfirmed log ACL error',async()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'phonon-windows-log-')),log=join(root,'daemon.log');
 try{fs.writeFileSync(log,'');assert.throws(()=>rotatingWindowsLog(log,()=>{throw Error('ACL unavailable');}),/ACL unavailable/);}
 finally{fs.rmSync(root,{recursive:true});}
});
