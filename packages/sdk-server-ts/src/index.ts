/**
 * @agent-phonon/server-sdk
 *
 * 让任何项目一键成为 agent-phonon 服务端：管理多设备、编排其上的 agent。
 */
export { PhononServer, PhononDevice, PhononSession } from "./server.js";
export type { PhononServerOptions, HookDecider, SendResult } from "./server.js";
export { RpcPeer } from "./rpc.js";
export type { Transport } from "./rpc.js";
