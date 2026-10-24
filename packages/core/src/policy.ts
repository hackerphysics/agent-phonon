import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { TenantPolicy, DEFAULT_TENANT_POLICY, isPathUnderRoots, type TenantPolicy as TenantPolicyT } from "@agent-phonon/protocol";
import { PhononError } from "./rpc.js";
import {canonicalWorkspacePath as canonicalPath,workspacePathsOverlap,workspacePathKey} from "./workspace-paths.js";

/**
 * 本地安全策略执行器（design D27 / bug-bash P0-1）。
 *
 * 协议定义了 TenantPolicy，但 v0 dispatch 没真执行。这里把它落地：
 * 每个 PhononConnection 持一个 PolicyEnforcer，在 project/skill/document/destructive
 * 操作入口强制检查，违反抛 errPolicyDenied / errDocumentPathDenied。
 *
 * 默认最严格（DEFAULT_TENANT_POLICY）：白名单空、写操作全关、敏感路径黑名单。
 * 但为了不破坏「单设备本地自用」的开箱体验，构造时可传宽松默认（trustLocal）。
 */
export class PolicyEnforcer {
  readonly policy: TenantPolicyT;
  /** 受控工作区根（项目缺省建在这下面）。 */
  readonly workspaceRoot: string;
  private readonly projectRoots: string[];

  constructor(opts?: { policy?: Partial<TenantPolicyT>; workspaceRoot?: string; trustLocal?: boolean }) {
    // Match ProjectManager's canonical paths, including macOS /var aliases.
    // Non-existent roots retain their suffix after resolving existing ancestors.
    const rawRoot = opts?.workspaceRoot ?? process.env.PHONON_PROJECTS_ROOT ?? join(homedir(), "phonon-projects");
    this.workspaceRoot = canonicalPath(rawRoot);
    if (opts?.policy) {
      this.policy = TenantPolicy.parse(opts.policy);
    } else if (opts?.trustLocal) {
      // 本地自用：允许写操作 + 受控根作为默认 allowedProjectRoots
      this.policy = TenantPolicy.parse({
        allowedProjectRoots: [this.workspaceRoot],
        allowDeleteFiles: true,
        allowGlobalSkillInstall: true,
        allowUrlSkillInstall: false, // url 装仍默认禁（供应链风险）
        allowExternalDocuments: false,
        allowEnvWrite: true,
        allowExec: true, // 单机自用：exec 默认开（A2/A3，不影响本机使用）
        // Maintenance is host-level recovery, not merely project-local trust.
        // It must be opted into explicitly per server policy even for trustLocal.
      });
    } else {
      this.policy = DEFAULT_TENANT_POLICY;
    }
    // Pin authorized root identities once; retargeting a configured symlink
    // must not grant access to a different directory later.
    this.projectRoots = [this.workspaceRoot, ...this.policy.allowedProjectRoots.map(canonicalPath)];
  }

  /** 项目路径是否允许（落在 allowedProjectRoots 或受控根下）。 */
  assertProjectPath(path: string): void {
    const abs = canonicalPath(path);
    if (!isPathUnderRoots(abs, this.projectRoots)) {
      throw new PhononError("errPolicyDenied", `project path outside allowed roots: ${abs}`);
    }
  }
  assertProjectDirectoryNavigation(path:string):void{
    const key=workspacePathKey(canonicalPath(path));
    if(!this.projectRoots.some(root=>workspacePathsOverlap(key,workspacePathKey(root))))throw new PhononError("errPolicyDenied","directory is outside configured workspace routes");
  }

  /** 文档路径是否允许（默认 project-scoped；外部需 allowExternalDocuments）。 */
  assertDocumentPath(absPath: string, projectRoot: string | undefined): void {
    const abs = resolve(absPath);
    // deny 黑名单优先（即使在项目内也拒）
    for (const pat of this.policy.denyPathPatterns) {
      if (matchGlob(abs, pat)) throw new PhononError("errDocumentPathDenied", `denied by pattern ${pat}`);
    }
    if (projectRoot && isPathUnderRoots(abs, [projectRoot])) return; // 项目内放行
    if (this.policy.allowExternalDocuments) return;
    throw new PhononError("errDocumentPathDenied", `document path outside project: ${abs}`);
  }

  assertDeleteFiles(): void {
    if (!this.policy.allowDeleteFiles) throw new PhononError("errPolicyDenied", "deleteFiles disabled by policy");
  }

  assertGlobalSkillInstall(): void {
    if (!this.policy.allowGlobalSkillInstall) throw new PhononError("errPolicyDenied", "global skill install disabled by policy");
  }
  assertSkillRecovery():void{
    if(!this.policy.allowSkillRecovery)throw new PhononError("errPolicyDenied","skill recovery requires explicit local permission");
  }

