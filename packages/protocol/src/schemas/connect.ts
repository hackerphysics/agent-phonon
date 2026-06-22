import { z } from "zod";
import { DeviceId, TenantId, Timestamp } from "./common.js";

/**
 * 连接握手（design §6）。
 *
 * phonon 拨出连接后，首先发 connect.hello 表明：协议版本、设备身份。
 * device key 的鉴权由传输层/服务端处理（如 WS header / 首帧），不在业务 params 里明文带。
 * server 回 connect.welcome 确认，并可下发 tenant 绑定与服务端能力。
 */

export const ConnectHelloParams = z.object({
  /** 本端协议版本（= PROTOCOL_VERSION）。 */
  protocolVersion: z.string(),
  /** 设备标识（服务端用于区分多设备）。 */
  deviceId: DeviceId,
  /** phonon 实现版本（软件版本，便于服务端兼容处理）。 */
  phononVersion: z.string().optional(),
  /** 本端声明支持的可选特性开关，便于前向兼容。 */
  features: z.array(z.string()).default([]),
  /** 设备鉴权（可选）：server 据此验证设备身份。也可走传输层 header。 */
  auth: z.object({ deviceKey: z.string() }).optional(),
  /**
   * 重连时携带（P0-4）：phonon 本地 outbox 中每个 session 尚未被 ack 的起始 seq，
   * 让 server 知道哪些要补发 / 从哪重放。首次连接可省略。
   */
  resumeFrom: z
    .array(z.object({ sessionId: z.string(), fromSeq: z.number().int().nonnegative() }))
    .optional(),
  at: Timestamp,
});
export type ConnectHelloParams = z.infer<typeof ConnectHelloParams>;

export const ConnectWelcomeResult = z.object({
  /** 服务端协议版本。 */
  protocolVersion: z.string(),
  /** 服务端为本连接分配/确认的租户身份（= 一条服务端连接，design D13）。 */
  tenantId: TenantId,
  /** 服务端声明支持的可选特性。 */
  features: z.array(z.string()).default([]),
  /**
   * 重连时服务端告知「我各 session 最后收到的 seq」（P0-4），
   * phonon 据此从 outbox 精确补发（> lastSeq 的），避免重复/遗漏。
   */
  ackedSeqs: z
    .array(z.object({ sessionId: z.string(), lastSeq: z.number().int().nonnegative() }))
    .optional(),
  at: Timestamp,
});
export type ConnectWelcomeResult = z.infer<typeof ConnectWelcomeResult>;
