import { appendFileSync, mkdirSync, existsSync, chmodSync, lstatSync,openSync,readSync,closeSync,constants,fstatSync } from "node:fs";
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
 * - 所有 session 默认保留，包括 Dev 会话；不自动轮转、截断或按年龄删除。
 * - session terminate/ACK 不删除轨迹；只有用户显式删除才移除文件。
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

  /** Bounded device-owned original-turn evidence, never user-provided paths. */
  recoveryEvidence(sessionId:string,turnId:string):{turnId:string;toolCallIds:string[];observedAt:string}|undefined{
    let fd:number|undefined;
    try{
      fd=openSync(this.pathFor(sessionId),constants.O_RDONLY|constants.O_NOFOLLOW);
      const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||typeof process.getuid==="function"&&st.uid!==process.getuid()||(st.mode&0o022)!==0)return;
      const length=Math.min(st.size,2*1024*1024),buffer=Buffer.alloc(length);
      readSync(fd,buffer,0,length,st.size-length);
      const lines=buffer.toString("utf8").split("\n");if(st.size>length)lines.shift();
      const ids=new Set<string>();let observedAt:string|undefined;
      for(const line of lines){
        let row:any;try{row=JSON.parse(line);}catch{continue;}
        if(row.kind!=="event"||row.turnId!==turnId||row.event?.sessionId!==sessionId||row.event?.turnId!==turnId)continue;
        if(row.event.type!=="tool_call"||typeof row.event.toolCallId!=="string"||!/^[a-zA-Z0-9_-]{8,256}$/.test(row.event.toolCallId))continue;
        ids.add(row.event.toolCallId);if(Number.isFinite(Date.parse(row.ts)))observedAt=row.ts;
      }
      if(ids.size>=2&&ids.size<=256&&observedAt)return {turnId,toolCallIds:[...ids],observedAt};
    }catch{/* Missing historical evidence remains unconfirmed. */}
    finally{if(fd!==undefined)closeSync(fd);}
    return;
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
      if(existsSync(file)&&lstatSync(file).isSymbolicLink())return;
      // Historical retention headers and .jsonl.1 files remain untouched.
      // No per-session size/age policy is enabled by this writer.
      appendFileSync(file, line);
      if (fresh) { try { chmodSync(file, 0o600); } catch { /* Windows 无 chmod */ } }
    } catch { /* best-effort：写快照失败不影响主流程 */ }
  }
}

/** 防路径穿越：sessionId 只保留安全字符（一般是 s-xxx，但兜底）。 */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
