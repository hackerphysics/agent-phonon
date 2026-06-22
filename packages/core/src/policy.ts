import { resolve } from "node:path";
import { homedir } from "node:os";
import { TenantPolicy, DEFAULT_TENANT_POLICY, isPathUnderRoots, type TenantPolicy as TenantPolicyT } from "@agent-phonon/protocol";
import { PhononError } from "./rpc.js";

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

  constructor(opts?: { policy?: Partial<TenantPolicyT>; workspaceRoot?: string; trustLocal?: boolean }) {
    this.workspaceRoot = opts?.workspaceRoot ?? process.env.PHONON_PROJECTS_ROOT ?? `${homedir()}/phonon-projects`;
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
      });
    } else {
      this.policy = DEFAULT_TENANT_POLICY;
    }
  }

  /** 项目路径是否允许（落在 allowedProjectRoots 或受控根下）。 */
  assertProjectPath(path: string): void {
    const abs = resolve(path);
    const roots = [this.workspaceRoot, ...this.policy.allowedProjectRoots];
    if (!isPathUnderRoots(abs, roots)) {
      throw new PhononError("errPolicyDenied", `project path outside allowed roots: ${abs}`);
    }
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

  assertUrlSkillInstall(): void {
    if (!this.policy.allowUrlSkillInstall) throw new PhononError("errPolicyDenied", "url skill install disabled by policy");
  }

  assertMethodAllowed(method: string): void {
    if (this.policy.allowedMethods.length > 0 && !this.policy.allowedMethods.includes(method)) {
      throw new PhononError("errPolicyDenied", `method ${method} not in allowedMethods (read-only tenant)`);
    }
  }

  allowEnvReveal(): boolean {
    return !!this.policy.allowEnvReveal;
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
