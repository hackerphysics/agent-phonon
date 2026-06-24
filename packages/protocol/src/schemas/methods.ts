import { z } from "zod";
import {
  ConnectHelloParams,
  ConnectWelcomeResult,
} from "./connect.js";
import {
  DiscoveryListParams,
  DiscoveryListResult,
  DiscoveryGetParams,
  DiscoveryGetResult,
  DiscoveryChangedParams,
} from "./discovery.js";
import {
  SessionCreateParams,
  SessionCreateResult,
  SessionSendParams,
  SessionSendAck,
  SessionInjectParams,
  SessionInjectResult,
  SessionCompressParams,
  SessionCompressResult,
  SessionSwitchModelParams,
  SessionSwitchModelResult,
  SessionInterruptParams,
  SessionInterruptResult,
  SessionTerminateParams,
  SessionTerminateResult,
  SessionStatusParams,
  SessionStatusResult,
  SessionListParams,
  SessionListResult,
} from "./session.js";
import { StreamEvent, StreamAckParams } from "./stream.js";import {
  HookFiredParams,
  HookResolveParams,
  HookResolveResult,
} from "./hook.js";
import { DocumentSendParams, DocumentSendResult, DocumentPrepareUploadParams, DocumentPrepareUploadResult } from "./document.js";
import {
  InteractionRequestParams,
  InteractionRequestResult,
  InteractionResponseParams,
  InteractionCancelParams,
  InteractionCancelResult,
} from "./interaction.js";
import {
  ProjectCreateParams,
  ProjectCreateResult,
  ProjectListParams,
  ProjectListResult,
  ProjectGetParams,
  ProjectGetResult,
  ProjectRemoveParams,
  ProjectRemoveResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListParams,
  WorktreeListResult,
  WorktreeRemoveParams,
  WorktreeRemoveResult,
  GitDeleteBranchParams,
  GitDeleteBranchResult,
  GitCommitParams, GitCommitResult,
  GitMergeParams, GitMergeResult,
  GitDiffParams, GitDiffResult,
  GitLogParams, GitLogResult,
  GitPushParams, GitPushResult,
  GitStatusParams, GitStatusResult,
} from "./project.js";
import {
  SkillInstallParams,
  SkillInstallResult,
  SkillUninstallParams,
  SkillUninstallResult,
  SkillListParams,
  SkillListResult,
  SkillDirsParams,
  SkillDirsResult,
} from "./skill.js";
import { DeviceInfoParams, DeviceInfoResult, DeviceResourcesParams, DeviceResourcesResult } from "./device.js";
import {
  FileReadParams,
  FileReadResult,
  FileWriteParams,
  FileWriteResult,
  FileListParams,
  FileListResult,
  FileStatParams,
  FileStatResult,
  FileMkdirParams,
  FileMkdirResult,
} from "./file.js";
import { EnvSetParams, EnvSetResult, EnvListParams, EnvListResult, EnvDeleteParams, EnvDeleteResult } from "./env.js";
import {
  WorkflowRunParams,
  WorkflowRunResult,
  WorkflowStatusParams,
  WorkflowStatusResult,
  WorkflowCancelParams,
  WorkflowCancelResult,
  WorkflowListParams,
  WorkflowListResult,
  WorkflowEvent,
  WorkflowAckParams,
} from "./workflow.js";

/**
 * 方法注册表（design 全协议的单一事实来源）。
 *
 * 每个方法声明：
 *   - direction: 谁是 requester
 *       s2p = server → phonon （服务端下发操作）
 *       p2s = phonon → server （设备上报结果/事件/发现）
 *   - kind: "request"（需响应）| "notification"（无响应）
 *   - params / result 的 zod schema
 *
 * core 与 client-sdk 都 import 本表，确保两端对齐、可机器校验。
 */

const z_void = z.undefined();

