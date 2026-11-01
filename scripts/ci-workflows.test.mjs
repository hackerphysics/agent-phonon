import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Reuse the daemon's declared YAML dependency rather than adding another copy.
const require = createRequire(new URL('../packages/daemon/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

for (const name of ['test-python', 'maintenance-cross-platform']) {
  test(`CI ${name}: build the test server's complete workspace dependency graph`, () => {
    const steps = workflow.jobs[name].steps;
    const build = steps.findIndex(step => step.run === 'pnpm --filter @agent-phonon/test-server... -r build');
    assert.ok(build >= 0, 'use recursive dependency selection, including the OpenClaw plugin');
    assert.equal(steps[build].if, undefined, 'build dependencies on every platform');
    const install = steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile');
    assert.ok(install >= 0 && install < build, 'install locked dependencies before building');
    assert.ok(!steps.some(step => step.run === 'pnpm --filter @agent-phonon/test-server build'),
      'do not restore the incomplete hand-maintained build sequence');
    const runTests = steps.findIndex(step => step.run === (name === 'test-python'
      ? 'pnpm test:python'
      : 'node --test packages/test-server/dist/fn-maintenance.test.js packages/test-server/dist/fn-maintenance-rpc.test.js packages/test-server/dist/fn-rescue-adapter.test.js'));
    assert.ok(runTests > build, 'run the existing test suite after its dependencies are built');
  });
}

test('Windows native input qualification is main-only, serialized and requires actual native evidence', () => {
  const native = parse(readFileSync(new URL('../.github/workflows/windows-current-turn.yml', import.meta.url), 'utf8'));
  const job = native.jobs['native-input'];
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job['runs-on'], 'windows-2025');
  assert.equal(job.strategy['max-parallel'], 1);
  assert.equal(native.concurrency['cancel-in-progress'], false);
  assert.deepEqual(native.on.workflow_dispatch.inputs.harness.options,
    ['all', 'codex', 'claude', 'copilot', 'pi', 'hermes', 'opencode', 'openclaw']);
  assert.equal(job.env.HERMES_DISABLE_LAZY_INSTALLS, '1');
  const prepare = job.steps.findIndex(step => step.name === 'Prepare the selected native runtime without personal credentials');
  const qualify = job.steps.findIndex(step => step.run === 'node scripts/windows-native-qualification.mjs');
  assert(prepare >= 0 && qualify > prepare);
  assert.equal(job.steps.at(-1).if, 'always()');
  const runner = readFileSync(new URL('./windows-native-qualification.mjs', import.meta.url), 'utf8');
  assert(runner.includes("process.platform, 'win32'"));
  assert(runner.includes("process.env.GITHUB_ACTIONS, 'true'"));
  assert(runner.includes('counts.pass >= minimumPasses'));
  assert(runner.includes('productionActivated: false'));
});
