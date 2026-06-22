import { z } from "zod";
import { PhononErrorData } from "./common.js";

/**
 * JSON-RPC 2.0 信封（design D2）。
 *
 * 单条 WebSocket 上双向跑 JSON-RPC 2.0：两端皆可作 requester。
 * - server → phonon：session.* / discovery.* / hook.resolve
 * - phonon → server：stream.event / hook.fired / discovery.changed / connect.hello
 *
 * 这里只定义「信封」的通用形状；具体方法的 params/result 由 methods.ts 绑定。
 */

export const JsonRpcVersion = z.literal("2.0");

/** 请求 id：字符串或数字（JSON-RPC 允许两者；notification 无 id）。 */
export const JsonRpcId = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

/** 请求（需要响应）。 */
export const JsonRpcRequest = z.object({
  jsonrpc: JsonRpcVersion,
  id: JsonRpcId,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

/** 通知（不需要响应，无 id）——用于 stream.event / hook.fired / discovery.changed。 */
export const JsonRpcNotification = z.object({
  jsonrpc: JsonRpcVersion,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

/** 成功响应。 */
export const JsonRpcSuccess = z.object({
  jsonrpc: JsonRpcVersion,
  id: JsonRpcId,
  result: z.unknown(),
});
export type JsonRpcSuccess = z.infer<typeof JsonRpcSuccess>;

/** JSON-RPC error 对象；data 携带 phonon 应用级错误结构。 */
export const JsonRpcErrorObject = z.object({
  /** JSON-RPC 传输级 code（-32700..-32600 保留；应用错误用 data.appCode 判别）。 */
  code: z.number().int(),
  message: z.string(),
  data: PhononErrorData.optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObject>;

/** 失败响应。 */
export const JsonRpcError = z.object({
  jsonrpc: JsonRpcVersion,
  id: JsonRpcId.nullable(),
  error: JsonRpcErrorObject,
});
export type JsonRpcError = z.infer<typeof JsonRpcError>;

/** 任意一条 JSON-RPC 报文。 */
export const JsonRpcMessage = z.union([
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccess,
  JsonRpcError,
]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessage>;

/** 标准 JSON-RPC 传输级错误码。 */
export const JSON_RPC_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** 应用级错误统一用这个 code，细分看 data.appCode。 */
  applicationError: -32000,
} as const;
