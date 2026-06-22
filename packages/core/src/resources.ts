import { cpus, freemem, loadavg, totalmem } from "node:os";
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
  const { stdout } = await execFileAsync("df", ["-Pk", path], { timeout: 3000 });
  const lines = stdout.trim().split(/\n/);
  const row = lines[lines.length - 1]?.trim().split(/\s+/);
  if (!row || row.length < 6) return { path };
  const totalBytes = Number(row[1]) * 1024;
  const usedBytes = Number(row[2]) * 1024;
  const freeBytes = Number(row[3]) * 1024;
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
