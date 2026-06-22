import { mkdir, rm, writeFile, readdir, stat, mkdtemp, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { PhononError } from "./rpc.js";
import type { AdapterRegistry } from "./session-engine.js";

/**
 * Skill 管理（design D24 + 安全边界规则）。
 *
 * 安装位置规则：
 *  - project scope → 装到 <project>/.agent/skills/<name>/ —— **runtime 无关**，谁用这个 project 都看得到
 *  - global scope  → **依赖 runtime**，装到对应 runtime 的全局 skill 目录
 *      （adapter.globalSkillDir(agentId) 提供；OpenClaw = 该 sub-agent workspace/skills）
 *
 * phonon 自己管一套安装逻辑；global 位置交给各 adapter（只有它知道自己 runtime skill 目录）。
 */

export interface SkillRecord {
  name: string;
  agent: string;
  scope: "global" | "project";
  projectId?: string;
  version?: string;
  hash?: string;
  installedPath: string;
  installedAt: string;
}

type SkillSource =
  | { kind: "inline"; files: Record<string, string> }
  | { kind: "archive"; format: "tar.gz"; contentBase64: string; sha256?: string; sizeBytes?: number }
  | { kind: "localPath"; path: string }
  | { kind: "url"; url: string; sha256?: string };

const execFileAsync = promisify(execFile);

export class SkillManager {
  private skills: SkillRecord[] = [];
  private registry: AdapterRegistry;
  /** projectId → 项目目录解析（core 注入）。 */
  private resolveProjectPath: (projectId: string) => string | undefined;
  private store?: import("./store.js").PhononStore;

  constructor(
    registry: AdapterRegistry,
    resolveProjectPath: (projectId: string) => string | undefined,
    store?: import("./store.js").PhononStore,
  ) {
    this.registry = registry;
    this.resolveProjectPath = resolveProjectPath;
    this.store = store;
    if (this.store) for (const s of this.store.loadSkills()) this.skills.push(s);
  }

  /** 计算安装目标目录（核心边界规则）。 */
  private targetDir(params: { agent: string; name: string; scope: "global" | "project"; projectId?: string }): string {
    // 防路径穿越（bug-bash#2 B8）：skill name 限定安全字符
    if (!/^[a-zA-Z0-9._-]+$/.test(params.name) || params.name === "." || params.name === "..") {
      throw new PhononError("errSkillScopeInvalid", `invalid skill name: ${params.name}`);
    }
    if (params.scope === "project") {
      if (!params.projectId) throw new PhononError("errSkillScopeInvalid", "project scope requires projectId");
      const projPath = this.resolveProjectPath(params.projectId);
      if (!projPath) throw new PhononError("errProjectNotFound", `project ${params.projectId} not found`);
      // project scope → <project>/.agent/skills/<name>，runtime 无关
      return join(projPath, ".agent", "skills", params.name);
    }
    // global scope → adapter 提供的 runtime skill 目录
    const adapter = this.registry.resolve(params.agent);
    if (!adapter) throw new PhononError("errAgentUnavailable", `agent ${params.agent} not found`);
    if (!adapter.globalSkillDir) throw new PhononError("errCapabilityUnsupported", `runtime does not support global skills`);
    const dir = adapter.globalSkillDir(params.agent);
    if (!dir) throw new PhononError("errCapabilityUnsupported", `no global skill dir for ${params.agent}`);
    return join(dir, params.name);
  }

  async install(params: {
    agent: string;
    name: string;
    scope: "global" | "project";
    projectId?: string;
    source: SkillSource;
    allowUrl?: boolean;
  }): Promise<SkillRecord> {
    const dest = this.targetDir(params);
    await mkdir(dest, { recursive: true });

    let hash: string | undefined;
    const hasher = createHash("sha256");

    if (params.source.kind === "inline") {
      for (const [rel, content] of Object.entries(params.source.files)) {
        const full = resolve(dest, rel);
        // 防路径穿越：写入目标必须在 dest 内（bug-bash#2 B8）
        if (full !== dest && !full.startsWith(dest + sep)) {
          throw new PhononError("errSkillInstallFailed", `inline file path escapes skill dir: ${rel}`);
        }
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content);
        hasher.update(rel).update(content);
      }
      hash = hasher.digest("hex");
    } else if (params.source.kind === "archive") {
      hash = await this.installArchive(params.source, dest);
    } else if (params.source.kind === "localPath") {
      // 复制本地目录（用 cp -r 的等价：递归读写）
      await this.copyDir(params.source.path, dest, hasher);
      hash = hasher.digest("hex");
    } else {
      // url：受 policy 控制（P0-1 allowUrlSkillInstall），v0 默认拒
      if (!params.allowUrl)
        throw new PhononError("errPolicyDenied", "url skill install disabled by policy (allowUrlSkillInstall)");
      throw new PhononError("errSkillInstallFailed", "url install not implemented in v0");
    }

    const rec: SkillRecord = {
      name: params.name,
      agent: params.agent,
      scope: params.scope,
      projectId: params.projectId,
      hash,
      installedPath: dest,
      installedAt: new Date().toISOString(),
    };
    // 去重：同 agent+scope+name(+project) 覆盖
    this.skills = this.skills.filter(
      (s) => !(s.agent === rec.agent && s.scope === rec.scope && s.name === rec.name && s.projectId === rec.projectId),
    );
    this.skills.push(rec);
    this.store?.upsertSkill(rec);
    return rec;
  }

  async uninstall(params: { agent: string; name: string; scope: "global" | "project"; projectId?: string }): Promise<void> {
    const dest = this.targetDir(params);
    if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
    this.skills = this.skills.filter(
      (s) => !(s.agent === params.agent && s.scope === params.scope && s.name === params.name && s.projectId === params.projectId),
    );
    this.store?.deleteSkill(params);
  }

  list(filter?: { agent?: string; scope?: "global" | "project"; projectId?: string }): SkillRecord[] {
    return this.skills.filter((s) => {
      if (filter?.agent && s.agent !== filter.agent) return false;
      if (filter?.scope && s.scope !== filter.scope) return false;
      if (filter?.projectId && s.projectId !== filter.projectId) return false;
      return true;
    });
  }

  private async installArchive(source: Extract<SkillSource, { kind: "archive" }>, dest: string): Promise<string> {
    if (source.format !== "tar.gz") throw new PhononError("errSkillInstallFailed", `unsupported archive format: ${source.format}`);
    const buf = Buffer.from(source.contentBase64, "base64");
    const hash = createHash("sha256").update(buf).digest("hex");
    if (source.sha256 && source.sha256 !== hash) throw new PhononError("errSkillInstallFailed", "archive sha256 mismatch");

    const tmp = await mkdtemp(join(tmpdir(), "phonon-skill-"));
    const archive = join(tmp, "skill.tar.gz");
    const staging = join(tmp, "staging");
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(archive, buf, { mode: 0o600 });
      const { stdout } = await execFileAsync("tar", ["-tzf", archive], { timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
      for (const entry of stdout.split(/\n/).filter(Boolean)) this.assertArchiveEntrySafe(entry);
      await execFileAsync("tar", ["-xzf", archive, "-C", staging], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
      await this.assertNoSymlinks(staging);
      await this.copyDir(staging, dest, createHash("sha256"));
      return hash;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private assertArchiveEntrySafe(entry: string): void {
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")) {
      throw new PhononError("errSkillInstallFailed", `unsafe archive entry: ${entry}`);
    }
  }

  private async assertNoSymlinks(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      const p = join(root, e.name);
      const s = await lstat(p);
      if (s.isSymbolicLink()) throw new PhononError("errSkillInstallFailed", `archive contains symlink: ${e.name}`);
      if (s.isDirectory()) await this.assertNoSymlinks(p);
    }
  }

  private async copyDir(src: string, dest: string, hasher: ReturnType<typeof createHash>): Promise<void> {
    if (!existsSync(src)) throw new PhononError("errSkillNotFound", `source ${src} not found`);
    const entries = await readdir(src, { withFileTypes: true });
    for (const e of entries) {
      const s = join(src, e.name);
      const d = join(dest, e.name);
      if (e.isDirectory()) {
        await mkdir(d, { recursive: true });
        await this.copyDir(s, d, hasher);
      } else {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(s);
        await writeFile(d, content);
        hasher.update(e.name).update(content);
      }
    }
  }
}
