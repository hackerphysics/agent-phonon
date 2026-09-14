#!/usr/bin/env node
// Thin entrypoint using existing pnpm, node:test and unittest runners; no test framework.
// Environment isolation follows acceptance/takeover-20260914-tests/run.py.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
if (!['default', 'e2e', 'python', 'compat'].includes(mode)) throw new Error('expected default, e2e, python or compat');
const sandbox = mkdtempSync(join(tmpdir(), 'phonon-local-tests-'));
for (const dir of ['home', 'tmp', 'cache', 'config', 'data']) mkdirSync(join(sandbox, dir));
const env = {
  PATH: process.env.PATH,
  HOME: join(sandbox, 'home'), USERPROFILE: join(sandbox, 'home'),
  TMPDIR: join(sandbox, 'tmp'), TMP: join(sandbox, 'tmp'), TEMP: join(sandbox, 'tmp'),
  XDG_CACHE_HOME: join(sandbox, 'cache'), XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_DATA_HOME: join(sandbox, 'data'),
  APPDATA: join(sandbox, 'config'), LOCALAPPDATA: join(sandbox, 'data'),
  LANG: 'C.UTF-8', TZ: 'UTC', CI: 'true', NO_COLOR: '1',
  PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(sandbox, 'no-global-gitconfig'), GIT_TERMINAL_PROMPT: '0',
  LITELLM_LOCAL_MODEL_COST_MAP: 'True',
};
// Required OS process-launch metadata only, not arbitrary inherited provider/proxy env.
for (const name of ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
const python = process.env.PHONON_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function run(command, args, cwd = root) {
  console.log(`\n[local:${mode}] ${command} ${args.join(' ')}`);
  const child = spawnSync(command, args, { cwd, env, stdio: 'inherit', timeout: 900_000,
    // pnpm.cmd requires cmd.exe on Windows; args here are fixed, not user input.
    shell: process.platform === 'win32' && command === 'pnpm' });
  const code = child.status ?? 1;
  console.log(`[local:${mode}] exit=${code}`);
  if (child.error) console.error(child.error.message);
  if (code !== 0) throw Object.assign(new Error('local test command failed'), { exitCode: code });
}
let code = 0;
try {
  if (mode === 'default') {
    run('pnpm', ['run', 'consistency']);
    run('pnpm', ['-r', 'test']);
  } else if (mode === 'e2e') {
    run('pnpm', ['-r', 'build']);
    run('pnpm', ['--filter', '@agent-phonon/test-server', 'test:e2e:local']);
    run('pnpm', ['--filter', 'agent-phonon', 'test:e2e:local']);
  } else if (mode === 'python') {
    // Node clients in the Python scenarios import the current built workspace.
    run('pnpm', ['--filter', '@agent-phonon/test-server...', '-r', 'build']);
    run(python, ['-m', 'unittest', '-v', 'test_auth'], join(root, 'sdk-python'));
    for (const script of ['test_e2e.py', 'test_workflow_e2e.py', 'test_maintenance_text.py']) {
      run(python, [script], join(root, 'sdk-python'));
    }
  } else {
    // Optional, independently provisioned requirements.lock environment; never pip install here.
    run(python, ['-m', 'unittest', '-v', 'test_compat'], join(root, 'scripts/claude-gpt-compat'));
  }
} catch (error) {
  code = error.exitCode ?? 1;
  console.error(error.message);
} finally {
  // Only this invocation's temporary fixture tree, never the checkout or real HOME.
  rmSync(sandbox, { recursive: true, force: true });
}
process.exitCode = code;
