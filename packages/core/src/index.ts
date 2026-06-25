import { readdir, lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join, relative, resolve, parse } from "node:path";
import { SessionEngine, AdapterRegistry } from "./session-engine.js";
import { RpcPeer, PhononError, type RpcTransport } from "./rpc.js";
import { ProjectManager, runGit } from "./project-manager.js";
import { SkillManager } from "./skill-manager.js";
import { PolicyEnforcer } from "./policy.js";
import { IdempotencyStore } from "./idempotency.js";
import { Outbox } from "./outbox.js";
import { PhononStore } from "./store.js";
import { FileManager } from "./file-manager.js";
import { collectDeviceResources } from "./resources.js";
import { collectDeviceInfo } from "./device-info.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { EnvManager } from "./env-manager.js";
import type { AgentAdapter } from "./adapter.js";
import { PROTOCOL_VERSION, parseParams, METHODS, type StreamEvent, type TenantPolicy, type MethodName, type WorkflowPlan } from "@agent-phonon/protocol";

/** 改状态的方法（幂等适用）。 */
const MUTATING_METHODS = new Set<string>([
  "session.create",
  "session.send",
  "project.create",
  "project.remove",
  "project.worktree.create",
  "project.worktree.remove",
  "project.git.deleteBranch",
  "project.git.commit",
  "project.git.merge",
  "project.git.push",
  "skill.install",
  "skill.uninstall",
  "file.write",
  "file.mkdir",
  "env.set",
  "env.delete",
  "workflow.run",
  "workflow.cancel",
]);

/**
 * 设备侧 daemon 的「一条连接处理器」（L2 dispatch，design §6）。
 *
 * 一个 PhononConnection = 一条到某 server 的连接 = 一个 tenant。
 * 它把 server 下发的 session.* 路由到 SessionEngine，并在交给 L1 前做 tenant 校验；
 * 同时把 engine 产出的 stream.event 推回 server。
 *
 * 真实场景：phonon 主动拨出连真 server。
 * 测试场景：test-server 主动连进来，或 phonon 连 test-server——传输无关，靠 RpcTransport 抽象。
 */
export class PhononConnection {
  readonly tenantId: string;
  private engine: SessionEngine;
  private peer: RpcPeer;
  private registry: AdapterRegistry;
  private projects: ProjectManager;
  private skills: SkillManager;
  private policy: PolicyEnforcer;
  private idempotency: IdempotencyStore;
  private outbox: Outbox;
  private store: PhononStore;
  private files: FileManager;
  private env: EnvManager;
  private obs?: import("./observability.js").ObsBus;
  private workflows?: WorkflowEngine;
  /** 该 tenant 绑定的默认项目工作目录解析器（v0 简化：projectId 即绝对路径或映射）。 */
  private resolveProjectCwd: (project: string) => string;

