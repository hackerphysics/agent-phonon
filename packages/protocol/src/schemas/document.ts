import { z } from "zod";
import { SessionId, Timestamp } from "./common.js";

/**
 * 文档交换协议（design 平面③ / D20）。
 *
 * 场景：agent 需要/被要求发送本地文档时，在输出里 emit 一个**指令**（skill 教的格式，
 * 见 DocumentDirective），phonon 解析后**负责读取本地文件**，打包成附件/其他形式发到服务端。
 * 也就是说：agent 只说「路径」，读盘 + 传输由 phonon 这一层兜。
 *
 * 两个层次要分清：
 *   - DocumentDirective ：agent ↔ phonon 的指令（含本地 path，skill 教）
 *   - document.send     ：phonon ↔ server 的线协议（含真实内容/附件）
 */

/** 文档用途/形式。 */
export const DocumentKind = z.enum([
  "attachment", // 通用附件
  "document", // 富文本文档（如 .md → 服务端可转云文档）
  "image", // 图片
  "file", // 其他普通文件
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

/** 内容承载方式：小文件内联，大文件用 ref 走分块传输（具体待定）。 */
export const DocumentContent = z.union([
  z.object({ encoding: z.literal("base64"), data: z.string() }),
  z.object({ encoding: z.literal("utf8"), data: z.string() }),
  z.object({ ref: z.string() }), // 分块传输句柄（大文件，开放问题）
]);
export type DocumentContent = z.infer<typeof DocumentContent>;

/**
 * agent 在输出里 emit 的指令格式（skill 教）——只含本地路径与元信息，
 * phonon 据此读本地文件。**不直接进线协议。**
 *
 * 安全（D27 policy）：默认 **project-scoped**——路径必须在绑定项目/worktree 目录内，
 * 越界需 tenant policy 显式 `allowExternalDocuments`；命中 denyPathPatterns 一律拒。
 */
export const DocumentDirective = z.object({
  /** 文件路径（默认相对于项目/worktree 根；绝对路径需 policy 允许且在范围内）。 */
  path: z.string().min(1),
  /** 可选：覆盖文件名（默认取 path 的 basename）。 */
  name: z.string().optional(),
  kind: DocumentKind.optional(),
  caption: z.string().optional(),
});
export type DocumentDirective = z.infer<typeof DocumentDirective>;

/** 单个文档的线上描述（phonon 读完本地文件后封装）。 */
export const DocumentDescriptor = z.object({
  name: z.string().min(1),
  /** 相对项目根的路径（审计/去重用；不暴露设备绝对路径）。 */
  relativePath: z.string().optional(),
  mimeType: z.string().optional(),
  kind: DocumentKind.default("file"),
  caption: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** 内容 sha256（完整性校验 / 去重）。 */
  sha256: z.string().optional(),
  content: DocumentContent,
});
export type DocumentDescriptor = z.infer<typeof DocumentDescriptor>;

// --- document.send（phonon → server）---
export const DocumentSendParams = z.object({
  /** 关联会话（通常有；纯设备级发送可省）。 */
  sessionId: SessionId.optional(),
  /** 关联轮次（若在某轮对话内触发）。 */
  turnId: z.string().optional(),
  documents: z.array(DocumentDescriptor).min(1),
  at: Timestamp,
});
export type DocumentSendParams = z.infer<typeof DocumentSendParams>;

export const DocumentSendResult = z.object({
  delivered: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      /** 服务端落地引用（如云文档 token / 附件 id）。 */
      serverRef: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
export type DocumentSendResult = z.infer<typeof DocumentSendResult>;

// ===========================================================================
// 大文件：凭证上传（P1-6 / Gemini#2）
// 不走 WS 发文件主体（避免内存暴涨/断线重传痛），而是：
//   phonon → document.prepare_upload {filename,size,mime,sha256}
//   server → 返回一个 HTTP 上传地址（预签名 URL / 一次性 token）
//   phonon 本地跑标准 HTTP POST（multipart/流式/断点续传）
//   上传成功后用 document.send 用 ref 关联回 session
// ===========================================================================
export const DocumentPrepareUploadParams = z.object({
  sessionId: SessionId.optional(),
  turnId: z.string().optional(),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
  sha256: z.string().optional(),
  kind: DocumentKind.default("file"),
  at: Timestamp,
});
export type DocumentPrepareUploadParams = z.infer<typeof DocumentPrepareUploadParams>;

export const DocumentPrepareUploadResult = z.object({
  /** 上传句柄，上传成功后回填到 DocumentContent.ref。 */
  uploadRef: z.string(),
  /** server 给的 HTTP 上传地址（预签名 URL 等）。 */
  uploadUrl: z.string(),
  /** HTTP 方法（默认 PUT）。 */
  method: z.enum(["PUT", "POST"]).default("PUT"),
  /** 需携带的额外请求头。 */
  headers: z.record(z.string()).optional(),
  /** 上传地址过期时间。 */
  expiresAt: Timestamp.optional(),
});
export type DocumentPrepareUploadResult = z.infer<typeof DocumentPrepareUploadResult>;
