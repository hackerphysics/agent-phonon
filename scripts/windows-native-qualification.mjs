import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, writeFileSync} from 'node:fs';

const cases = {
  codex: ['PHONON_TEST_CODEX_BIN', 'packages/core/dist/adapters/codex-steering.test.js', '^installed Codex app-server ', 9],
  claude: ['PHONON_TEST_CLAUDE_BIN', 'packages/core/dist/adapters/claude-steering.test.js', '^installed Claude current-turn ', 8],
  copilot: ['PHONON_TEST_COPILOT_BIN', 'packages/test-server/dist/fn-copilot-peer-context.test.js', '^installed Copilot current-turn ', 10],
  pi: ['PHONON_TEST_PI_BIN', 'packages/test-server/dist/fn-pi-installed-input.test.js', '^installed Pi current-turn ', 4],
  hermes: ['PHONON_TEST_HERMES_BIN', 'packages/core/dist/adapters/hermes-peer-context.test.js', '^installed Hermes (middleware|native insert) ', 4],
  opencode: ['PHONON_TEST_OPENCODE_BIN', 'packages/core/dist/adapters/opencode-peer-context.test.js', '^installed OpenCode ', 15],
  openclaw: ['PHONON_TEST_OPENCLAW_SDK', 'packages/test-server/dist/fn-openclaw-peer-context.test.js', '^installed OpenClaw Gateway ', 16],
};

assert.equal(process.platform, 'win32', 'Windows qualification requires an actual Windows runner');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Native installation and suites belong in CI, never a deployment host');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), process.env.GITHUB_SHA);
const harness = process.env.PHONON_WINDOWS_HARNESS;
assert(Object.hasOwn(cases, harness), 'Unknown native harness');
const [required, file, pattern, minimumPasses] = cases[harness];
assert(process.env[required] && existsSync(process.env[required]), 'Prepared native runtime is missing');
const receipt = {sourceCommit: process.env.GITHUB_SHA, harness, platform: process.platform, arch: process.arch,
  node: process.version, runId: process.env.GITHUB_RUN_ID, success: false, productionActivated: false};
try {
  const result = spawnSync(process.execPath, ['scripts/test-local.mjs', 'focused', '--test-reporter=tap', '--test-name-pattern=' + pattern, file],
    {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20 * 60 * 1000});
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Actual native Windows acceptance failed');
  const counts = Object.fromEntries([...result.stdout.matchAll(/^# (pass|fail|cancelled|skipped) (\d+)\r?$/gm)].map(value => [value[1], Number(value[2])]));
  assert(counts.pass >= minimumPasses, 'Missing or skipped installed-native cases are not acceptance');
  assert.equal(counts.fail, 0);
  assert.equal(counts.cancelled, 0);
  Object.assign(receipt, {success: true, counts});
} catch (error) {
  receipt.error = error.message;
  throw error;
} finally {
  writeFileSync('windows-native-evidence.json', JSON.stringify(receipt, null, 2) + '\n');
}
