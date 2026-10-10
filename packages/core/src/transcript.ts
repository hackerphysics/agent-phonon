import { appendFileSync, mkdirSync, existsSync, chmodSync, openSync, readSync, closeSync, statSync, lstatSync, renameSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
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
  private readonly bounds=new Map<string,{maxBytes:number;header:string}>();
  private gcAt=0;

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

  private loadBound(sessionId:string,file:string): void {
    if(this.bounds.has(sessionId)||!existsSync(file))return;
    const head=readHeader(file);
    try{const row=JSON.parse(head??"{}");if(row.kind==='meta'&&row.retention?.owner==='phonon-dev'&&row.sessionId===sessionId&&row.retention.maxBytes===8*1024*1024)this.bounds.set(sessionId,{maxBytes:row.retention.maxBytes,header:head+"\n"});}catch{}
  }
  private gcBounded(current:string):void{
    if(Date.now()-this.gcAt<3600000)return;this.gcAt=Date.now();
    for(const name of readdirSync(this.dir)){
      if(!/^s-[A-Za-z0-9._-]+\.jsonl(?:\.1)?$/.test(name))continue;const file=join(this.dir,name);if(file===current||file===current+'.1')continue;
      try{const st=lstatSync(file);if(!st.isFile()||Date.now()-st.mtimeMs<7*86400000)continue;
        const head=readHeader(file);const row=JSON.parse(head??'{}');
        // No inference from a filename: only explicit new Dev-owned raw traces.
        if(row.kind==='meta'&&row.retention?.owner==='phonon-dev'&&row.retention.maxBytes===8*1024*1024&&[sanitize(String(row.sessionId))+'.jsonl',sanitize(String(row.sessionId))+'.jsonl.1'].includes(name))unlinkSync(file);
      }catch{}
    }
  }

  /** 追加一行事件。kind 区分 input / event / meta。 */
  append(sessionId: string, kind: "input" | "event" | "meta", payload: unknown): void {
    const file = this.ensure(sessionId);
    const attributes=(payload as {workflowAttr?:{devTrace?:boolean}})?.workflowAttr;
    const metadata=kind==='meta'&&attributes?.devTrace?{retention:{owner:'phonon-dev',maxBytes:8*1024*1024,maxFiles:2,maxAgeDays:7}}:{};
    let line = JSON.stringify({ ...metadata,ts: new Date().toISOString(), kind, ...(payload as Record<string, unknown>) }) + "\n";
    try {
      const fresh = !existsSync(file);
      if(existsSync(file)&&lstatSync(file).isSymbolicLink())return;
      if(metadata.retention)this.bounds.set(sessionId,{maxBytes:metadata.retention.maxBytes,header:line});else this.loadBound(sessionId,file);
      const bound=this.bounds.get(sessionId);
      if(bound){
        if(Buffer.byteLength(line)>bound.maxBytes/2)line=JSON.stringify({ts:new Date().toISOString(),kind,retention_truncated:true,original_bytes:Buffer.byteLength(line)})+"\n";
        if(existsSync(file)&&statSync(file).size+Buffer.byteLength(line)>bound.maxBytes){
          const archive=file+'.1';if(existsSync(archive)){if(lstatSync(archive).isSymbolicLink())return;unlinkSync(archive);}renameSync(file,archive);writeFileSync(file,bound.header,{mode:0o600});
        }
        this.gcBounded(file);
      }
      appendFileSync(file, line);
      if (fresh) { try { chmodSync(file, 0o600); } catch { /* Windows 无 chmod */ } }
    } catch { /* best-effort：写快照失败不影响主流程 */ }
  }
}

/** 防路径穿越：sessionId 只保留安全字符（一般是 s-xxx，但兜底）。 */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readHeader(file:string):string {
 const fd=openSync(file,'r');try{const bytes=Buffer.alloc(8192);const count=readSync(fd,bytes,0,bytes.length,0);return bytes.subarray(0,count).toString('utf8').split('\n',1)[0]??'';}finally{closeSync(fd);}
}