export const METHODS = {
  // --- 握手（phonon 拨出后先发）---
  "connect.hello": {
    direction: "p2s",
    kind: "request",
    params: ConnectHelloParams,
    result: ConnectWelcomeResult,
  },

  // --- 设备级信息与可观测（server 查询）---
  "device.info": {
    direction: "s2p",
    kind: "request",
    params: DeviceInfoParams,
    result: DeviceInfoResult,
  },
  "device.resources": {
    direction: "s2p",
    kind: "request",
    params: DeviceResourcesParams,
    result: DeviceResourcesResult,
  },

  // --- 发现（server 查询；phonon 主动推变更）---
  "discovery.list": {
    direction: "s2p",
    kind: "request",
    params: DiscoveryListParams,
    result: DiscoveryListResult,
  },
  "discovery.get": {
    direction: "s2p",
    kind: "request",
    params: DiscoveryGetParams,
    result: DiscoveryGetResult,
  },
  "discovery.changed": {
    direction: "p2s",
    kind: "notification",
    params: DiscoveryChangedParams,
    result: z_void,
  },

  // --- session 原语（server 下发）---
  "session.create": {
    direction: "s2p",
    kind: "request",
    params: SessionCreateParams,
    result: SessionCreateResult,
  },
  "session.send": {
    direction: "s2p",
    kind: "request",
    params: SessionSendParams,
    result: SessionSendAck,
  },
  "session.inject": {
    direction: "s2p",
    kind: "request",
    params: SessionInjectParams,
    result: SessionInjectResult,
  },
  "session.compress": {
    direction: "s2p",
    kind: "request",
    params: SessionCompressParams,
    result: SessionCompressResult,
  },
  "session.switchModel": {
    direction: "s2p",
    kind: "request",
    params: SessionSwitchModelParams,
    result: SessionSwitchModelResult,
  },
  "session.interrupt": {
    direction: "s2p",
    kind: "request",
    params: SessionInterruptParams,
    result: SessionInterruptResult,
  },
  "session.terminate": {
    direction: "s2p",
    kind: "request",
    params: SessionTerminateParams,
    result: SessionTerminateResult,
  },
  "session.status": {
    direction: "s2p",
    kind: "request",
    params: SessionStatusParams,
    result: SessionStatusResult,
  },
  "session.list": {
    direction: "s2p",
    kind: "request",
    params: SessionListParams,
    result: SessionListResult,
  },

  // --- 流式结果（phonon 上推；无响应）---
  "stream.event": {
    direction: "p2s",
    kind: "notification",
    params: StreamEvent,
    result: z_void,
  },
  // --- 流式 ack（server 确认 seq，phonon 据此清 outbox，P0-4）---
  "stream.ack": {
    direction: "s2p",
    kind: "notification",
    params: StreamAckParams,
    result: z_void,
  },

  // --- hook / HITL ---
  "hook.fired": {
    direction: "p2s",
    kind: "request", // phonon 发起、阻塞等 server 裁决
    params: HookFiredParams,
    result: HookResolveResult,
  },
  "hook.resolve": {
    direction: "s2p",
    kind: "request",
    params: HookResolveParams,
    result: HookResolveResult,
  },

  // --- 文档交换（agent emit 指令 → phonon 读本地文件 → 上传，平面③ / D20）---
  "document.send": {
    direction: "p2s",
    kind: "request",
    params: DocumentSendParams,
    result: DocumentSendResult,
  },
  "document.prepare_upload": {
    direction: "p2s",
    kind: "request", // 大文件凭证上传（P1-6）
    params: DocumentPrepareUploadParams,
    result: DocumentPrepareUploadResult,
  },

  // --- 人机交互（表单/卡片，agent主动或HITL发起，平面③ / D21）---
  "interaction.request": {
    direction: "p2s",
    kind: "request", // blocking 时阻塞等人回填
    params: InteractionRequestParams,
    result: InteractionRequestResult,
  },
  "interaction.response": {
    direction: "s2p",
    kind: "notification", // 异步/非阻塞回填走这条
    params: InteractionResponseParams,
    result: z_void,
  },
  "interaction.cancel": {
    direction: "s2p",
    kind: "request", // 主动取消一个 pending 交互（P1-5）
    params: InteractionCancelParams,
    result: InteractionCancelResult,
  },

  // --- 项目管理（目录 + Git；server 下发，D23）---
  "project.create": {
    direction: "s2p",
    kind: "request",
    params: ProjectCreateParams,
    result: ProjectCreateResult,
  },
  "project.list": {
    direction: "s2p",
    kind: "request",
    params: ProjectListParams,
    result: ProjectListResult,
  },
  "project.get": {
    direction: "s2p",
    kind: "request",
    params: ProjectGetParams,
    result: ProjectGetResult,
  },
  "project.remove": {
    direction: "s2p",
    kind: "request",
    params: ProjectRemoveParams,
    result: ProjectRemoveResult,
  },

  // --- worktree / git 子能力（D25）---
  "project.worktree.create": {
    direction: "s2p",
    kind: "request",
    params: WorktreeCreateParams,
    result: WorktreeCreateResult,
  },
  "project.worktree.list": {
    direction: "s2p",
    kind: "request",
    params: WorktreeListParams,
    result: WorktreeListResult,
  },
  "project.worktree.remove": {
    direction: "s2p",
    kind: "request",
    params: WorktreeRemoveParams,
    result: WorktreeRemoveResult,
  },
  "project.git.deleteBranch": {
    direction: "s2p",
    kind: "request",
    params: GitDeleteBranchParams,
    result: GitDeleteBranchResult,
  },
  "project.git.commit": {
    direction: "s2p", kind: "request",
    params: GitCommitParams, result: GitCommitResult,
  },
  "project.git.merge": {
    direction: "s2p", kind: "request",
    params: GitMergeParams, result: GitMergeResult,
  },
  "project.git.diff": {
    direction: "s2p", kind: "request",
    params: GitDiffParams, result: GitDiffResult,
  },
  "project.git.log": {
    direction: "s2p", kind: "request",
    params: GitLogParams, result: GitLogResult,
  },
  "project.git.push": {
    direction: "s2p", kind: "request",
    params: GitPushParams, result: GitPushResult,
  },
  "project.git.status": {
    direction: "s2p", kind: "request",
    params: GitStatusParams, result: GitStatusResult,
  },

  // --- 受控工作区文件读写（server 下发，project/worktree scoped）---
  "file.read": {
    direction: "s2p",
    kind: "request",
    params: FileReadParams,
    result: FileReadResult,
  },
  "file.write": {
    direction: "s2p",
    kind: "request",
    params: FileWriteParams,
    result: FileWriteResult,
  },
  "file.list": {
    direction: "s2p",
    kind: "request",
    params: FileListParams,
    result: FileListResult,
  },
  "file.stat": {
    direction: "s2p",
    kind: "request",
    params: FileStatParams,
    result: FileStatResult,
  },
  "file.mkdir": {
    direction: "s2p",
    kind: "request",
    params: FileMkdirParams,
    result: FileMkdirResult,
  },

  // --- 环境变量配置（skill/agent 运行环境，默认脱敏）---
  "env.set": {
    direction: "s2p",
    kind: "request",
    params: EnvSetParams,
    result: EnvSetResult,
  },
  "env.list": {
    direction: "s2p",
    kind: "request",
    params: EnvListParams,
    result: EnvListResult,
  },
  "env.delete": {
    direction: "s2p",
    kind: "request",
    params: EnvDeleteParams,
    result: EnvDeleteResult,
  },

  // --- skill 管理（给 agent 装/卸 skill，global|project 两级，D24）---
  "skill.install": {
    direction: "s2p",
    kind: "request",
    params: SkillInstallParams,
    result: SkillInstallResult,
  },
  "skill.uninstall": {
    direction: "s2p",
    kind: "request",
    params: SkillUninstallParams,
    result: SkillUninstallResult,
  },
  "skill.list": {
    direction: "s2p",
    kind: "request",
    params: SkillListParams,
    result: SkillListResult,
  },
  "skill.dirs": {
    direction: "s2p",
    kind: "request",
    params: SkillDirsParams,
    result: SkillDirsResult,
  },

  // --- L3 workflow orchestration (DAG / executor graph) ---
  "workflow.run": {
    direction: "s2p",
    kind: "request",
    params: WorkflowRunParams,
    result: WorkflowRunResult,
  },
  "workflow.status": {
    direction: "s2p",
    kind: "request",
    params: WorkflowStatusParams,
    result: WorkflowStatusResult,
  },
  "workflow.cancel": {
    direction: "s2p",
    kind: "request",
    params: WorkflowCancelParams,
    result: WorkflowCancelResult,
  },
  "workflow.list": {
    direction: "s2p",
    kind: "request",
    params: WorkflowListParams,
    result: WorkflowListResult,
  },
  "workflow.event": {
    direction: "p2s",
    kind: "notification",
    params: WorkflowEvent,
    result: z_void,
  },
  // workflow.ack: server 确认已收到某 workflow 元事件 seq≤N（P0-3、与 stream.ack 平行）
  "workflow.ack": {
    direction: "s2p",
    kind: "notification",
    params: WorkflowAckParams,
    result: z_void,
  },
} as const;

export type MethodName = keyof typeof METHODS;
export type MethodSpec = (typeof METHODS)[MethodName];

/** 取某方法的 params 类型。 */
export type ParamsOf<M extends MethodName> = z.infer<(typeof METHODS)[M]["params"]>;
/** 取某方法的 result 类型。 */
export type ResultOf<M extends MethodName> = z.infer<(typeof METHODS)[M]["result"]>;

/** 运行时校验某方法的 params。 */
export function parseParams<M extends MethodName>(
  method: M,
  data: unknown,
): ParamsOf<M> {
  return METHODS[method].params.parse(data) as ParamsOf<M>;
}

/** 运行时校验某方法的 result。 */
export function parseResult<M extends MethodName>(
  method: M,
  data: unknown,
): ResultOf<M> {
  return METHODS[method].result.parse(data) as ResultOf<M>;
}

/** 全部方法名（运行时数组）。 */
export const METHOD_NAMES = Object.keys(METHODS) as MethodName[];
