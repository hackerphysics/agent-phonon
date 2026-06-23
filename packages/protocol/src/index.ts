/**
 * @agent-phonon/protocol
 *
 * agent-phonon 的线协议——phonon 设备与服务端之间的唯一契约。
 * zod schema + 类型 + 方法注册表的单一事实来源（design docs/design.md）。
 */

export * from "./schemas/common.js";
export * from "./schemas/capabilities.js";
export * from "./schemas/discovery.js";
export * from "./schemas/session.js";
export * from "./schemas/stream.js";
export * from "./schemas/hook.js";
export * from "./schemas/document.js";
export * from "./schemas/interaction.js";
export * from "./schemas/project.js";
export * from "./schemas/skill.js";
export * from "./schemas/policy.js";
export * from "./schemas/connect.js";
export * from "./schemas/device.js";
export * from "./schemas/file.js";
export * from "./schemas/env.js";
export * from "./schemas/workflow.js";
export * from "./schemas/jsonrpc.js";
export * from "./schemas/methods.js";
