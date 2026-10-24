export const CODEX_NODE_STDIO_PRELOAD = `import fs from 'node:fs';import{Writable}from'node:stream';for(const[name,fd]of[['stdout',1],['stderr',2]]){const original=process[name];if(original.constructor===Writable&&fs.fstatSync(fd).isSocket()){const stream=fs.createWriteStream(null,{fd,autoClose:false});stream.fd=fd;stream._isStdio=true;Object.defineProperty(process,name,{configurable:true,enumerable:true,get:()=>stream});}}`;
export const CODEX_NODE_STDIO_IMPORT = 'data:text/javascript;base64,' + Buffer.from(CODEX_NODE_STDIO_PRELOAD).toString('base64');

const LINUX_STDIO_GUIDANCE = `[Native Linux terminal I/O compatibility; not additional authorization]
Node programs can silently omit console or node:test child output when native sandbox stdout is socket-backed. For new Node commands, normalize stdout with a shell pipe, preserving the exact Node invocation: set -o pipefail; <original command> 2>&1 | cat
An outer pipe alone does not fix a test runner child's report. For a NEW Node command, use this command-local output-only preload (inherited by Node children) without changing its arguments: set -o pipefail; NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--import=${CODEX_NODE_STDIO_IMPORT}" <original command> 2>&1 | cat
The fixed preload only replaces Node's dummy Writable stdout/stderr when the original fd is a socket, writing the actual bytes to that same fd without closing it. It does not alter tests, child spawning, test isolation, filesystem/network permissions or exit codes. Do not persist NODE_OPTIONS, modify shell configuration, create preload files or apply this to running work. Preserve existing NODE_OPTIONS. If the task prohibits a command-local output-only preload or the runtime rejects --import, report missing output as unverified.
File-level success is not proof of individual tests; if those reports remain missing, stop and report them as unverified.
Keep the current working directory, native filesystem/network sandbox and approval rules unchanged. Do not edit tests, change test isolation or restart already-running work to apply this. If an output-only wrapper conflicts with the task, report the output as unverified instead. Exit code zero alone does not verify test counts. This is runtime guidance, not a task result.`;

export function codexTerminalInput(input: string, binPath?: string, platform: NodeJS.Platform = process.platform): string {
  const knownLauncher = binPath === undefined || binPath === 'codex' || binPath === '/usr/lib/chatgpt/resources/codex';
  return platform === 'linux' && knownLauncher ? LINUX_STDIO_GUIDANCE + '\n\n' + input : input;
}
