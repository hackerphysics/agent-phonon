import { appendFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

/**
 * 会话快照写入器（可观测性 / 审计）。
 *
 * phonon 把每个 session 流经的事件（input + 所有 StreamEvent）追加写到
 * 自己的快照文件 `<dir>/<sessionId>.jsonl`，每行一个 JSON。
 * 这样不依赖各 agent 原生格式（claude/codex/openclaw 是 JSONL、opencode/hermes
 * 是 SQLite），一套逻辑跨平台跨 agent 通用。
 *
 * - 文件 0600 权限（含完整对话内容，可能敏感）。
 * - session terminate 后文件保留（审计资产）；只有 `sessions prune` 才删。
 * - 写失败不影响主流程（best-effort，吞错）。
 */
export class TranscriptWriter {
  private dir: string;
  private ensured = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 某 session 的快照文件路径。 */
  pathFor(sessionId: string): string {
    return join(this.dir, `${sanitize(sessionId)}.jsonl`);
  }

  /** 确保目录存在（首次写时建，0700）。返回该 session 的文件路径。 */
  ensure(sessionId: string): string {
    const file = this.pathFor(sessionId);
    if (this.ensured.has(sessionId)) return file;
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
        try { chmodSync(this.dir, 0o700); } catch { /* Windows 无 chmod */ }
      }
      this.ensured.add(sessionId);
    } catch { /* best-effort */ }
    return file;
  }

  /** 追加一行事件。kind 区分 input / event / meta。 */
  append(sessionId: string, kind: "input" | "event" | "meta", payload: unknown): void {
    const file = this.ensure(sessionId);
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...(payload as Record<string, unknown>) }) + "\n";
    try {
      const fresh = !existsSync(file);
      appendFileSync(file, line);
      if (fresh) { try { chmodSync(file, 0o600); } catch { /* Windows 无 chmod */ } }
    } catch { /* best-effort：写快照失败不影响主流程 */ }
  }
}

/** 防路径穿越：sessionId 只保留安全字符（一般是 s-xxx，但兜底）。 */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
