import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SecretBox } from "./secret-box.js";

/**
 * 本地持久化（design D6 / bug-bash B3）。
 *
 * 用 Node 原生 `node:sqlite`（Node 22.5+，零第三方依赖、免编译）。
 * daemon 重启后 projects/skills/worktrees/sessions 元数据/outbox/幂等不丢。
 *
 * v0 落这些表：projects, worktrees, skills, sessions, outbox_events,
 * idempotency, pending_interactions。tenant/inbox_queue 后续按需。
 */
export class PhononStore {
  private db: DatabaseSync;
  private dbPath: string;
  /** env 变量值 at-rest 加密(AES-256-GCM)。密钥文件与库同目录、0600。 */
  private secrets: SecretBox;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // 设备密钥：内存库用进程内随机密钥；落盘库用同目录 device.key(0600)。
    this.secrets = SecretBox.fromKeyFile(dbPath === ":memory:" ? undefined : join(dirname(dbPath), "device.key"));
    this.migrate();
  }

  /**
   * 会话快照目录：db 同目录下的 sessions/（内存库返回 undefined，不落盘）。
   */
  transcriptDir(): string | undefined {
    if (this.dbPath === ":memory:") return undefined;
    return join(dirname(this.dbPath), "sessions");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL,
        git        INTEGER NOT NULL DEFAULT 1,
        remote     TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        worktree_id TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        path        TEXT NOT NULL,
        branch      TEXT NOT NULL,
        is_primary  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id      TEXT NOT NULL,
        name          TEXT NOT NULL,
        scope         TEXT NOT NULL,
        project_id    TEXT,
        version       TEXT,
        hash          TEXT,
        installed_path TEXT NOT NULL,
        installed_at  TEXT NOT NULL,
        UNIQUE(agent_id, scope, name, project_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        project_id   TEXT,
        worktree_id  TEXT,
        agent_id     TEXT NOT NULL,
        model        TEXT NOT NULL,
        status       TEXT NOT NULL,
        verbosity    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_active  TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id  TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON outbox_events(tenant_id, session_id, seq);
      CREATE TABLE IF NOT EXISTS idempotency (
        k          TEXT PRIMARY KEY,
        result     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_interactions (
        request_id      TEXT PRIMARY KEY,
        session_id      TEXT,
        turn_id         TEXT,
        form            TEXT NOT NULL,
        status          TEXT NOT NULL,
        timeout_seconds INTEGER,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        category   TEXT NOT NULL,
        level      TEXT NOT NULL,
        event      TEXT NOT NULL,
        tenant_id  TEXT,
        session_id TEXT,
        agent_id   TEXT,
        project_id TEXT,
        turn_id    TEXT,
        msg        TEXT,
        data       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, ts);
      CREATE TABLE IF NOT EXISTS env_vars (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope      TEXT NOT NULL,
        project_id TEXT,
        agent_id   TEXT,
        skill_name TEXT,
        name       TEXT NOT NULL,
        value      TEXT NOT NULL,
        secret     INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_env_scope ON env_vars(scope, project_id, agent_id, skill_name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_env_unique ON env_vars(scope, IFNULL(project_id,''), IFNULL(agent_id,''), IFNULL(skill_name,''), name);
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id  TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        project_id   TEXT,
        worktree_id  TEXT,
        mode         TEXT NOT NULL,
        plan_json    TEXT NOT NULL,
        input        TEXT,
        policy_json  TEXT,
        shared_json  TEXT,
        status       TEXT NOT NULL,
        final_text   TEXT,
        error        TEXT,
        nodes_json   TEXT NOT NULL,
        seq          INTEGER NOT NULL DEFAULT 0,
        acked_seq    INTEGER NOT NULL DEFAULT -1,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_id, created_at);
    `);
    // 增量列迁移（幂等）：旧库已存在时 CREATE TABLE IF NOT EXISTS 不会加新列，
    // 用 PRAGMA table_info 检查后 ALTER TABLE ADD COLUMN。
    // sessions.transcript_path：phonon 自存的会话快照 JSONL 路径（可观测/审计）。
    this.ensureColumn("sessions", "transcript_path", "TEXT");
  }

  /** 幂等加列：列不存在才 ALTER TABLE ADD COLUMN。 */
  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // ---- projects ----
  upsertProject(r: { projectId: string; name: string; path: string; git: boolean; remote?: string; createdAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO projects(project_id,name,path,git,remote,created_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET name=excluded.name, path=excluded.path, git=excluded.git, remote=excluded.remote`,
      )
      .run(r.projectId, r.name, r.path, r.git ? 1 : 0, r.remote ?? null, r.createdAt);
  }
  deleteProject(projectId: string): void {
    this.db.prepare("DELETE FROM projects WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM worktrees WHERE project_id=?").run(projectId);
  }
  loadProjects(): Array<{ projectId: string; name: string; path: string; git: boolean; remote?: string; createdAt: string }> {
    return (this.db.prepare("SELECT * FROM projects").all() as Record<string, unknown>[]).map((row) => ({
      projectId: row.project_id as string,
      name: row.name as string,
      path: row.path as string,
      git: (row.git as number) === 1,
      remote: (row.remote as string) ?? undefined,
      createdAt: row.created_at as string,
    }));
  }

  // ---- worktrees ----
  upsertWorktree(r: { worktreeId: string; projectId: string; path: string; branch: string; isPrimary: boolean; createdAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO worktrees(worktree_id,project_id,path,branch,is_primary,created_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(worktree_id) DO NOTHING`,
      )
      .run(r.worktreeId, r.projectId, r.path, r.branch, r.isPrimary ? 1 : 0, r.createdAt);
  }
  deleteWorktree(worktreeId: string): void {
    this.db.prepare("DELETE FROM worktrees WHERE worktree_id=?").run(worktreeId);
  }
  loadWorktrees(): Array<{ worktreeId: string; projectId: string; path: string; branch: string; isPrimary: boolean; createdAt: string }> {
    return (this.db.prepare("SELECT * FROM worktrees").all() as Record<string, unknown>[]).map((row) => ({
      worktreeId: row.worktree_id as string,
      projectId: row.project_id as string,
      path: row.path as string,
      branch: row.branch as string,
      isPrimary: (row.is_primary as number) === 1,
      createdAt: row.created_at as string,
    }));
  }

  // ---- skills ----
  upsertSkill(r: { agent: string; name: string; scope: string; projectId?: string; version?: string; hash?: string; installedPath: string; installedAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO skills(agent_id,name,scope,project_id,version,hash,installed_path,installed_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(agent_id,scope,name,project_id) DO UPDATE SET version=excluded.version, hash=excluded.hash, installed_path=excluded.installed_path, installed_at=excluded.installed_at`,
      )
      .run(r.agent, r.name, r.scope, r.projectId ?? null, r.version ?? null, r.hash ?? null, r.installedPath, r.installedAt);
  }
  deleteSkill(r: { agent: string; name: string; scope: string; projectId?: string }): void {
    this.db
      .prepare("DELETE FROM skills WHERE agent_id=? AND name=? AND scope=? AND IFNULL(project_id,'')=IFNULL(?,'')")
      .run(r.agent, r.name, r.scope, r.projectId ?? null);
  }
  loadSkills(): Array<{ agent: string; name: string; scope: "global" | "project"; projectId?: string; version?: string; hash?: string; installedPath: string; installedAt: string }> {
    return (this.db.prepare("SELECT * FROM skills").all() as Record<string, unknown>[]).map((row) => ({
      agent: row.agent_id as string,
      name: row.name as string,
      scope: row.scope as "global" | "project",
      projectId: (row.project_id as string) ?? undefined,
      version: (row.version as string) ?? undefined,
      hash: (row.hash as string) ?? undefined,
      installedPath: row.installed_path as string,
      installedAt: row.installed_at as string,
    }));
  }

  // ---- sessions（元数据，OpenClaw 原生可 resume）----
  upsertSession(r: { sessionId: string; tenantId: string; projectId?: string; worktreeId?: string; agent: string; model: string; status: string; verbosity: string; createdAt: string; lastActive?: string; transcriptPath?: string }): void {
    this.db
      .prepare(
        `INSERT INTO sessions(session_id,tenant_id,project_id,worktree_id,agent_id,model,status,verbosity,created_at,last_active,transcript_path)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET model=excluded.model, status=excluded.status, last_active=excluded.last_active,
           transcript_path=COALESCE(excluded.transcript_path, sessions.transcript_path)`,
      )
      .run(r.sessionId, r.tenantId, r.projectId ?? null, r.worktreeId ?? null, r.agent, r.model, r.status, r.verbosity, r.createdAt, r.lastActive ?? null, r.transcriptPath ?? null);
  }
  loadSessions(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM sessions WHERE status != 'terminated'").all() as Record<string, unknown>[];
  }
  /** 列出全部 session（含 terminated）—— prune/审计用。 */
  listAllSessions(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM sessions ORDER BY COALESCE(last_active, created_at) DESC").all() as Record<string, unknown>[];
  }
  /** 删一条 session 元数据（不动快照文件，由调用方决定）。 */
  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
  }

  // ---- outbox ----
  outboxAdd(tenantId: string, sessionId: string, seq: number, payload: string, createdAt: string): void {
    this.db.prepare("INSERT INTO outbox_events(tenant_id,session_id,seq,payload,created_at) VALUES(?,?,?,?,?)").run(tenantId, sessionId, seq, payload, createdAt);
  }
  outboxAck(tenantId: string, sessionId: string | undefined, lastSeq: number): void {
    if (sessionId) this.db.prepare("DELETE FROM outbox_events WHERE tenant_id=? AND session_id=? AND seq<=?").run(tenantId, sessionId, lastSeq);
    else this.db.prepare("DELETE FROM outbox_events WHERE tenant_id=? AND seq<=?").run(tenantId, lastSeq);
  }
  outboxLoad(tenantId: string): Array<{ sessionId: string; seq: number; payload: string }> {
    return (this.db.prepare("SELECT session_id,seq,payload FROM outbox_events WHERE tenant_id=? ORDER BY seq").all(tenantId) as Record<string, unknown>[]).map((r) => ({
      sessionId: r.session_id as string,
      seq: r.seq as number,
      payload: r.payload as string,
    }));
  }

  // ---- env vars（设备本地环境变量配置，默认脱敏返回）----
  envSet(r: { scope: string; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret?: boolean; updatedAt: string }): void {
    this.envDelete(r);
    // 落库前加密 value(at-rest)。
    const stored = this.secrets.encrypt(r.value);
    this.db.prepare(
      `INSERT INTO env_vars(scope,project_id,agent_id,skill_name,name,value,secret,updated_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(r.scope, r.projectId ?? null, r.agent ?? null, r.skillName ?? null, r.name, stored, r.secret === false ? 0 : 1, r.updatedAt);
  }
  envDelete(r: { scope: string; projectId?: string; agent?: string; skillName?: string; name: string }): void {
    this.db.prepare("DELETE FROM env_vars WHERE scope=? AND IFNULL(project_id,'')=IFNULL(?,'') AND IFNULL(agent_id,'')=IFNULL(?,'') AND IFNULL(skill_name,'')=IFNULL(?,'') AND name=?")
      .run(r.scope, r.projectId ?? null, r.agent ?? null, r.skillName ?? null, r.name);
  }
  envList(filter?: { scope?: string; projectId?: string; agent?: string; skillName?: string }): Array<{ scope: string; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret: boolean; updatedAt: string }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.scope) { where.push("scope=?"); params.push(filter.scope); }
    if (filter?.projectId) { where.push("project_id=?"); params.push(filter.projectId); }
    if (filter?.agent) { where.push("agent_id=?"); params.push(filter.agent); }
    if (filter?.skillName) { where.push("skill_name=?"); params.push(filter.skillName); }
    const sql = `SELECT * FROM env_vars ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY scope, project_id, agent_id, skill_name, name`;
    return (this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map((row) => ({
      scope: row.scope as string,
      projectId: (row.project_id as string) ?? undefined,
      agent: (row.agent_id as string) ?? undefined,
      skillName: (row.skill_name as string) ?? undefined,
      name: row.name as string,
      value: this.secrets.decrypt(row.value as string),
      secret: (row.secret as number) === 1,
      updatedAt: row.updated_at as string,
    }));
  }

  close(): void {
    this.db.close();
  }

  // ---- audit 事件时间线（可观测回溯）----
  auditAdd(e: {
    ts: string; category: string; level: string; event: string;
    tenantId?: string; sessionId?: string; agentId?: string; projectId?: string; turnId?: string;
    msg?: string; data?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_events(ts,category,level,event,tenant_id,session_id,agent_id,project_id,turn_id,msg,data)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(e.ts, e.category, e.level, e.event, e.tenantId ?? null, e.sessionId ?? null, e.agentId ?? null, e.projectId ?? null, e.turnId ?? null, e.msg ?? null, e.data ?? null);
  }

  /** 查 audit 时间线（最近 N 条，可按 session/category 过滤）。 */
  auditQuery(opts?: { sessionId?: string; category?: string; limit?: number }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.sessionId) { where.push("session_id=?"); params.push(opts.sessionId); }
    if (opts?.category) { where.push("category=?"); params.push(opts.category); }
    const sql = `SELECT * FROM audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    params.push(opts?.limit ?? 200);
    return this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }

  // ---- idempotency（跨重启去重）----
  idempotencyGet(key: string): string | undefined {
    const row = this.db.prepare("SELECT result FROM idempotency WHERE k=?").get(key) as { result?: string } | undefined;
    return row?.result;
  }
  idempotencyPut(key: string, result: string): void {
    this.db.prepare("INSERT INTO idempotency(k,result,created_at) VALUES(?,?,?) ON CONFLICT(k) DO NOTHING").run(key, result, Date.now());
  }

  // ---- workflows (L3 checkpoint) ----
  upsertWorkflow(w: {
    workflowId: string; tenantId: string; projectId?: string; worktreeId?: string;
    mode: string; planJson: string; input?: string; policyJson?: string; sharedJson?: string;
    status: string; finalText?: string; error?: string; nodesJson: string;
    seq: number; ackedSeq: number; createdAt: string; updatedAt: string; completedAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO workflows(workflow_id,tenant_id,project_id,worktree_id,mode,plan_json,input,policy_json,shared_json,status,final_text,error,nodes_json,seq,acked_seq,created_at,updated_at,completed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(workflow_id) DO UPDATE SET
           status=excluded.status,
           final_text=excluded.final_text,
           error=excluded.error,
           nodes_json=excluded.nodes_json,
           seq=excluded.seq,
           acked_seq=excluded.acked_seq,
           updated_at=excluded.updated_at,
           completed_at=excluded.completed_at`,
      )
      .run(
        w.workflowId, w.tenantId, w.projectId ?? null, w.worktreeId ?? null, w.mode, w.planJson,
        w.input ?? null, w.policyJson ?? null, w.sharedJson ?? null,
        w.status, w.finalText ?? null, w.error ?? null, w.nodesJson,
        w.seq, w.ackedSeq, w.createdAt, w.updatedAt, w.completedAt ?? null,
      );
  }

  getWorkflow(workflowId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM workflows WHERE workflow_id=?").get(workflowId) as Record<string, unknown> | undefined;
  }

  listWorkflows(tenantId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM workflows WHERE tenant_id=? ORDER BY created_at DESC").all(tenantId) as Array<Record<string, unknown>>;
  }

  ackWorkflow(workflowId: string, lastSeq: number): void {
    this.db.prepare("UPDATE workflows SET acked_seq=MAX(acked_seq, ?) WHERE workflow_id=?").run(lastSeq, workflowId);
  }
}
