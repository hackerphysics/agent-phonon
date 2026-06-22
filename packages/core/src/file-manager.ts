import { mkdir, readFile, readdir, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PhononError } from "./rpc.js";

export interface FileScopeResolver {
  resolveCwd(projectId: string, worktreeId?: string): string;
}

type StatEntry = { path: string; type: "file" | "directory" | "symlink" | "other"; sizeBytes: number; modifiedAt: string };

export class FileManager {
  constructor(private resolver: FileScopeResolver) {}

  /**
   * Realpath of the deepest existing ancestor, with any non-existent suffix re-appended.
   * Lets us containment-check write/mkdir targets that don't exist yet, while still
   * resolving symlinks in the existing portion of the path.
   */
  private async realpathBoundary(abs: string): Promise<string> {
    const suffix: string[] = [];
    let cur = abs;
    for (;;) {
      try {
        const real = await realpath(cur);
        return suffix.length ? resolve(real, ...suffix) : real;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
        const parent = dirname(cur);
        if (parent === cur) return abs; // hit fs root, nothing left to resolve
        suffix.unshift(basename(cur));
        cur = parent;
      }
    }
  }

  /**
   * Resolve a project-relative path to an absolute path, enforcing that it stays
   * inside the project/worktree root — including via symlinks (defeats `evil -> /etc`).
   *
   * followFinal=true  (read/write/mkdir/list-base): the final component is resolved too,
   *   so a final symlink pointing outside is rejected (readFile/writeFile would follow it).
   * followFinal=false (stat): the final component is NOT resolved, so an in-project symlink
   *   can be lstat'd and reported as "symlink" without being followed. Middle-of-path
   *   symlinks are still resolved and rejected.
   */
  private async resolvePath(projectId: string, worktreeId: string | undefined, rel: string, followFinal = true): Promise<string> {
    if (rel.includes("\0") || rel.startsWith("/") || rel === "") {
      throw new PhononError("errInvalidParams", "file path must be a non-empty relative path");
    }
    // Normalize the root through realpath too, so both sides are comparable on
    // platforms where the workspace itself sits under a symlink (e.g. macOS /tmp).
    const root = await this.realpathBoundary(resolve(this.resolver.resolveCwd(projectId, worktreeId)));
    const abs = resolve(root, rel);
    // 1) lexical containment — fast reject of ../ escapes.
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new PhononError("errPolicyDenied", `file path escapes project/worktree: ${rel}`);
    }
    // 2) realpath containment — defeats symlink escape (string prefix check alone is insufficient).
    //    For stat we probe the parent dir so an in-project symlink entry can still be reported.
    const probe = !followFinal && abs !== root ? dirname(abs) : abs;
    const real = await this.realpathBoundary(probe);
    if (real !== root && !real.startsWith(root + sep)) {
      throw new PhononError("errPolicyDenied", `file path escapes project/worktree via symlink: ${rel}`);
    }
    return abs;
  }

  async read(params: { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; maxBytes?: number }) {
    const abs = await this.resolvePath(params.projectId, params.worktreeId, params.path);
    const buf = await readFile(abs);
    const max = params.maxBytes;
    const out = max && buf.length > max ? buf.subarray(0, max) : buf;
    const encoding = params.encoding ?? "utf8";
    return {
      path: params.path,
      encoding,
      data: encoding === "base64" ? out.toString("base64") : out.toString("utf8"),
      sizeBytes: buf.length,
      truncated: !!max && buf.length > max,
    };
  }

  async write(params: { projectId: string; worktreeId?: string; path: string; encoding?: "utf8" | "base64"; data: string; overwrite?: boolean; createDirs?: boolean }) {
    const abs = await this.resolvePath(params.projectId, params.worktreeId, params.path);
    if (params.createDirs ?? true) await mkdir(dirname(abs), { recursive: true });
    const content = params.encoding === "base64" ? Buffer.from(params.data, "base64") : Buffer.from(params.data, "utf8");
    await writeFile(abs, content, { flag: params.overwrite === false ? "wx" : "w" });
    return { path: params.path, sizeBytes: content.length, written: true as const };
  }

  async mkdir(params: { projectId: string; worktreeId?: string; path: string; recursive?: boolean }) {
    const abs = await this.resolvePath(params.projectId, params.worktreeId, params.path);
    await mkdir(abs, { recursive: params.recursive ?? true });
    return { path: params.path, created: true as const };
  }

  async stat(params: { projectId: string; worktreeId?: string; path: string }) {
    const abs = await this.resolvePath(params.projectId, params.worktreeId, params.path, false);
    return { stat: await this.lstatOne(abs, params.path) };
  }

  async list(params: { projectId: string; worktreeId?: string; path?: string; recursive?: boolean; limit?: number }) {
    const baseRel = params.path ?? ".";
    const limit = params.limit ?? 500;
    const baseAbs = await this.resolvePath(params.projectId, params.worktreeId, baseRel);
    const entries: StatEntry[] = [];
    const walk = async (absDir: string, relDir: string): Promise<void> => {
      if (entries.length >= limit) return;
      const names = await readdir(absDir);
      for (const name of names) {
        if (entries.length >= limit) return;
        const childRel = relDir === "." ? name : `${relDir}/${name}`;
        const childAbs = join(absDir, name);
        const s = await this.lstatOne(childAbs, childRel);
        entries.push(s);
        // Only descend into REAL directories. lstat reports symlinks as "symlink",
        // so symlinked dirs are never followed (also avoids symlink-cycle loops).
        if (params.recursive && s.type === "directory") await walk(childAbs, childRel);
      }
    };
    await walk(baseAbs, baseRel);
    return { path: baseRel, entries, truncated: entries.length >= limit };
  }

  private async lstatOne(abs: string, rel: string): Promise<StatEntry> {
    const s = await lstat(abs);
    const type = s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "directory" : "other";
    return { path: rel, type, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
  }
}
