import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {pruneWindowsRuntime} from './windows-runtime-pruning.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Prepare dependencies in CI, never on a deployment host');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
assert.equal(commit, process.env.GITHUB_SHA);
assert.equal(execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}), '');
const root = await fs.realpath(process.argv[2]);
assert(root.startsWith(await fs.realpath(process.env.RUNNER_TEMP) + path.sep));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const versions = {openclaw:'2026.10.9',pi:'0.84.1',opencode:'1.15.10',claudeSdk:'0.2.123',codex:'0.165.0-alpha.1.2',copilot:'1.0.82',node:process.versions.node};
for (const [name, version] of Object.entries({'openclaw':versions.openclaw,'@earendil-works/pi-coding-agent':versions.pi,
  'opencode-ai':versions.opencode,'@opencode-ai/plugin':versions.opencode,'@anthropic-ai/claude-agent-sdk':versions.claudeSdk})) {
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'node_modules',name,'package.json'))).version, version);
}
const lock = await fs.readFile(path.join(root,'package-lock.json'));
const components = Object.entries(JSON.parse(lock).packages).filter(([name]) => name).map(([name,pkg]) =>
  ({path:name,name:pkg.name??name.split('node_modules/').at(-1),version:pkg.version,integrity:pkg.integrity,license:pkg.license}));

async function release(repo,tag,asset,sha,folder) {
  const response = await fetch(`https://github.com/${repo}/releases/download/${tag}/${asset}`,{signal:AbortSignal.timeout(180000)});
  assert(response.ok, 'Official native release download failed');
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(digest(bytes),sha);
  const archive=path.join(root,asset);await fs.writeFile(archive,bytes,{flag:'wx'});
  try{
    const members=execFileSync('tar',['-tf',archive],{encoding:'utf8'}).trim().split(/\r?\n/);
    assert(members.length&&members.every(member=>!/(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))/.test(member)));
    await fs.mkdir(path.join(root,folder));execFileSync('tar',['-xf',archive,'-C',path.join(root,folder)]);
  }finally{await fs.rm(archive);}
}
await release('openai/codex','rust-v0.165.0-alpha.1.2','codex-package-x86_64-pc-windows-msvc.tar.gz',
  '2c94827210d7d100633db08361dd9d8cdcc9c3ed6ee3cd062e21d7ad5206106d','codex');
await release('github/copilot-cli','v1.0.82','copilot-win32-x64.zip',
  'dec18634ab7cc62a8c6829b1a25e6dd84a22e941a9b9f75ef88e3ec2a718b78f','copilot');
await fs.mkdir(path.join(root,'node'));await fs.copyFile(process.execPath,path.join(root,'node/node.exe'));
const nodeRoot=path.dirname(process.execPath);
for(const name of ['LICENSE','README.md']){
  try{await fs.copyFile(path.join(nodeRoot,name),path.join(root,'node',name));}catch(error){if(error.code!=='ENOENT')throw error;}
}
assert((await fs.stat(path.join(root,'node/LICENSE'))).isFile(),'Node runtime notice must be retained');
async function find(folder,name){
  const result=[];
  for(const item of await fs.readdir(folder,{withFileTypes:true})){
    const file=path.join(folder,item.name);
    if(item.isDirectory())result.push(...await find(file,name));else if(item.name===name)result.push(file);
  }
  return result;
}
const codex=await find(path.join(root,'codex'),'codex.exe'),copilot=await find(path.join(root,'copilot'),'copilot.exe');
assert.equal(codex.length,1);assert.equal(copilot.length,1);
const nativeEnv={...process.env,COPILOT_HOME:path.join(root,'synthetic-home'),COPILOT_CACHE_HOME:path.join(root,'copilot-cache')};
execFileSync(copilot[0],['--version'],{env:nativeEnv,timeout:30000,stdio:'pipe'});
await fs.rm(path.join(root,'synthetic-home'),{recursive:true,force:true});

