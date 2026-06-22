#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const cliArgs = process.argv.slice(2).filter((a) => a !== '--');
const tag = cliArgs[0] || process.env.GITHUB_REF_NAME || '';

function die(msg) {
  console.error(`release-guard: ${msg}`);
  process.exit(1);
}
function ok(msg) { console.log(`release-guard: ${msg}`); }

const npmPackages = [
  ['@agent-phonon/protocol', 'packages/protocol/package.json'],
  ['agent-phonon', 'packages/daemon/package.json'],
  ['@agent-phonon/server-sdk', 'packages/sdk-server-ts/package.json'],
];
const npmVersions = npmPackages.map(([name, file]) => [name, readJson(file).version]);
const pyproject = read('sdk-python/pyproject.toml');
const pyName = pyproject.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
const pyVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pyInitVersion = read('sdk-python/agent_phonon/__init__.py').match(/__version__\s*=\s*"([^"]+)"/)?.[1];

if (pyName !== 'agent-phonon-sdk') die(`PyPI package name must be agent-phonon-sdk, got ${pyName || '<missing>'}`);
if (!pyVersion || pyVersion !== pyInitVersion) die(`Python version mismatch: pyproject=${pyVersion || '<missing>'}, __version__=${pyInitVersion || '<missing>'}`);

const npmSet = new Set(npmVersions.map(([, v]) => v));
if (npmSet.size !== 1) die(`npm package versions differ: ${npmVersions.map(([n, v]) => `${n}@${v}`).join(', ')}`);

if (!tag) {
  ok(`no tag supplied; npm=${[...npmSet][0]}, python=${pyVersion}`);
  process.exit(0);
}

if (tag.startsWith('v')) {
  const want = tag.slice(1);
  for (const [name, version] of npmVersions) {
    if (version !== want) die(`${tag} requires ${name}@${want}, got ${version}`);
  }
  ok(`${tag} matches npm package versions (${want})`);
} else if (tag.startsWith('py-v')) {
  const want = tag.slice(4);
  if (pyVersion !== want || pyInitVersion !== want) die(`${tag} requires Python version ${want}, got pyproject=${pyVersion}, __version__=${pyInitVersion}`);
  ok(`${tag} matches Python package version (${want})`);
} else {
  ok(`tag ${tag} is not a release tag; only generic consistency checked`);
}
