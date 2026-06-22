import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync, rmSync } from "node:fs";

export interface SqliteDropResult {
  filesChanged: number;
  recordsChanged: number;
  blocksRemoved: number;
  bytesBefore: number;
  bytesAfter: number;
  backups: string[];
}

export interface SqliteRow {
  /** 行主键(用于 mutateRow 定位)。 */
  id: string | number;
  /** 是否属于「工具行」(参与裁剪)。 */
  isTool: boolean;
  /**
   * 是否是「工具调用锚点」行(用于 keep-recent 计数)。
   * 不传则退化为 isTool。Hermes 里一次调用跨两行(assistant 带 tool_calls + role=tool 结果)，
   * 只有 assistant-带-tool_calls 才是锚点，避免把「保留最近 1 次调用」误算成只留结果行。
   */
  isToolCall?: boolean;
  /** 透传给 mutateRow 的任意附加字段(如 role，让 adapter 决定删行还是清列)。 */
  [k: string]: unknown;
}

/**
 * 通用「按行裁剪工具 IO」的 sqlite 压缩器，给 OpenCode / Hermes 这类把会话存进
 * sqlite 的 runtime 用。语义与 dropToolIOFromJsonlFiles 对齐：
 *  - 只动「工具行」(isTool=true)，纯文本/推理/普通消息行不碰
 *  - 保留最近 keepRecentToolCalls 个工具行(position-based，与 item 3 一致)
 *  - 旧工具行交给 mutateRow 处理：可整行删除，也可只清空工具相关列(保留同行的正文)
 *
 * 安全要点：
 *  - 用 `VACUUM INTO` 生成一致性备份(正确处理 WAL；file copy 会漏掉 -wal)
 *  - busy_timeout 等锁而非立刻失败(state.db 可能被 agent 进程并发持有)
 *  - 改动包在 IMMEDIATE 事务里，失败回滚
 *  - 不对主库做 VACUUM(独占锁、对热库不安全)；改用 best-effort wal_checkpoint
 */
export async function dropToolIORowsSqlite(opts: {
  dbPath: string;
  selectRows: (db: DatabaseSync) => SqliteRow[];
  /** 处理一条需要裁剪的旧工具行：删除整行或清空工具列。 */
  mutateRow: (db: DatabaseSync, row: SqliteRow) => void;
  keepRecentToolCalls?: number;
}): Promise<SqliteDropResult> {
  const { dbPath } = opts;
  const result: SqliteDropResult = { filesChanged: 0, recordsChanged: 0, blocksRemoved: 0, bytesBefore: 0, bytesAfter: 0, backups: [] };
  if (!existsSync(dbPath)) throw new Error(`sqlite session db not found: ${dbPath}`);
  const keepRecent = opts.keepRecentToolCalls ?? 3;
  const before = fileSize(dbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.bak-${stamp}`;

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");

    const rows = opts.selectRows(db);
    const toolIdx: number[] = [];
    const callIdx: number[] = [];
    rows.forEach((r, i) => {
      if (r.isTool) toolIdx.push(i);
      if (r.isToolCall ?? r.isTool) callIdx.push(i);
    });
    if (toolIdx.length === 0) {
      result.bytesBefore = before;
      result.bytesAfter = before;
      return result; // 无工具行可裁，不备份、不改动
    }

    // 一致性备份(含 WAL 状态)。VACUUM INTO 要求目标文件不存在。
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    result.backups.push(backup);

    // keep-recent 锚定在「工具调用」行上：保留最近 N 次调用起的所有工具行。
    const keepFromIndex = keepRecent > 0 && callIdx.length > 0
      ? callIdx[Math.max(0, callIdx.length - keepRecent)]!
      : (keepRecent > 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);

    db.exec("BEGIN IMMEDIATE");
    let removed = 0;
    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (!r.isTool) continue;
        if (i >= keepFromIndex) continue; // 最近的工具行保留
        opts.mutateRow(db, r);
        removed++;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    // 热库不做主库 VACUUM(独占锁)；best-effort 把 WAL 落盘。
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* best-effort */ }

    result.blocksRemoved = removed;
    result.recordsChanged = removed;
    result.filesChanged = removed > 0 ? 1 : 0;
    result.bytesBefore = before;
    if (removed === 0) {
      // 没实际改动：删掉刚生成的备份，保持干净。
      try { rmSync(backup, { force: true }); } catch { /* ignore */ }
      result.backups = [];
    }
    return result;
  } finally {
    try { db.close(); } catch { /* ignore */ }
    result.bytesAfter = fileSize(dbPath);
  }
}

function fileSize(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}
