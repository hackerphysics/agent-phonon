import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 设备资源监控：debug 用，不做资源调度。 */
export async function collectDeviceResources(path = process.cwd()) {
  const total = totalmem();
  const free = freemem();
  const used = Math.max(0, total - free);
  const mem = process.memoryUsage();
  const disk = await diskUsage(path).catch(() => undefined);
  const gpu = await gpuInfo().catch(() => undefined);
  return {
    at: new Date().toISOString(),
    cpu: { loadavg: loadavg(), cores: cpus().length },
    memory: { totalBytes: total, freeBytes: free, usedBytes: used, usagePercent: total ? (used / total) * 100 : undefined },
    disk,
    gpu,
    process: { pid: process.pid, uptimeSeconds: process.uptime(), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
  };
}

async function diskUsage(path: string) {
  // fs.statfs 是 Node 原生跨平台 API（Windows/macOS/Linux 均可），不再 shell out `df`（POSIX only）。
  const s = await statfs(path);
  const totalBytes = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize; // bavail = 非特权用户可用，贴近实际可写
  const usedBytes = Math.max(0, totalBytes - s.bfree * s.bsize);
  return { path, totalBytes, freeBytes, usedBytes, usagePercent: totalBytes ? (usedBytes / totalBytes) * 100 : undefined };
}

async function gpuInfo() {
  const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: 3000 });
  return stdout.trim().split(/\n/).filter(Boolean).map((line) => {
    const [name, totalMb, usedMb, util] = line.split(",").map((s) => s.trim());
    return {
      name,
      memoryTotalBytes: Number(totalMb) * 1024 * 1024,
      memoryUsedBytes: Number(usedMb) * 1024 * 1024,
      utilizationPercent: Number(util),
    };
  });
}