  constructor(opts: {
    tenantId: string;
    transport: RpcTransport;
    registry: AdapterRegistry;
    resolveProjectCwd?: (project: string) => string;
    policy?: Partial<TenantPolicy>;
    trustLocal?: boolean;
    workspaceRoot?: string;
    /** sqlite 文件路径（缺省内存库）。 */
    dbPath?: string;
    /** 或直接注入已有 store（多连接共享）。 */
    store?: PhononStore;
    /** 可观测事件总线（可选）。 */
    obs?: import("./observability.js").ObsBus;
  }) {
    this.tenantId = opts.tenantId;
    this.registry = opts.registry;
    this.policy = new PolicyEnforcer({ policy: opts.policy, trustLocal: opts.trustLocal, workspaceRoot: opts.workspaceRoot });
    // 持久化（D6）：projects/skills/worktrees/outbox 落 sqlite；dbPath 缺省内存库
    this.store = opts.store ?? new PhononStore(opts.dbPath ?? ":memory:");
    this.idempotency = new IdempotencyStore({ store: this.store });

    // 先建 engine（ProjectManager 要用它查 active session）
    this.outbox = new Outbox({ store: this.store, tenantId: opts.tenantId });
    this.engine = new SessionEngine(opts.registry, (event: StreamEvent) => {
      this.workflows?.onStreamEvent(event);
      // 下行可靠投递（D29）：先入 outbox（含 sqlite）再发；server ack 后清理
      this.outbox.enqueue(event);
      this.peer.notifyRaw("stream.event", event);
    }, opts.obs, this.store);
    this.engine.resolveCwdForReattach = (projectId) => this.resolveProjectCwd(projectId);
    this.obs = opts.obs;

    this.projects = new ProjectManager(
      (projectId) => this.engine.activeSessionsForProject(projectId), // 真实 active 查询（修 P0#8）
      {
        assertProjectPath: (p) => this.policy.assertProjectPath(p),
        assertDeleteFiles: () => this.policy.assertDeleteFiles(),
        store: this.store,
        workspaceRoot: this.policy.workspaceRoot, // 与 policy 一致，避免路径校验冲突
        hasActiveSessionsForWorktree: (wtId) => this.engine.activeSessionsForWorktree(wtId), // 精确查询（B8）
      },
    );
    this.skills = new SkillManager(
      opts.registry,
      (projectId) => {
        try {
          return this.projects.get(projectId).path;
        } catch {
          return undefined;
        }
      },
      this.store,
    );
    this.files = new FileManager({ resolveCwd: (projectId, worktreeId) => this.projects.resolveCwd(projectId, worktreeId) });
    this.env = new EnvManager(this.store, { allowReveal: () => this.policy.allowEnvReveal() });
    this.resolveProjectCwd = opts.resolveProjectCwd ?? ((p) => this.projects.resolveCwd(p));

    this.peer = new RpcPeer(opts.transport, (method, params) => this.dispatch(method, params));
    this.workflows = new WorkflowEngine({
      tenantId: this.tenantId,
      engine: this.engine,
      resolveCwd: (projectId, worktreeId) => this.projects.resolveCwd(projectId, worktreeId),
      env: this.env,
      // v0.6: 接入 ProjectManager 给 workflow node 提供 per-node worktree 按需创建/checkout 能力
      projects: {
        worktreeCreate: (params) => this.projects.worktreeCreate(params).then((wt) => ({ worktreeId: wt.worktreeId, path: wt.path, branch: wt.branch })),
        worktreeRemove: (params) => this.projects.worktreeRemove(params),
        runGit: async (projectId, args) => runGit(this.projects.get(projectId).path, args),
        getProjectPath: (projectId) => this.projects.get(projectId).path,
      },
      store: this.store,
      emit: (event) => this.peer.notifyRaw("workflow.event", event),
      requestInteraction: (params: unknown) => this.peer.requestRaw("interaction.request", params),
    });
  }

  /** 喂入收到的文本。 */
  handle(data: string): Promise<void> {
    return this.peer.handle(data);
  }

  /** 连接断开：拒绝 pending RPC；outbox 保留供重连补发。 */
  onClose(reason = "connection closed"): void {
    this.peer.rejectAllPending(reason);
  }

  /** 重连后补发未 ack 的 stream.event（D29）。resumeFrom = server welcome.ackedSeqs 转换。 */
  replayPending(resumeFrom?: Array<{ sessionId: string; fromSeq: number }>): number {
    const events = this.outbox.pending(resumeFrom);
    for (const e of events) this.peer.notifyRaw("stream.event", e);
    return events.length;
  }

  /** outbox 待投递事件数（监控用）。 */
  get outboxSize(): number {
    return this.outbox.size;
  }

  /** 当前 session 实时快照（可观测 /sessions）。 */
  sessionsSnapshot(): Array<Record<string, unknown>> {
    return this.engine.snapshot(this.tenantId);
  }

  // ---- p2s 主动发起（phonon → server，平面③ + HITL）----

  /** 发本地文档给 server（document.send，D20）。adapter 解析 directive 后调用。 */
  async sendDocument(params: unknown): Promise<unknown> {
    return this.peer.requestRaw("document.send", params);
  }

  /** 请求大文件上传凭证（document.prepare_upload，P1-6）。 */
  async prepareUpload(params: unknown): Promise<unknown> {
    return this.peer.requestRaw("document.prepare_upload", params);
  }

