#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
if (process.env.PHONON_LIVE_TESTS !== '1') {
  console.error('Live CLI/Gateway/model tests are NOT local tests. Review production access/cost first; explicitly set PHONON_LIVE_TESTS=1 to opt in.');
  process.exit(2);
}
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
