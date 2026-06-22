#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

chmodSync('.githooks/pre-push', 0o755);
execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
console.log('agent-phonon git hooks installed: core.hooksPath=.githooks');
