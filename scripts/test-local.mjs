#!/usr/bin/env node
// Thin entrypoint using existing pnpm, node:test and unittest runners; no test framework.
// Environment isolation follows acceptance/takeover-20260914-tests/run.py.
import { mkdtempSync, mkdirSync, rmSync,writeFileSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn,execFile } from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
if (!['default', 'e2e', 'python', 'compat','focused'].includes(mode)) throw new Error('expected default, e2e, python, compat or focused');
const codexBin=process.env.PHONON_TEST_CODEX_BIN;
if(codexBin&&(!isAbsolute(codexBin)||/[\x00-\x1f\x7f]/.test(codexBin)))throw new Error('An explicit absolute native Codex executable is required');
const hermesBin=process.env.PHONON_TEST_HERMES_BIN;
if(hermesBin&&(!isAbsolute(hermesBin)||/[\x00-\x1f\x7f]/.test(hermesBin)))throw new Error('An explicit absolute native Hermes executable is required');
const openCodeBin=process.env.PHONON_TEST_OPENCODE_BIN,openCodeDeps=process.env.PHONON_TEST_OPENCODE_DEPS;
for(const path of [openCodeBin,openCodeDeps])if(path&&(!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path)))throw new Error('Explicit absolute native OpenCode and prepared dependency paths are required');
const openclawSDK=process.env.PHONON_TEST_OPENCLAW_SDK;
if(openclawSDK&&(!isAbsolute(openclawSDK)||/[\x00-\x1f\x7f]/.test(openclawSDK)))throw new Error('An explicit absolute OpenClaw SDK path is required');
const sandbox = mkdtempSync(join(tmpdir(), 'phonon-local-tests-'));
const marker=join(sandbox,'resources.json'),nonce=randomUUID();
let child,interrupted=false,settled=true;
const record=()=>writeFileSync(marker,JSON.stringify({root,pid:process.pid,nonce,mode,childPID:child?.pid??null}),{mode:0o600});
try{
  record();
  for (const dir of ['home', 'tmp', 'cache', 'config', 'data']) mkdirSync(join(sandbox, dir));
}catch(error){rmSync(sandbox,{recursive:true,force:true});throw error;}
const env = {
  PATH: process.env.PATH,
  HOME: join(sandbox, 'home'), USERPROFILE: join(sandbox, 'home'),
  TMPDIR: join(sandbox, 'tmp'), TMP: join(sandbox, 'tmp'), TEMP: join(sandbox, 'tmp'),
  XDG_CACHE_HOME: join(sandbox, 'cache'), XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_DATA_HOME: join(sandbox, 'data'),
  APPDATA: join(sandbox, 'config'), LOCALAPPDATA: join(sandbox, 'data'),
  LANG: 'C.UTF-8', TZ: 'UTC', CI: 'true', NO_COLOR: '1',
  NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
  PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(sandbox, 'no-global-gitconfig'), GIT_TERMINAL_PROMPT: '0',
  LITELLM_LOCAL_MODEL_COST_MAP: 'True',
  pnpm_config_verify_deps_before_run:'false',
  pnpm_config_workspace_concurrency:'1',
  PHONON_TEST_OWNER:process.env.PHONON_TEST_OWNER??'local-'+process.pid,
  ...(codexBin?{PHONON_TEST_CODEX_BIN:codexBin}:{}),
  ...(hermesBin?{PHONON_TEST_HERMES_BIN:hermesBin}:{}),
  ...(openCodeBin?{PHONON_TEST_OPENCODE_BIN:openCodeBin}:{}),
  ...(openCodeDeps?{PHONON_TEST_OPENCODE_DEPS:openCodeDeps}:{}),
  ...(openclawSDK?{PHONON_TEST_OPENCLAW_SDK:openclawSDK}:{}),
};
// Required OS process-launch metadata only, not arbitrary inherited provider/proxy env.
for (const name of ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
const python = process.env.PHONON_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pnpm=process.env.PHONON_TEST_PNPM??'pnpm';
const alive=(pid,group=false)=>{try{process.kill(group?-pid:pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function stopTree(pid){
  if(!pid)return;
  if(process.platform==='win32'){
    if(alive(pid))await promisify(execFile)('taskkill',['/PID',String(pid),'/T','/F']);
    if(alive(pid))throw new Error('Test process termination is unconfirmed');
    return;
  }
  for(const signal of ['SIGTERM','SIGKILL']){
    if(!alive(pid,true))return;
    try{process.kill(-pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}
    const end=Date.now()+3000;
    while(alive(pid,true)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,50));
  }
  if(alive(pid,true))throw new Error('Test process group termination is unconfirmed');
}
const interrupt=()=>{interrupted=true;if(child?.pid)void stopTree(child.pid).catch(()=>{});};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
function verifyNestedFixtures(directory){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory())verifyNestedFixtures(path);
    else if(entry.name==='.peer-fixture.json'){
      const fixture=JSON.parse(readFileSync(path,'utf8'));
      if(fixture.checkout!==root.replace(/[\\/]$/,'')||!Array.isArray(fixture.processes))throw new Error('Nested fixture ownership is unconfirmed');
      if(fixture.processes.some(value=>alive(value.pid,value.group)))throw new Error('A native test process is still active; sandbox retained');
    }
  }
}
async function run(command, args, cwd = root) {
  if(interrupted)throw new Error('Local tests interrupted');
  console.log(`\n[local:${mode}] ${command} ${args.join(' ')}`);
  settled=false;
  child = spawn(command, args, { cwd, env, stdio: 'inherit',detached:process.platform!=='win32',
    // pnpm.cmd requires cmd.exe on Windows; args here are fixed, not user input.
    shell: process.platform === 'win32' && /pnpm(?:\.cmd)?$/.test(command) });
  record();
  let timedOut=false,termination;
  const timer=setTimeout(()=>{timedOut=true;termination=stopTree(child.pid);termination.catch(()=>{});},900_000);
  let code;
  try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',status=>resolve(status??1));});}
  finally{clearTimeout(timer);await termination;await stopTree(child?.pid);settled=true;child=undefined;record();}
  console.log(`[local:${mode}] exit=${code}`);
  if(timedOut||interrupted)throw new Error('Local tests timed out or were interrupted');
  if (code !== 0) throw Object.assign(new Error('local test command failed'), { exitCode: code });
}
let code = 0;
try {
  if(mode==='focused'){
    if(!process.argv[3])throw new Error('Focused tests require explicit node:test arguments');
    await run(process.execPath,['--test','--test-concurrency=1',...process.argv.slice(3)]);
  }else if (mode === 'default') {
    await run(pnpm, ['run', 'consistency']);
    await run(pnpm, ['-r', 'test']);
  } else if (mode === 'e2e') {
    await run(pnpm, ['-r', 'build']);
    await run(pnpm, ['--filter', '@agent-phonon/test-server', 'test:e2e:local']);
    await run(pnpm, ['--filter', 'agent-phonon', 'test:e2e:local']);
  } else if (mode === 'python') {
    // Node clients in the Python scenarios import the current built workspace.
    await run(pnpm, ['--filter', '@agent-phonon/test-server...', '-r', 'build']);
    await run(python, ['-m', 'unittest', '-v', 'test_auth', 'test_session_options', 'test_call_timeout', 'test_conversation_archive'], join(root, 'sdk-python'));
    for (const script of ['test_e2e.py', 'test_workflow_e2e.py', 'test_maintenance_text.py']) {
      await run(python, [script], join(root, 'sdk-python'));
    }
  } else {
    // Optional, independently provisioned requirements.lock environment; never pip install here.
    await run(python, ['-m', 'unittest', '-v', 'test_compat'], join(root, 'scripts/claude-gpt-compat'));
  }
} catch (error) {
  code = error.exitCode ?? 1;
  console.error(error.message);
} finally {
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  try{
    if(!settled)throw new Error('Test termination is unconfirmed; sandbox retained');
    verifyNestedFixtures(sandbox);
    const current=JSON.parse(readFileSync(marker,'utf8'));
    if(current.pid!==process.pid||current.nonce!==nonce||current.root!==root)throw new Error('Test sandbox ownership changed');
    rmSync(sandbox, { recursive: true });
  }catch(error){console.error('Cleanup:',error.message,sandbox);if(code===0)code=1;}
}
process.exitCode = code;
