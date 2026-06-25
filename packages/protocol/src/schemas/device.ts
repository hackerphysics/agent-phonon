import { z } from "zod";

export const DeviceFsRoot = z.string().min(1);
export type DeviceFsRoot = z.infer<typeof DeviceFsRoot>;

/**
 * 设备级信息与可观测协议。
 *
 * device.info：相对静态的 OS/机器信息，用于服务端按需调度。
 * device.resources：运行时资源快照，用于 debug，不做资源调度或限制。
 */

export const DeviceInfoParams = z.object({}).default({});
export type DeviceInfoParams = z.infer<typeof DeviceInfoParams>;

export const DeviceInfoResult = z.object({
  at: z.string().datetime({ offset: true }),
  hostname: z.string(),
  os: z.object({
    platform: z.enum(["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]).or(z.string()),
    type: z.string(),
    release: z.string(),
    arch: z.string(),
  }),
  runtime: z.object({
    node: z.string().optional(),
  }).optional(),
  /** 便于 server 做粗粒度任务路由：ios-development/windows-desktop-development/nvidia-gpu 等。 */
  capabilities: z.array(z.string()).default([]),
});
export type DeviceInfoResult = z.infer<typeof DeviceInfoResult>;

export const DeviceResourcesParams = z.object({}).default({});
export type DeviceResourcesParams = z.infer<typeof DeviceResourcesParams>;

export const DeviceResourcesResult = z.object({
  at: z.string().datetime({ offset: true }),
  cpu: z.object({
    loadavg: z.array(z.number()).length(3).optional(),
    cores: z.number().int().positive().optional(),
    usagePercent: z.number().min(0).max(100).optional(),
  }).optional(),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    freeBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    usagePercent: z.number().min(0).max(100).optional(),
  }),
  disk: z.object({
    path: z.string(),
    totalBytes: z.number().nonnegative().optional(),
    freeBytes: z.number().nonnegative().optional(),
    usedBytes: z.number().nonnegative().optional(),
    usagePercent: z.number().min(0).max(100).optional(),
  }).optional(),
  gpu: z.array(z.object({
    name: z.string().optional(),
    memoryTotalBytes: z.number().nonnegative().optional(),
    memoryUsedBytes: z.number().nonnegative().optional(),
    utilizationPercent: z.number().min(0).max(100).optional(),
  })).optional(),
  process: z.object({
    pid: z.number().int().positive(),
    uptimeSeconds: z.number().nonnegative(),
    rssBytes: z.number().nonnegative().optional(),
    heapUsedBytes: z.number().nonnegative().optional(),
    heapTotalBytes: z.number().nonnegative().optional(),
  }).optional(),
});
export type DeviceResourcesResult = z.infer<typeof DeviceResourcesResult>;

export const DeviceFsRootsParams = z.object({}).default({});
export type DeviceFsRootsParams = z.infer<typeof DeviceFsRootsParams>;

export const DeviceFsRootDescriptor = z.object({
  root: DeviceFsRoot,
  path: z.string(),
  label: z.string().optional(),
});
export type DeviceFsRootDescriptor = z.infer<typeof DeviceFsRootDescriptor>;

export const DeviceFsRootsResult = z.object({ roots: z.array(DeviceFsRootDescriptor) });
export type DeviceFsRootsResult = z.infer<typeof DeviceFsRootsResult>;

export const DeviceFsListParams = z.object({
  /** Named root returned by device.fs.roots. Ignored when absolutePath is provided. */
  root: DeviceFsRoot.default("workspaceRoot").optional(),
  /** path relative to root. */
  path: z.string().default(".").optional(),
  /** Absolute path for root-level browsing, e.g. `/` on POSIX or `C:\\` on Windows. */
  absolutePath: z.string().optional(),
  includeHidden: z.boolean().default(false).optional(),
  limit: z.number().int().positive().max(1000).default(200).optional(),
});
export type DeviceFsListParams = z.infer<typeof DeviceFsListParams>;

export const DeviceFsEntry = z.object({
  name: z.string(),
  path: z.string(),
  realPath: z.string(),
  kind: z.enum(["file", "directory", "symlink", "other"]),
  size: z.number().int().nonnegative().optional(),
  mtimeMs: z.number().nonnegative().optional(),
});
export type DeviceFsEntry = z.infer<typeof DeviceFsEntry>;

export const DeviceFsListResult = z.object({
  root: DeviceFsRoot,
  rootPath: z.string(),
  path: z.string(),
  realPath: z.string(),
  entries: z.array(DeviceFsEntry),
  truncated: z.boolean().default(false),
});
export type DeviceFsListResult = z.infer<typeof DeviceFsListResult>;
