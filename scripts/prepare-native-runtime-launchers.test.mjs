import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {prepareNativeRuntimeLaunchers} from './prepare-native-runtime-launchers.mjs';

test('native launchers preserve argv and stdin through a pinned Node and global symlinks',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'phonon-native-launcher-'));
  const marker={pid:process.pid,owner:process.env.PHONON_TEST_OWNER??'native-launcher-test'};
  try{
    await writeFile(join(root,'owner.json'),JSON.stringify(marker),{mode:0o600,flag:'wx'});
    const runtime=join(root,"runtime's path"),bin=join(runtime,'bin');
    await mkdir(join(runtime,'node/bin'),{recursive:true});await symlink(process.execPath,join(runtime,'node/bin/node'));
    const entries={openclaw:'node_modules/openclaw/openclaw.mjs',pi:'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'};
    for(const value of Object.values(entries)){const file=join(runtime,value);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,'let input="";for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2),input}));');}
    assert.deepEqual(await prepareNativeRuntimeLaunchers(bin,runtime),['openclaw','pi']);
    for(const name of Object.keys(entries)){
      const global=join(root,name);await symlink(join(bin,name),global);
      const args=['one argument','$(must-not-run)',"quote's value",'--flag=value'];
      const child=execFile(global,args,{env:{PATH:'/usr/bin:/bin'},encoding:'utf8'});
      child.stdin.end('Original authorized input\n');
      const output=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',chunk=>text+=chunk);child.once('error',reject);child.once('close',code=>code===0?resolve(text):reject(new Error('launcher exited '+code)));});
      const result=JSON.parse(output);assert.deepEqual(result.args,args);assert.equal(result.input,'Original authorized input\n');assert.equal(result.node,process.execPath);
    }
    const before=await readFile(join(bin,'openclaw'));
    await assert.rejects(prepareNativeRuntimeLaunchers(bin,runtime),{code:'EEXIST'});
    assert.deepEqual(await readFile(join(bin,'openclaw')),before);
  }finally{assert.deepEqual(JSON.parse(await readFile(join(root,'owner.json'),'utf8')),marker);await rm(root,{recursive:true});}
});

test('native launcher targets reject relative, ambiguous and control-character paths',async()=>{
  for(const target of ['relative','/','/a/../b','/runtime\nnext'])await assert.rejects(prepareNativeRuntimeLaunchers('/unused/launchers',target));
});
