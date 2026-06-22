#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const fail = [];
const ok = [];
const note = [];

function assert(cond, msg) {
  (cond ? ok : fail).push(msg);
}

function extractMethods() {
  const src = read('packages/protocol/src/schemas/methods.ts');
  const entries = [];
  const re = /\n  "([^"]+)":\s*\{([\s\S]*?)\n  \},/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, block] = m;
    const direction = block.match(/direction:\s*"([^"]+)"/)?.[1];
    const kind = block.match(/kind:\s*"([^"]+)"/)?.[1];
    if (direction && kind) entries.push({ name, direction, kind });
  }
  return entries;
}

function unique(arr) { return [...new Set(arr)].sort(); }
function missing(expected, actual) { const a = new Set(actual); return expected.filter((x) => !a.has(x)); }
function stringsIn(file) {
  const src = read(file);
  return unique([...src.matchAll(/"([a-z]+\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]));
}

const methods = extractMethods();
const methodNames = unique(methods.map((m) => m.name));
const s2p = unique(methods.filter((m) => m.direction === 's2p').map((m) => m.name));
const p2s = unique(methods.filter((m) => m.direction === 'p2s').map((m) => m.name));

assert(methods.length > 20, `protocol METHODS parsed (${methods.length})`);

// 1) Protocol ↔ daemon/core implementation consistency.
const daemonCases = unique([...read('packages/core/src/index.ts').matchAll(/case\s+"([a-z]+\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]));
const daemonMissing = missing(s2p, daemonCases);
assert(daemonMissing.length === 0, `core dispatch implements every server→phonon method (${daemonMissing.length ? `missing: ${daemonMissing.join(', ')}` : 'ok'})`);

// 2) Protocol ↔ SDK surface consistency.
// These are user-facing server SDK methods that should have first-class wrappers in every SDK.
// Protocol plumbing methods remain covered internally by the SDK transport/HITL handlers.
const sdkPublic = s2p.filter((m) => ![
  'hook.resolve',
  'interaction.cancel',
  'interaction.response',
  'stream.ack',
].includes(m));
const tsSdkStrings = stringsIn('packages/sdk-server-ts/src/server.ts');
const pySdkStrings = stringsIn('sdk-python/agent_phonon/server.py');
const tsMissing = missing(sdkPublic, tsSdkStrings);
const pyMissing = missing(sdkPublic, pySdkStrings);
assert(tsMissing.length === 0, `TypeScript server SDK exposes every public s2p method (${tsMissing.length ? `missing: ${tsMissing.join(', ')}` : 'ok'})`);
assert(pyMissing.length === 0, `Python server SDK exposes every public s2p method (${pyMissing.length ? `missing: ${pyMissing.join(', ')}` : 'ok'})`);

// 3) SDK parity: TS and Python wrappers reference the same public protocol methods.
const extraTs = tsSdkStrings.filter((m) => sdkPublic.includes(m) && !pySdkStrings.includes(m));
const extraPy = pySdkStrings.filter((m) => sdkPublic.includes(m) && !tsSdkStrings.includes(m));
assert(extraTs.length === 0 && extraPy.length === 0, `TypeScript/Python SDK public method parity (${extraTs.length || extraPy.length ? `ts-only: ${extraTs.join(', ') || '-'}; py-only: ${extraPy.join(', ') || '-'}` : 'ok'})`);

// 4) p2s methods are protocol events/requests from device to server; SDK must mention/handle them.
const tsP2sMissing = missing(p2s, stringsIn('packages/sdk-server-ts/src/server.ts'));
const pyP2sMissing = missing(p2s, stringsIn('sdk-python/agent_phonon/server.py'));
assert(tsP2sMissing.length === 0, `TypeScript server SDK handles every phonon→server method (${tsP2sMissing.length ? `missing: ${tsP2sMissing.join(', ')}` : 'ok'})`);
assert(pyP2sMissing.length === 0, `Python server SDK handles every phonon→server method (${pyP2sMissing.length ? `missing: ${pyP2sMissing.join(', ')}` : 'ok'})`);

// 5) Package version coherence.
const pkg = (p) => JSON.parse(read(p));
const npmVersions = [
  ['@agent-phonon/protocol', pkg('packages/protocol/package.json').version],
  ['agent-phonon', pkg('packages/daemon/package.json').version],
  ['@agent-phonon/server-sdk', pkg('packages/sdk-server-ts/package.json').version],
];
const npmVersionSet = new Set(npmVersions.map(([, v]) => v));
assert(npmVersionSet.size === 1, `npm package versions are aligned (${npmVersions.map(([n, v]) => `${n}@${v}`).join(', ')})`);

const pyproject = read('sdk-python/pyproject.toml');
const pyPkgName = pyproject.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
const pyVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pyInitVersion = read('sdk-python/agent_phonon/__init__.py').match(/__version__\s*=\s*"([^"]+)"/)?.[1];
assert(pyPkgName === 'agent-phonon-sdk', `PyPI distribution name is agent-phonon-sdk (${pyPkgName ?? 'missing'})`);
assert(pyVersion === pyInitVersion, `Python package metadata version matches __version__ (${pyVersion ?? 'missing'} vs ${pyInitVersion ?? 'missing'})`);

// 6) Release workflow guards.
const npmWorkflow = read('.github/workflows/publish-npm.yml');
assert(npmWorkflow.includes('pnpm -r test'), 'npm publish workflow runs full test suite before publish');
assert(npmWorkflow.includes('pnpm pack') && npmWorkflow.includes('npm publish "$tgz"'), 'npm publish workflow publishes pnpm-packed tarballs (workspace deps rewritten)');
const pypiWorkflow = read('.github/workflows/publish-pypi.yml');
assert(pypiWorkflow.includes('agent-phonon-sdk'), 'PyPI workflow targets agent-phonon-sdk');

// 7) Checklist docs must exist so agents see the hard rule.
assert(fs.existsSync(path.join(root, 'AGENTS.md')), 'repo AGENTS.md exists for coding agents');
assert(fs.existsSync(path.join(root, 'docs/COMMIT_RELEASE_CHECKLIST.md')), 'commit/release checklist doc exists');

console.log('agent-phonon consistency check');
for (const msg of ok) console.log(`  ✓ ${msg}`);
for (const msg of note) console.log(`  • ${msg}`);
if (fail.length) {
  console.error('\nConsistency check failed:');
  for (const msg of fail) console.error(`  ✗ ${msg}`);
  process.exit(1);
}
console.log('\nAll consistency checks passed.');
