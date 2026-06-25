import { spawn, spawnSync } from "node:child_process";
import type { SpawnOptions, SpawnSyncOptions, SpawnSyncReturns, ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 跨平台安全 spawn（agent adapter 专用）。
 *
 * Windows 上 npm 全局 CLI（claude/codex/openclaw/opencode…）是 `.cmd` shim，
 * Node 22+ 不带 shell 直接 spawn `.cmd` 会抛 EINVAL（CVE-2024-27980 之后收紧）。
 * 所以 Windows 必须 `shell: true`。但 `shell: true` 下 Node 把 command 原样拼进
 * cmd.exe 命令行——如果 command 是含空格的全路径（如
 * `C:\Program Files\nodejs\claude.cmd`）且未加引号，就会在空格处截断：
 *   'C:\Program' is not recognized as an internal or external command
 *
 * 因此 win32 + shell 模式下：
 *  - 给含空格/特殊字符的 command 套双引号；
 *  - 给每个 arg 做最小化引用（含空格或 cmd 元字符时加引号），避免参数被拆。
 *
 * POSIX 直接透传（不 shell、不引用），保持原行为。
 */
export function spawnAgent(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  if (process.platform !== "win32") {
    return spawn(command, args as string[], options) as ChildProcessWithoutNullStreams;
  }
  const cmd = quoteWinArg(command);
  const quotedArgs = args.map(quoteWinArg);
  // shell:true + 已自行引用：把 command 和 args 合成一条命令行交给 cmd.exe。
  return spawn(cmd, quotedArgs, { ...options, shell: true, windowsVerbatimArguments: true }) as ChildProcessWithoutNullStreams;
}

/**
 * Windows cmd.exe 参数引用（最小化）。
 * 仅在含空格或 cmd 元字符（&|<>^()）时加双引号；已带引号的不重复加。
 * 内部双引号转义为 "" （cmd 风格）。
 */
export function quoteWinArg(s: string): string {
  if (s.length === 0) return '""';
  if (!/[\s&|<>^()"%]/.test(s)) return s; // 无需引用
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s; // 已引用
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 同步版跨平台安全 spawn（doctor probe / commandPath 探测用）。
 * 同样在 win32 下 shell:true + 引用 command/args，避免含空格全路径（如
 * `C:\Program Files\nodejs\claude.cmd`）被 cmd.exe 在空格处截断。
 */
export function spawnSyncAgent(command: string, args: readonly string[] = [], options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  if (process.platform !== "win32") {
    return spawnSync(command, args as string[], options);
  }
  const cmd = quoteWinArg(command);
  const quotedArgs = args.map(quoteWinArg);
  return spawnSync(cmd, quotedArgs, { ...options, shell: true, windowsVerbatimArguments: true });
}
