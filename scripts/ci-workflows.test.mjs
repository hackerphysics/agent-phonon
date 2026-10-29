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
