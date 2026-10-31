import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../.githooks/pre-push', import.meta.url));

function runHook(refs, fail = '', gitEnvironment = {}) {
  const root = mkdtempSync(join(tmpdir(), 'phonon-hook-test-'));
  const bin = join(root, 'bin'), calls = join(root, 'calls');
  mkdirSync(bin);
  try {
    for (const command of ['pnpm', 'node']) {
      writeFileSync(join(bin, command), `#!/bin/sh
set -eu
call="${command} $*"
printf '%s\\n' "$call" >> "$PHONON_HOOK_CALLS"
if [ -n "\${GIT_DIR:-}\${GIT_WORK_TREE:-}\${GIT_INDEX_FILE:-}\${GIT_COMMON_DIR:-}\${GIT_CONFIG_PARAMETERS:-}" ]; then exit 23; fi
if [ "$call" = "\${PHONON_HOOK_FAIL:-}" ]; then exit 9; fi
`, { mode: 0o755 });
    }
    const sha = '1'.repeat(40);
    // /bin/bash intentionally exercises macOS's bundled Bash 3.2, even when
    // a newer Homebrew Bash is installed in PATH.
    const result = spawnSync(process.platform === 'win32' ? 'bash' : '/bin/bash', ['--noprofile', '--norc', hook], {
      input: refs.map(ref => `${ref} ${sha} ${ref} ${sha}\n`).join(''),
      encoding: 'utf8', timeout: 5000,
      env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HOME: root,
        PHONON_HOOK_CALLS: calls, PHONON_HOOK_FAIL: fail, ...gitEnvironment },
    });
    assert.ifError(result.error);
    return { status: result.status, stderr: result.stderr,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('pre-push: ordinary branches do not invoke main/release gates', () => {
  const result = runHook(['refs/heads/codex/fixture']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test('pre-push: main with no release tags works under nounset', () => {
  const result = runHook(['refs/heads/main']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['pnpm run consistency']);
});

test('pre-push: npm and Python tags retain guards and full build/test gates', () => {
  const result = runHook(['refs/heads/main', 'refs/tags/v0.9.1', 'refs/tags/py-v0.9.1']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['pnpm run consistency', 'node scripts/release-guard.mjs v0.9.1',
    'node scripts/release-guard.mjs py-v0.9.1', 'pnpm -r build', 'pnpm -r test']);
});

test('pre-push: a failed consistency gate stops the push before release work', () => {
  const result = runHook(['refs/tags/v0.9.1'], 'pnpm run consistency');
  assert.equal(result.status, 9);
  assert.deepEqual(result.calls, ['pnpm run consistency']);
});

test('pre-push: Git-local push identity cannot reach build or fixture repositories', () => {
  const result = runHook(['refs/tags/v0.10.0'], '', {
    GIT_DIR: '/nonexistent/parent.git', GIT_WORK_TREE: '/nonexistent/parent',
    GIT_INDEX_FILE: '/nonexistent/parent.index', GIT_COMMON_DIR: '/nonexistent/common.git',
    GIT_CONFIG_PARAMETERS: "'core.bare=true'",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['pnpm run consistency', 'node scripts/release-guard.mjs v0.10.0', 'pnpm -r build', 'pnpm -r test']);
});
