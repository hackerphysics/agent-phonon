import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {CODEX_NODE_STDIO_IMPORT,CODEX_NODE_STDIO_PRELOAD,codexTerminalInput} from './codex-terminal-guidance.js';

for (const bin of [undefined, 'codex', '/usr/lib/chatgpt/resources/codex']) {
  test(`known Linux launcher receives bounded I/O guidance: ${bin}`, () => {
    const input='User task: run the seven immutable tests.';
    const result=codexTerminalInput(input,bin,'linux');
    assert(result.endsWith('\n\n'+input));
    assert(result.includes('set -o pipefail; <original command> 2>&1 | cat'));
    assert(result.includes('sandbox and approval rules unchanged'));
    assert(result.includes('Do not edit tests, change test isolation or restart already-running work'));
    assert(result.includes('report the output as unverified'));
    assert(result.includes('NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import='+CODEX_NODE_STDIO_IMPORT+'" <original command>'));
    assert(result.includes('Do not persist NODE_OPTIONS'));
  });
}
for (const platform of ['darwin','win32'] as const) {
  test(`${platform} native input is unchanged`, () => {
    assert.equal(codexTerminalInput('original',undefined,platform),'original');
  });
}
test('custom launchers are not assumed to have the packaged CLI limitation', () => {
  assert.equal(codexTerminalInput('original','/custom/codex','linux'),'original');
});

test('fixed output preload imports without changing normal stdout, stderr or exit status',()=>{
  const source=`const before=[process.stdout,process.stderr];await import(${JSON.stringify(CODEX_NODE_STDIO_IMPORT)});if(process.stdout!==before[0]||process.stderr!==before[1])throw Error('Normal streams changed');console.log('original-output');console.error('original-error');process.exitCode=17;`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,17);assert.equal(child.stdout,'original-output\n');assert.equal(child.stderr,'original-error\n');
});
test('fixed preload restores only socket-backed dummy streams and preserves exact bytes',()=>{
  const script=`import fs from 'node:fs';import{Writable}from'node:stream';const before=[process.stdout,process.stderr],stat=fs.fstatSync,create=fs.createWriteStream,seen=[];
fs.fstatSync=fd=>({isSocket:()=>fd===1});fs.createWriteStream=(_path,options)=>{seen.push(options);return before[0]};
const dummy=new Writable({write(_b,_e,cb){cb()}});Object.defineProperty(process,'stdout',{configurable:true,get:()=>dummy});Object.defineProperty(process,'stderr',{configurable:true,get:()=>dummy});
await import(${JSON.stringify(CODEX_NODE_STDIO_IMPORT)});fs.fstatSync=stat;fs.createWriteStream=create;
if(process.stdout!==before[0]||process.stderr!==dummy||seen.length!==1||seen[0].fd!==1||seen[0].autoClose!==false)throw Error('Output-only boundary changed');process.stdout.write(Buffer.from([0,255,65,10]));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:10000});
  assert.equal(child.status,0);assert.deepEqual(child.stdout,Buffer.from([0,255,65,10]));assert.equal(child.stderr.length,0);
  assert(!/test_runner|child_process|NODE_TEST_CONTEXT|process\.exit|chmod|network/.test(CODEX_NODE_STDIO_PRELOAD));
});