  assertUrlSkillInstall(): void {
    if (!this.policy.allowUrlSkillInstall) throw new PhononError("errPolicyDenied", "url skill install disabled by policy");
  }

  /**
   * B2: localPath skill 源默认禁。localPath 会把设备上任意本地目录复制进 skill 区→
   * 绕过文件沙箱的任意读取。复用 allowUrlSkillInstall 的“供应链风险”语义档。
   * trustLocal 下也默认不开（需显式 allowLocalPathSkillInstall）。
   */
  assertLocalPathSkillInstall(): void {
    if (!this.policy.allowLocalPathSkillInstall) throw new PhononError("errPolicyDenied", "localPath skill install disabled by policy (allowLocalPathSkillInstall)");
  }

  assertMethodAllowed(method: string): void {
    if (this.policy.allowedMethods.length > 0 && !this.policy.allowedMethods.includes(method)) {
      throw new PhononError("errPolicyDenied", `method ${method} not in allowedMethods (read-only tenant)`);
    }
  }

  allowEnvReveal(): boolean {
    return !!this.policy.allowEnvReveal;
  }

  /** 环境变量写入/删除是独立危险能力；读取脱敏列表不受此 gate 影响。 */
  assertEnvWrite(): void {
    if (!this.policy.allowEnvWrite) throw new PhononError("errPolicyDenied", "env write disabled by policy (allowEnvWrite)");
  }

  /** A2/A3: project.exec 需独立 gate（默认禁；trustLocal 开）。 */
  assertExec(): void {
    if (!this.policy.allowExec) throw new PhononError("errPolicyDenied", "project.exec disabled by policy (allowExec)");
  }
  assertEmployeeProfiles():void {
    if(!this.policy.allowEmployeeProfiles)throw new PhononError("errPolicyDenied","employee profile management requires allowEmployeeProfiles");
  }
  assertProjectProvision():void{
    if(!this.policy.allowProjectProvision)throw new PhononError("errPolicyDenied","controlled workspace provisioning requires explicit local permission");
  }

  /** A4: device.fs.* 浏览整个文件系统需 allowDeviceFsBrowse（默认开）。 */
  allowDeviceFsBrowse(): boolean {
    return this.policy.allowDeviceFsBrowse !== false;
  }

  assertAgentAllowed(agentId: string): void {
    if (this.policy.allowedAgents.length > 0 && !this.policy.allowedAgents.includes(agentId as never)) {
      throw new PhononError("errPolicyDenied", `agent ${agentId} not in allowedAgents`);
    }
  }

  assertMaintenanceRead(): void {
    if (!this.policy.allowMaintenanceRead) throw new PhononError("errPolicyDenied", "maintenance read disabled by policy");
  }

  assertMaintenanceConfigWrite(): void {
    if (!this.policy.allowMaintenanceConfigWrite) throw new PhononError("errPolicyDenied", "maintenance config write disabled by policy");
  }

  assertMaintenancePackageUpdate(): void {
    if (!this.policy.allowMaintenancePackageUpdate) throw new PhononError("errPolicyDenied", "maintenance package update disabled by policy");
  }

  assertMaintenanceServiceRestart(): void {
    if (!this.policy.allowMaintenanceServiceRestart) throw new PhononError("errPolicyDenied", "maintenance service restart disabled by policy");
  }

  maintenancePermissions(): { read: boolean; configWrite: boolean; packageUpdate: boolean; serviceRestart: boolean } {
    return {
      read: !!this.policy.allowMaintenanceRead,
      configWrite: !!this.policy.allowMaintenanceConfigWrite,
      packageUpdate: !!this.policy.allowMaintenancePackageUpdate,
      serviceRestart: !!this.policy.allowMaintenanceServiceRestart,
    };
  }

  assertUploadSize(bytes: number): void {
    if (this.policy.maxUploadBytes !== undefined && bytes > this.policy.maxUploadBytes) {
      throw new PhononError("errDocumentTooLarge", `${bytes} bytes exceeds maxUploadBytes ${this.policy.maxUploadBytes}`);
    }
  }
}

/** 极简 glob 匹配（仅支持 ** 和 *），用于 denyPathPatterns。 */
function matchGlob(path: string, pattern: string): boolean {
  const norm = path.replace(/\\/g, "/");
  const re = new RegExp(
    "^" +
      pattern
        .replace(/\\/g, "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000") // 占位
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*") +
      "$",
  );
  return re.test(norm);
}

export { matchGlob };
