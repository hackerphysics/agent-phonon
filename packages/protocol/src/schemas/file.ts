import { z } from "zod";
import { ProjectId } from "./common.js";

/**
 * 受控工作区文件读写协议。
 *
 * 与 document.send 不同：document.send 是 agent 主动把产物发给 server；
 * file.* 是 server 主动读写本地 project/worktree 内文件。
 */

export const FileEncoding = z.enum(["utf8", "base64"]);
export type FileEncoding = z.infer<typeof FileEncoding>;

export const FileScope = z.object({
  projectId: ProjectId,
  /** 可选：指定 worktree；缺省为项目主目录。 */
  worktreeId: z.string().min(1).optional(),
});
export type FileScope = z.infer<typeof FileScope>;

const RelativePath = z.string().min(1).refine((p) => !p.startsWith("/") && !p.includes("\0"), {
  message: "path must be a relative path",
});

export const FileStat = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.string().datetime({ offset: true }).optional(),
});
export type FileStat = z.infer<typeof FileStat>;

export const FileReadParams = FileScope.extend({
  path: RelativePath,
  encoding: FileEncoding.default("utf8"),
  /** 可选：最大读取字节数，避免误读超大文件。 */
  maxBytes: z.number().int().positive().optional(),
});
export type FileReadParams = z.infer<typeof FileReadParams>;

export const FileReadResult = z.object({
  path: z.string(),
  encoding: FileEncoding,
  data: z.string(),
  sizeBytes: z.number().nonnegative(),
  truncated: z.boolean().default(false),
});
export type FileReadResult = z.infer<typeof FileReadResult>;

export const FileWriteParams = FileScope.extend({
  /** 可选：幂等键。 */
  clientRequestId: z.string().optional(),
  path: RelativePath,
  encoding: FileEncoding.default("utf8"),
  data: z.string(),
  /** 缺省 true；false 时若文件已存在则报错。 */
  overwrite: z.boolean().default(true),
  /** 是否自动创建父目录。 */
  createDirs: z.boolean().default(true),
});
export type FileWriteParams = z.infer<typeof FileWriteParams>;

export const FileWriteResult = z.object({
  path: z.string(),
  sizeBytes: z.number().nonnegative(),
  written: z.literal(true),
});
export type FileWriteResult = z.infer<typeof FileWriteResult>;

export const FileListParams = FileScope.extend({
  path: RelativePath.default("."),
  recursive: z.boolean().default(false),
  limit: z.number().int().positive().max(10000).default(500),
});
export type FileListParams = z.infer<typeof FileListParams>;

export const FileListResult = z.object({
  path: z.string(),
  entries: z.array(FileStat),
  truncated: z.boolean().default(false),
});
export type FileListResult = z.infer<typeof FileListResult>;

export const FileStatParams = FileScope.extend({ path: RelativePath });
export type FileStatParams = z.infer<typeof FileStatParams>;
export const FileStatResult = z.object({ stat: FileStat });
export type FileStatResult = z.infer<typeof FileStatResult>;

export const FileMkdirParams = FileScope.extend({
  /** 可选：幂等键。 */
  clientRequestId: z.string().optional(),
  path: RelativePath,
  recursive: z.boolean().default(true),
});
export type FileMkdirParams = z.infer<typeof FileMkdirParams>;
export const FileMkdirResult = z.object({ path: z.string(), created: z.literal(true) });
export type FileMkdirResult = z.infer<typeof FileMkdirResult>;