// Keep required package manifests/notices and native payloads, never tests or build tooling.
const removed=await pruneWindowsRuntime(root);
const openclaw=path.join(root,'node_modules/openclaw/openclaw.mjs'),pi=path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
  opencode=path.join(root,'node_modules/opencode-windows-x64/bin/opencode.exe');
for(const [executable,args] of [[codex[0],['--version']],[copilot[0],['--version']],[opencode,['--version']],
  [process.execPath,[pi,'--version']],[process.execPath,[openclaw,'--version']]]) {
  const output=execFileSync(executable,args,{env:nativeEnv,encoding:'utf8',timeout:60000}).trim();assert(output);
}
const sdk=await import(pathToFileURL(path.join(root,'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).href);
assert.equal(typeof sdk.query,'function');assert.equal(typeof sdk.createSdkMcpServer,'function');
await fs.rm(path.join(root,'synthetic-home'),{recursive:true,force:true});
const qualificationEnv={...nativeEnv,PHONON_TEST_CODEX_BIN:codex[0],PHONON_TEST_COPILOT_BIN:copilot[0],
  PHONON_TEST_COPILOT_CACHE_HOME:path.join(root,'copilot-cache'),PHONON_TEST_COPILOT_SDK_ROOT:path.join(root,'copilot-cache/pkg/win32-x64/1.0.82/copilot-sdk'),
  PHONON_TEST_PI_BIN:path.join(root,'node_modules/.bin/pi.cmd'),PHONON_TEST_OPENCODE_BIN:opencode,PHONON_TEST_OPENCODE_DEPS:root,
  PHONON_TEST_OPENCLAW_SDK:path.join(root,'node_modules/openclaw/dist/plugin-sdk'),PHONON_TEST_OPENCLAW_STARTUP_MS:'60000',
  HERMES_DISABLE_LAZY_INSTALLS:'1',PYTHONDONTWRITEBYTECODE:'1'};
const acceptance=[];
for(const harness of ['codex','copilot','pi','opencode','openclaw']){
  execFileSync(process.execPath,['scripts/windows-native-qualification.mjs'],{env:{...qualificationEnv,PHONON_WINDOWS_HARNESS:harness},
    timeout:40*60*1000,stdio:'inherit'});
  const receipt=JSON.parse(await fs.readFile('windows-native-evidence.json'));assert.equal(receipt.success,true);acceptance.push(receipt);
}
await fs.rm(path.join(root,'package-lock.json'));
const files={};
async function inventory(folder){
  for(const item of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=path.join(folder,item.name),relative=path.relative(root,file).replaceAll('\\','/');
    if(item.isDirectory())await inventory(file);
    else{assert(!item.isSymbolicLink());const bytes=await fs.readFile(file);files[relative]={bytes:bytes.length,sha256:digest(bytes)};}
  }
}
await inventory(root);
const manifest={schema:1,kind:'phonon-prepared-native-runtime',sourceCommit:commit,sourceBranch:'main',platform:'win32',arch:'x64',versions,
  entries:{codex:path.relative(root,codex[0]).replaceAll('\\','/'),copilot:path.relative(root,copilot[0]).replaceAll('\\','/'),
    opencode:path.relative(root,opencode).replaceAll('\\','/'),openclaw:path.relative(root,openclaw).replaceAll('\\','/'),pi:path.relative(root,pi).replaceAll('\\','/'),node:'node/node.exe'},files};
const identity=digest(JSON.stringify(manifest));await fs.writeFile(path.join(root,'BUILDINFO.json'),JSON.stringify({...manifest,identity})+'\n',{flag:'wx'});
const archive=path.resolve('windows-native-runtime.tar.gz');
execFileSync('tar',['-czf',archive,'-C',root,...await fs.readdir(root)],{timeout:180000});
const bytes=await fs.readFile(archive);
await fs.writeFile('windows-native-runtime.json',JSON.stringify({sourceCommit:commit,sourceBranch:'main',identity,sha256:digest(bytes),bytes:bytes.length,
  versions,componentLockSHA256:digest(lock),components,removed,acceptance,productionActivated:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceCommit:commit,identity,bytes:bytes.length,files:Object.keys(files).length,productionActivated:false}));
