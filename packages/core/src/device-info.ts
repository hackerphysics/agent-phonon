import { arch, hostname, platform, release, type } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 相对静态的设备信息，用于服务端做调度决策。
 * 例如：iOS/macOS 开发任务优先派给 darwin 设备，Windows 桌面开发派给 win32 设备。
 */
export async function collectDeviceInfo() {
  const base = {
    at: new Date().toISOString(),
    hostname: hostname(),
    os: {
      platform: platform(),
      type: type(),
      release: release(),
      arch: arch(),
    },
    runtime: {
      node: process.version,
    },
    capabilities: await inferCapabilities(),
  };
  return base;
}

async function inferCapabilities(): Promise<string[]> {
  const caps = new Set<string>();
  const p = platform();
  if (p === "darwin") {
    caps.add("macos");
    caps.add("ios-development");
  }
  if (p === "win32") {
    caps.add("windows");
    caps.add("windows-desktop-development");
  }
  if (p === "linux") caps.add("linux");
  if (await commandExists("git")) caps.add("git");
  if (await commandExists("node")) caps.add("node");
  if (await commandExists("python3")) caps.add("python");
  if (await commandExists("xcodebuild")) caps.add("xcode");
  if (await commandExists("swift")) caps.add("swift");
  if (await commandExists("powershell") || await commandExists("pwsh")) caps.add("powershell");
  if (await commandExists("nvidia-smi")) caps.add("nvidia-gpu");
  return [...caps].sort();
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const which = platform() === "win32" ? "where" : "which";
    await execFileAsync(which, [cmd], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}