  /** 主动通知 server：agent 可用性变化（discovery.changed，D14）。 */
  notifyDiscoveryChanged(params: unknown): void {
    this.peer.notifyRaw("discovery.changed", params);
  }

  /** 发可交互表单给 server，阻塞等人填（interaction.request，D21/P1-5）。 */
  async requestInteraction(params: unknown): Promise<unknown> {
    return this.peer.requestRaw("interaction.request", params);
  }

  /** 报 hook 事件并阻塞等 server 裁决（hook.fired，design §8，HITL）。 */
  async fireHook(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string; hookType?: string; payload?: { toolName?: string } };
    this.obs?.emitEvent({
      category: "hitl", level: "info", event: "hitl.fired",
      tenantId: this.tenantId, sessionId: p.sessionId,
      msg: `HITL ${p.hookType} for tool ${p.payload?.toolName ?? "?"}`,
      data: { hookType: p.hookType, toolName: p.payload?.toolName },
    });
    const res = (await this.peer.requestRaw("hook.fired", params)) as { action?: string };
    this.obs?.emitEvent({
      category: "hitl", level: res?.action === "abort" ? "warn" : "info", event: "hitl.resolved",
      tenantId: this.tenantId, sessionId: p.sessionId,
      msg: `HITL decision: ${res?.action ?? "continue"}`, data: { action: res?.action },
    });
    return res;
  }

  /** 某 phonon sessionId 是否属于本连接（tenant）——HookBridge 路由用。 */
  ownsSession(sessionId: string): boolean {
    try {
      this.engine.assertTenant(sessionId, this.tenantId);
      return true;
    } catch {
      return false;
    }
  }

  /** server → phonon 方法分发（L2 dispatch）。 */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    let p = (params ?? {}) as Record<string, unknown>;
    // 协议级参数校验（bug-bash#2 B6）：s2p 方法过 zod，非法参数 → errInvalidParams
    if (method in METHODS && (METHODS as Record<string, { direction: string }>)[method]?.direction === "s2p") {
      try {
        p = parseParams(method as MethodName, params) as Record<string, unknown>;
      } catch (err) {
        throw new PhononError("errInvalidParams", `invalid params for ${method}: ${(err as Error)?.message?.slice(0, 200)}`);
      }
    }
    // 只读租户 / 方法白名单（policy）
    this.policy.assertMethodAllowed(method);
    // 幂等：改状态请求带 clientRequestId 则去重（D28 / P0#2）
    const crid = p.clientRequestId as string | undefined;
    if (crid && MUTATING_METHODS.has(method)) {
      return this.idempotency.run(this.tenantId, method, crid, () => this.dispatchInner(method, p));
    }
    return this.dispatchInner(method, p);
  }

  private deviceFsRoots(): { roots: Array<{ root: string; path: string; label?: string }> } {
    const roots: Array<{ root: string; path: string; label?: string }> = [
      { root: "workspaceRoot", path: this.policy.workspaceRoot, label: "agent-phonon workspace root" },
      { root: "home", path: homedir(), label: "user home" },
    ];
    if (platform() === "win32") {
      for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const p = `${c}:\\\\`;
        if (existsSync(p)) roots.push({ root: p, path: p, label: `${c}: drive` });
      }
    } else {
      roots.push({ root: "/", path: "/", label: "filesystem root" });
    }
    return { roots };
  }

  private async deviceFsList(params: { root?: string; path?: string; absolutePath?: string; includeHidden?: boolean; limit?: number }): Promise<unknown> {
    const roots = this.deviceFsRoots().roots;
    const root = params.absolutePath ? parse(params.absolutePath).root : (params.root ?? "workspaceRoot");
    const rootPath = params.absolutePath ? parse(params.absolutePath).root : (roots.find((r) => r.root === root)?.path ?? root);
    const relPath = params.absolutePath ? relative(rootPath, params.absolutePath) || "." : (params.path ?? ".");
    if (isAbsolute(relPath)) throw new PhononError("errPolicyDenied", "device.fs.list relative path must not be absolute when using root");
    const target = resolve(rootPath, relPath);
    const rootReal = await realpath(rootPath);
    const targetReal = await realpath(target);
    const rel = relative(rootReal, targetReal);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new PhononError("errPolicyDenied", "device.fs.list path escapes selected root");
    const entriesRaw = await readdir(targetReal, { withFileTypes: true });
    const limit = params.limit ?? 200;
    const filtered = entriesRaw.filter((e) => params.includeHidden || !e.name.startsWith("."));
    const entries = [] as Array<{ name: string; path: string; realPath: string; kind: "file" | "directory" | "symlink" | "other"; size?: number; mtimeMs?: number }>;
    for (const e of filtered.slice(0, limit)) {
      const full = join(targetReal, e.name);
      const st = await lstat(full);
      const kind = e.isDirectory() ? "directory" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other";
      entries.push({ name: e.name, path: join(relPath, e.name), realPath: await realpath(full).catch(() => full), kind, size: st.isFile() ? st.size : undefined, mtimeMs: st.mtimeMs });
    }
    return { root, rootPath: rootReal, path: relPath, realPath: targetReal, entries, truncated: filtered.length > limit };
  }

  private async dispatchInner(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "device.info":
        return collectDeviceInfo();
      case "device.resources":
        return collectDeviceResources(this.policy.workspaceRoot);
      case "device.fs.roots":
        return this.deviceFsRoots();
      case "device.fs.list":
        return this.deviceFsList(p as { root?: string; path?: string; absolutePath?: string; includeHidden?: boolean; limit?: number });
      case "discovery.list": {
        // 聚合所有 runtime 的 sub-agents（OpenClaw 多 agent / Codex 单 agent）
        const nested = await Promise.all(this.registry.all().map((a) => a.discoverAgents()));
        return { agents: nested.flat() };
      }
      case "discovery.get": {
        const adapter = this.registry.resolve(p.agentId as string);
        if (!adapter) throw new PhononError("errAgentUnavailable", `agent ${p.agentId} not found`);
        const agents = await adapter.discoverAgents();
        const found = agents.find((a) => a.agentId === p.agentId) ?? agents[0];
        return { agent: found };
      }
      case "session.create": {
        // worktreeId 指定时，cwd = 该 worktree 路径（修 P0#12）
        let cwd = this.resolveProjectCwd(p.project as string);
        if (p.worktreeId) {
          const wt = this.projects.worktreeList(p.project as string).find((w) => w.worktreeId === p.worktreeId);
          if (wt) cwd = wt.path;
        }
        const r = await this.engine.create({
          tenantId: this.tenantId,
          project: p.project as string,
          worktreeId: p.worktreeId as string | undefined,
          cwd,
          agent: p.agent as string,
          model: p.model as string,
          verbosity: (p.verbosity as "messages") ?? "messages",
          agentConfig: p.agentConfig as Record<string, unknown> | undefined,
          initialContext: p.initialContext as never,
        });
        return { sessionId: r.sessionId, project: p.project, agent: p.agent, model: p.model, status: r.status, createdAt: r.createdAt };
      }
      case "session.send": {
        const meta = await this.engine.status(this.tenantId, p.sessionId as string);
        const r = await this.engine.send(this.tenantId, p.sessionId as string, p.input as string, {
          verbosity: p.verbosity as never,
          turnId: p.turnId as string | undefined,
          skills: (p.skills as string[]) ?? undefined,
          environment: this.env.resolveForExecution({ projectId: meta.project, agent: meta.agent, skills: (p.skills as string[]) ?? undefined }),
          whenBusy: p.whenBusy as never,
          fallback: p.fallback as never,
        });
        return { sessionId: p.sessionId, turnId: r.turnId, accepted: true, disposition: r.disposition, queuePosition: r.queuePosition };
      }
      case "session.interrupt": {
        const r = await this.engine.interrupt(this.tenantId, p.sessionId as string, p.reason as string | undefined);
        return { sessionId: p.sessionId, interruptedTurnId: r.interruptedTurnId, status: r.status };
      }
      case "session.switchModel": {
        const r = await this.engine.switchModel(this.tenantId, p.sessionId as string, p.model as string);
        return { sessionId: p.sessionId, previousModel: r.previousModel, model: r.model, warnings: r.warnings };
      }
      case "session.inject": {
        const r = await this.engine.inject(this.tenantId, p.sessionId as string, p.context as never);
        return { sessionId: p.sessionId, injected: r.injected };
      }
      case "session.compress": {
        const r = await this.engine.compress(this.tenantId, p.sessionId as string, (p.mode as "native" | "custom") ?? "native", p.strategy as string | undefined, { keepRecentToolCalls: p.keepRecentToolCalls as number | undefined });
        return { sessionId: p.sessionId, mode: r.mode, summary: r.summary };
      }
      case "session.terminate": {
        const r = await this.engine.terminate(this.tenantId, p.sessionId as string);
        return { sessionId: p.sessionId, status: r.status };
      }
      case "session.status":
        return this.engine.status(this.tenantId, p.sessionId as string);
      case "session.list":
        return this.engine.list(this.tenantId, p as never);

      // ---- project (D23/D25) ----
      case "project.create": {
        const r = await this.projects.create({ name: p.name as string, path: p.path as string | undefined, git: p.git as boolean | undefined, remote: p.remote as string | undefined });
        return { project: { projectId: r.projectId, name: r.name, path: r.path, git: r.git, createdAt: r.createdAt } };
      }
      case "project.list":
        return { projects: this.projects.list().map((r) => ({ projectId: r.projectId, name: r.name, path: r.path, git: r.git, createdAt: r.createdAt })) };
      case "project.get": {
        const r = this.projects.get(p.projectId as string);
        return { project: { projectId: r.projectId, name: r.name, path: r.path, git: r.git, createdAt: r.createdAt } };
      }
      case "project.remove": {
        const r = await this.projects.remove(p.projectId as string, { deleteFiles: p.deleteFiles as boolean, whenActiveSessions: p.whenActiveSessions as "reject" | "cascade" });
        // cascade：真正 terminate 被级联的 session（修 B8：之前只返回列表不 terminate）
        if (r.terminatedSessions) {
          for (const sid of r.terminatedSessions) {
            await this.engine.terminate(this.tenantId, sid).catch(() => {});
          }
        }
        return { projectId: p.projectId, removed: true, filesDeleted: r.filesDeleted, terminatedSessions: r.terminatedSessions };
      }
      case "project.worktree.create": {
        const r = await this.projects.worktreeCreate({ projectId: p.projectId as string, baseBranch: p.baseBranch as string, newBranch: p.newBranch as string | undefined, path: p.path as string | undefined });
        return { worktree: r };
      }
      case "project.worktree.list":
        return { worktrees: this.projects.worktreeList(p.projectId as string) };
      case "project.worktree.remove": {
        const r = await this.projects.worktreeRemove({ projectId: p.projectId as string, worktreeId: p.worktreeId as string, force: p.force as boolean });
        return { worktreeId: p.worktreeId, removed: true, affectedSessions: r.affectedSessions };
      }
      case "project.git.deleteBranch": {
        const r = await this.projects.deleteBranch({ projectId: p.projectId as string, branch: p.branch as string, force: p.force as boolean });
        return { branch: p.branch, deleted: true, wasMerged: r.wasMerged, affectedWorktrees: r.affectedWorktrees };
      }
      case "project.git.commit":
        return this.projects.gitCommit(p as { projectId: string; worktreeId?: string; message: string; files?: string[]; allowEmpty?: boolean; author?: { name: string; email: string } });
      case "project.git.merge":
        return this.projects.gitMerge(p as { projectId: string; sourceBranch: string; targetBranch?: string; strategy?: "merge"|"squash"|"rebase"|"ff-only"; message?: string; abortOnConflict?: boolean });
      case "project.git.diff":
        return this.projects.gitDiff(p as { projectId: string; worktreeId?: string; ref1?: string; ref2?: string; paths?: string[]; contextLines?: number; statOnly?: boolean; maxBytes?: number });
      case "project.git.log":
        return this.projects.gitLog(p as { projectId: string; worktreeId?: string; branch?: string; limit?: number; since?: string; until?: string; paths?: string[] });
      case "project.git.push":
        return this.projects.gitPush(p as { projectId: string; worktreeId?: string; branch: string; remote?: string; force?: boolean; setUpstream?: boolean });
      case "project.git.status":
        return this.projects.gitStatus(p as { projectId: string; worktreeId?: string });
      case "project.exec":
        return this.projects.exec(p as { projectId: string; worktreeId?: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number });

      // ---- file workspace IO (project/worktree scoped) ----
      case "file.read":
        return this.files.read(p as { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; maxBytes?: number });
      case "file.write":
        return this.files.write(p as { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; data: string; overwrite?: boolean; createDirs?: boolean });
      case "file.list":
        return this.files.list(p as { projectId: string; worktreeId?: string; path?: string; recursive?: boolean; limit?: number });
      case "file.stat":
        return this.files.stat(p as { projectId: string; worktreeId?: string; path: string });
      case "file.mkdir":
        return this.files.mkdir(p as { projectId: string; worktreeId?: string; path: string; recursive?: boolean });

      case "env.set":
        return this.env.set(p as { scope: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret?: boolean });
      case "env.list":
        return this.env.list(p as { scope?: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; reveal?: boolean });
      case "env.delete":
        return this.env.delete(p as { scope: "global" | "project" | "skill"; projectId?: string; agent?: string; skillName?: string; name: string });

      // ---- skill (D24 + 边界规则) ----
      case "skill.install": {
        // policy：global 装 / url 源 检查（P0-1）
        if ((p.scope as string) === "global") this.policy.assertGlobalSkillInstall();
        const src = p.source as { kind?: string } | undefined;
        if (src?.kind === "url") this.policy.assertUrlSkillInstall();
        const r = await this.skills.install({
          agent: p.agent as string, name: p.name as string,
          scope: p.scope as "global" | "project", projectId: p.projectId as string | undefined,
          source: p.source as never,
          allowUrl: true, // policy 已在上面把关
        });
        return { skill: r };
      }
      case "skill.uninstall": {
        await this.skills.uninstall({ agent: p.agent as string, name: p.name as string, scope: p.scope as "global" | "project", projectId: p.projectId as string | undefined });
        return { agent: p.agent, name: p.name, scope: p.scope, uninstalled: true };
      }
      case "skill.list":
        return { skills: this.skills.list({ agent: p.agent as string | undefined, scope: p.scope as "global" | "project" | undefined, projectId: p.projectId as string | undefined }) };
      case "skill.dirs":
        return { directories: await this.skills.dirs({ agent: p.agent as string | undefined, scope: p.scope as "global" | "project" | undefined, projectId: p.projectId as string | undefined }) };

      // ---- L3 workflow orchestration ----
      case "workflow.run":
        return this.workflows!.run({
          project: p.project as string,
          worktreeId: p.worktreeId as string | undefined,
          branch: p.branch as string | undefined,
          plan: p.plan as WorkflowPlan,
          input: p.input as string | undefined,
          policy: p.policy as never,
          sharedContext: p.sharedContext as never,
          resumeFrom: p.resumeFrom as never,
          metadata: p.metadata as Record<string, unknown> | undefined,
        });
      case "workflow.status":
        return this.workflows!.status(p.workflowId as string);
      case "workflow.cancel":
        return this.workflows!.cancel(p.workflowId as string, p.reason as string | undefined);
      case "workflow.list":
        return this.workflows!.list(p as { status?: string; projectId?: string; since?: string; until?: string; limit?: number });
      case "workflow.resume":
        return this.workflows!.resume({
          workflowId: p.workflowId as string,
          strategy: (p.strategy as "last_success_dependents" | "failed_node" | `node:${string}` | undefined) ?? "failed_node",
          rerunNodes: p.rerunNodes as string[] | undefined,
          feedback: p.feedback as string | undefined,
          sharedContextPatch: p.sharedContextPatch as never,
        });
      case "workflow.ack": {
        this.workflows?.ack(p.workflowId as string, p.lastSeq as number);
        return null;
      }
      case "workflow.events.list":
        return this.workflows!.eventsList(p as { workflowId: string; afterSeq?: number; limit?: number });
      case "workflow.artifact.register":
        return this.workflows!.artifactRegister(p as { workflowId: string; nodeId?: string; kind: "report" | "diff" | "spec" | "log" | "patch" | "image" | "binary" | "other"; path: string; title?: string; mimeType?: string; metadata?: Record<string, unknown> });
      case "workflow.artifacts.list":
        return this.workflows!.artifactsList(p.workflowId as string);

      // ---- 连接/可靠性（s2p） ----
      case "stream.ack": {
        // server 确认已收 seq≤lastSeq → phonon 清 outbox（D29 / P0-4）。
        this.outbox.ack(p.sessionId as string | undefined, p.lastSeq as number);
        return null;
      }
      case "interaction.response": {
        // server 回填人机交互结果（P1-5）→ 路由回对应 session/turn。v0 记录即可。
        this.engine.resolveInteraction?.(p.requestId as string, p as never);
        return null;
      }
      case "interaction.cancel": {
        // server 主动取消一个 pending 交互（P1-5）。
        this.engine.resolveInteraction?.(p.requestId as string, { action: "cancel", requestId: p.requestId });
        return { requestId: p.requestId, cancelled: true };
      }
      case "hook.resolve": {
        // server 主动下发裁决（异步路径；同步路径是 hook.fired 的 RPC 响应）。
        return { sessionId: p.sessionId, hookId: p.hookId, applied: true };
      }
      default:
        throw new PhononError("errInvalidParams", `method not implemented in v0 core: ${method}`);
    }
  }
}

