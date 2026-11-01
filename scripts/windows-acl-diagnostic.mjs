import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {WINDOWS_NATIVE_SECURITY_SCRIPT} from '../packages/core/dist/windows-native-file-security.js';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const root = mkdtempSync(join(homedir(), 'phonon-acl-diagnostic-'));
const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const run = (stage, script, env, input = '') => {
  const before = Date.now();
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {env, input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192});
  console.log(JSON.stringify({stage, ms: Date.now() - before, status: result.status, error: result.error?.code,
    stdout: result.stdout?.slice(-1024), stderr: result.stderr?.slice(-1024)}));
};
try {
  const system = {SystemRoot: process.env.SystemRoot ?? 'C:\\Windows'};
  run('startup-minimal', '[Console]::Out.Write("ready")', system);
  run('stdin-minimal', '[Console]::Out.Write([Console]::In.ReadLine())', system, 'framed\n');
  const traced = WINDOWS_NATIVE_SECURITY_SCRIPT
    .replace("$ErrorActionPreference='Stop'", '[Console]::Error.WriteLine("stage:entry");$ErrorActionPreference=\'Stop\'')
    .replace('$line=[Console]::In.ReadLine()', '[Console]::Error.WriteLine("stage:input");$line=[Console]::In.ReadLine();[Console]::Error.WriteLine("stage:parsed")')
    .replace('$parent=[IO.Directory]::GetParent($path)', '[Console]::Error.WriteLine("stage:parents");$parent=[IO.Directory]::GetParent($path)')
    .replace('$attributes=[IO.File]::GetAttributes($path)', '[Console]::Error.WriteLine("stage:target");$attributes=[IO.File]::GetAttributes($path)')
    .replace("if([string]$request.operation -eq 'private-directory')", '[Console]::Error.WriteLine("stage:initialize");if([string]$request.operation -eq \'private-directory\')');
  run('acl-minimal', traced, system, JSON.stringify({path: root, directory: true}) + '\n');
  run('acl-inherited', traced, process.env, JSON.stringify({path: root, directory: true}) + '\n');
} finally {
  rmSync(root, {recursive: true});
}