export { SessionEngine, AdapterRegistry, RpcPeer, PhononError, PROTOCOL_VERSION };
export type { AgentAdapter, RpcTransport };
export * from "./adapter.js";
export { OpenClawAdapter } from "./adapters/openclaw.js";
export { OpenClawGatewayAdapter } from "./adapters/openclaw-gateway.js";
export { GatewayClient } from "./gateway-client.js";
export type { GatewayConfig } from "./gateway-client.js";
export { PhononClient } from "./client.js";
export { HookBridge } from "./hook-bridge.js";
export type { HookRouteResolver } from "./hook-bridge.js";
export { ProjectManager } from "./project-manager.js";
export { SkillManager } from "./skill-manager.js";
export { PolicyEnforcer } from "./policy.js";
export { IdempotencyStore } from "./idempotency.js";
export { Outbox } from "./outbox.js";
export { WorkflowEngine } from "./workflow-engine.js";
export { PhononStore } from "./store.js";
export { SecretBox } from "./secret-box.js";
export { FileManager } from "./file-manager.js";
export { EnvManager } from "./env-manager.js";
export { dropToolIOFromJsonlFiles, dropToolIOFromValue, computeKeepToolBlocks } from "./custom-compress.js";
export { dropToolIORowsSqlite } from "./sqlite-compress.js";
export { resolveCodexSessionFile } from "./adapters/codex.js";
export { resolveOpenCodeDbPath } from "./adapters/opencode.js";
export { resolveHermesDbPath, resolveHermesSessionByTitle } from "./adapters/hermes.js";
export { collectDeviceResources } from "./resources.js";
export { collectDeviceInfo } from "./device-info.js";
export { ObsBus, StructuredLogger, Metrics, AuditSink } from "./observability.js";
export type { ObsEvent, ObsCategory, ObsLevel } from "./observability.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export type { ClaudeCodeEnv } from "./adapters/claude-code.js";
export { CodexAdapter } from "./adapters/codex.js";
export type { CodexEnv } from "./adapters/codex.js";
export { HermesAdapter } from "./adapters/hermes.js";
export type { HermesEnv } from "./adapters/hermes.js";
export { OpenCodeAdapter } from "./adapters/opencode.js";
export type { OpenCodeEnv } from "./adapters/opencode.js";
