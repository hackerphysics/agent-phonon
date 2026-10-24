import { DatabaseSync } from "node:sqlite";
import {randomUUID} from "node:crypto";
import { mkdirSync,existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { deliveryOptions, DeliveryCapacity, type DeliveryConfig, type DeliveryChannel, type DeliveryPending } from "./delivery-capacity.js";
import { SecretBox } from "./secret-box.js";
import { ConversationArchive } from "./conversation-archive.js";
import { PeerContextJournal } from "./peer-context.js";
import { PhononError } from "./rpc.js";
import {canonicalWorkspacePath,workspacePathKey,assertNamespacePathAvailable,assertNamespaceBrowsePath,type NamespacePath} from "./workspace-paths.js";
import {requestFingerprint} from "./idempotency.js";
import {SkillInstallFenceResult,type SkillInstallFenceParams,type SkillInstallRecoveryContext} from "@agent-phonon/protocol";

export interface StoredSkillRecord {
  agent:string;name:string;scope:"project"|"global";projectId?:string;version?:string;hash?:string;installedPath:string;installedAt:string;revision?:string;
  publication?:{kind:"immutable";versionId:string;treeHash:string};
}

export interface StoredSkillInstall {
  tenant_id:string;request_id:string;request_hash:string;agent_id:string;name:string;scope:"project"|"global";project_id:string|null;
  receiver_id:string|null;
  fence_id:string|null;
  state:"prepared"|"dispatched"|"confirmed"|"failed"|"unknown";resource_key:string|null;owner_id:string|null;result_json:string|null;created_at:string;updated_at:string;
}

/**
 * 本地持久化（design D6 / bug-bash B3）。
 *
 * 用 Node 原生 `node:sqlite`（Node 22.5+，零第三方依赖、免编译）。
 * daemon 重启后 projects/skills/worktrees/sessions 元数据/outbox/幂等不丢。
 *
 * 主要表：projects, worktrees, skills, sessions, outbox_events/outbox_acks,
 * connection_tenants, idempotency, pending_interactions。tenant/inbox_queue 后续按需。
 */
export class PhononStore {
  readonly activeCompressions = new Set<string>();
  readonly activeSessionControls = new Set<string>();
  readonly activeSkillInstalls = new Set<string>();
  private db: DatabaseSync;
  private dbPath: string;
  private archives?: ConversationArchive;
  private peers?: PeerContextJournal;
  /** env 变量值 at-rest 加密(AES-256-GCM)。密钥文件与库同目录、0600。 */
  private secrets: SecretBox;

  readonly delivery: DeliveryCapacity;

  constructor(dbPath: string, opts?: { delivery?: Partial<DeliveryConfig> }) {
    const delivery = deliveryOptions(opts?.delivery);
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // 设备密钥：内存库用进程内随机密钥；落盘库用同目录 device.key(0600)。
    this.secrets = SecretBox.fromKeyFile(dbPath === ":memory:" ? undefined : join(dirname(dbPath), "device.key"));
    this.migrate();
    this.migrateDeliveryAccounting();
    this.delivery = new DeliveryCapacity(() => this.deliveryPending(), delivery);
    this.delivery.snapshot();
  }

  /**
   * 会话快照目录：db 同目录下的 sessions/（内存库返回 undefined，不落盘）。
   */
  transcriptDir(): string | undefined {
    if (this.dbPath === ":memory:") return undefined;
    return join(dirname(this.dbPath), "sessions");
  }
  get supportsConversationArchives(): boolean { return this.dbPath !== ":memory:"; }
  peerContextJournal(): PeerContextJournal {
    return this.peers ??= new PeerContextJournal(this.dbPath === ":memory:" ? ":memory:" : this.dbPath + ".peers.sqlite");
  }
  hasPeerContextJournal():boolean{return !!this.peers||this.dbPath!==":memory:"&&existsSync(this.dbPath+".peers.sqlite");}
  get supportsDurableSkillInstalls():boolean{return this.dbPath!==":memory:";}
  projectProvisionPath():string|undefined{return this.dbPath===":memory:"?undefined:this.dbPath+".projects.sqlite";}
  conversationArchives(): ConversationArchive {
    if (!this.supportsConversationArchives) throw new PhononError("errArchiveUnavailable", "conversation archives require a persistent device database");
    try { return this.archives ??= new ConversationArchive(this.dbPath + ".conversations.sqlite"); }
    catch (error) { if (error instanceof PhononError) throw error; throw new PhononError("errArchiveUnavailable"); }
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
      CREATE TABLE IF NOT EXISTS workflow_cancel_intents (
        tenant_id TEXT NOT NULL, dispatch_key TEXT NOT NULL, project_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(tenant_id,dispatch_key)
      );
      CREATE TABLE IF NOT EXISTS outbox_acks (
        tenant_id  TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_seq   INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS connection_tenants (
        server_url TEXT PRIMARY KEY,
        tenant_id  TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS interaction_receipts (
        tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT, decision_hash TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY(tenant_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS employee_profiles (
        tenant_id TEXT NOT NULL,employee_id TEXT NOT NULL,document TEXT NOT NULL,
        PRIMARY KEY(tenant_id,employee_id)
      );
      CREATE TABLE IF NOT EXISTS compression_receipts (
        tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, session_id TEXT NOT NULL,
        state TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(tenant_id,operation_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS compression_one_active ON compression_receipts(tenant_id,session_id)
        WHERE state IN ('running','unknown');
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
        tenant_id  TEXT,
        scope      TEXT NOT NULL,
        project_id TEXT,
        agent_id   TEXT,
        skill_name TEXT,
        name       TEXT NOT NULL,
        value      TEXT NOT NULL,
        secret     INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS workflow_input_receipts (
        tenant_id TEXT NOT NULL,workflow_id TEXT NOT NULL,input_id TEXT NOT NULL,request_hash TEXT NOT NULL,
        node_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN('inserting','inserted','unknown')),error_code TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,workflow_id,input_id),
        FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workflow_events (
        workflow_id TEXT NOT NULL,
        tenant_id   TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (workflow_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events_tenant ON workflow_events(tenant_id, workflow_id, seq);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id      TEXT NOT NULL,
        tenant_id   TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_tenant ON run_events(tenant_id, run_id, seq);
      CREATE TABLE IF NOT EXISTS schedules (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        name        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        trigger_json TEXT NOT NULL,
        target_json TEXT NOT NULL,
        consent_json TEXT NOT NULL,
        policy_json TEXT,
        webhook_token TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_webhook ON schedules(webhook_token);
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        schedule_id   TEXT NOT NULL,
        tenant_id     TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        status        TEXT NOT NULL,
        session_id    TEXT,
        workflow_id   TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        exit_reason   TEXT,
        error         TEXT,
        transcript_path TEXT,
        result_text   TEXT,
        usage_json    TEXT,
        push_state    TEXT NOT NULL DEFAULT 'pending',
        acked_seq     INTEGER NOT NULL DEFAULT -1,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_schedule ON runs(schedule_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_tenant ON runs(tenant_id, created_at);
    `);
    // 增量列迁移（幂等）：旧库已存在时 CREATE TABLE IF NOT EXISTS 不会加新列，
    // 用 PRAGMA table_info 检查后 ALTER TABLE ADD COLUMN。
    // sessions.transcript_path：phonon 自存的会话快照 JSONL 路径（可观测/审计）。
    this.ensureColumn("sessions", "transcript_path", "TEXT");
    this.ensureColumn("projects","directory_identity","TEXT");
    // Keep fingerprints out of the unrestricted request-key namespace. Legacy
    // results/ambiguous old sidecar rows are retained without guessing a hash.
    this.ensureColumn("idempotency", "request_hash", "TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS skill_install_operations(
      tenant_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,
      agent_id TEXT NOT NULL,name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('project','global')),project_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','confirmed','failed','unknown')),
      resource_key TEXT,owner_id TEXT,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS skill_install_resource_active ON skill_install_operations(resource_key)
      WHERE resource_key IS NOT NULL AND state IN ('dispatched','unknown')`);
    this.ensureColumn("skill_install_operations","receiver_id","TEXT");
    this.ensureColumn("skill_install_operations","fence_id","TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS skill_receivers(tenant_id TEXT PRIMARY KEY,receiver_id TEXT NOT NULL UNIQUE);
      CREATE TRIGGER IF NOT EXISTS skill_receiver_update_immutable BEFORE UPDATE ON skill_receivers BEGIN SELECT RAISE(ABORT,'skill receiver identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS skill_receiver_delete_immutable BEFORE DELETE ON skill_receivers BEGIN SELECT RAISE(ABORT,'skill receiver identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS skill_install_receiver_immutable BEFORE UPDATE OF receiver_id ON skill_install_operations
      WHEN NEW.receiver_id IS NOT OLD.receiver_id BEGIN SELECT RAISE(ABORT,'skill install receiver proof is immutable'); END`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS skill_install_fences(
      tenant_id TEXT NOT NULL,request_id TEXT NOT NULL,original_request_id TEXT NOT NULL,request_hash TEXT NOT NULL,fence_id TEXT NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(tenant_id,request_id),UNIQUE(tenant_id,original_request_id));
      CREATE TRIGGER IF NOT EXISTS skill_fence_receipt_immutable BEFORE UPDATE ON skill_install_fences BEGIN SELECT RAISE(ABORT,'skill fence receipt is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS skill_fence_receipt_delete_immutable BEFORE DELETE ON skill_install_fences BEGIN SELECT RAISE(ABORT,'skill fence receipt is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS skill_install_fence_immutable BEFORE UPDATE OF fence_id ON skill_install_operations
      WHEN OLD.fence_id IS NOT NULL AND NEW.fence_id IS NOT OLD.fence_id BEGIN SELECT RAISE(ABORT,'skill installation fence is immutable'); END`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS skill_project_roots(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,path TEXT NOT NULL,root_identity TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,project_id));
      CREATE TABLE IF NOT EXISTS managed_skill_versions(installation_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,name TEXT NOT NULL,record_json TEXT NOT NULL,execution_json TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS managed_skill_versions_scope ON managed_skill_versions(tenant_id,project_id,name);
      CREATE TABLE IF NOT EXISTS skill_selection_history(id INTEGER PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,name TEXT NOT NULL,request_id TEXT NOT NULL,records_json TEXT NOT NULL,created_at TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_resume_dispatches (
      tenant_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      workflow_id TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(tenant_id,request_key)
    )`);
    // stream_seq 保存“下一条 stream.event 的 seq”。旧库从 outbox 最大值兜底恢复；
    // 新事件在发送前推进此值，确保全部 ACK 后重启也不会从 0 碰撞。
    this.ensureColumn("sessions", "stream_seq", "INTEGER NOT NULL DEFAULT 0");
    // L4 retry audit：旧库增量升级时保留既有 run 数据。
    this.ensureColumn("runs", "attempt", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "max_attempts", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("runs", "retry_history_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("runs", "dispatch_json", "TEXT");
    // L3 recovery ownership + durable mode cursor. owner_epoch is a fencing
    // token: a replaced connection can no longer overwrite its successor.
    this.ensureColumn("workflows", "checkpoint_json", "TEXT");
    this.ensureColumn("workflows", "owner_id", "TEXT");
    this.ensureColumn("workflows", "owner_epoch", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("workflows", "lease_until", "INTEGER");
    // Nullable legacy namespace is deliberately not guessed/backfilled.
    this.ensureColumn("projects", "namespace", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS projects_directory_reference ON projects(namespace,path) WHERE directory_identity IS NOT NULL AND substr(project_id,1,4)='dir-'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_path_owners(
      path_key TEXT PRIMARY KEY,path TEXT NOT NULL,namespace TEXT NOT NULL,created_at TEXT NOT NULL)`);
    // Legacy skill provenance remains unknown. Project visibility can be
    // proven through its current namespace; global rows cannot be inferred.
    this.ensureColumn("skills", "tenant_id", "TEXT");
    this.ensureColumn("skills", "execution_json", "TEXT");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS skills_tenant_identity
      ON skills(tenant_id,agent_id,scope,name,IFNULL(project_id,'')) WHERE tenant_id IS NOT NULL`);
    this.ensureColumn("projects", "employee_id", "TEXT");
    this.ensureColumn("sessions", "employee_id", "TEXT");
    this.ensureColumn("sessions", "employee_revision", "INTEGER");
    this.ensureColumn("sessions", "recovery_json", "TEXT");
    this.ensureColumn("sessions", "native_stop_json", "TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_native_owners(
      tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,owner_instance TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK(owner_pid>0),PRIMARY KEY(tenant_id,session_id))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_upstream_runs(
      tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,upstream_id TEXT NOT NULL,
      PRIMARY KEY(tenant_id,session_id,upstream_id),FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS native_proactive_seen(
      tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,upstream_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
      seq INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,session_id,upstream_id),
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE)`);
    this.ensureColumn("workflows", "metadata_json", "TEXT");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_dispatch_identity ON workflows(tenant_id,json_extract(metadata_json,'$._phononDispatch.key')) WHERE json_extract(metadata_json,'$._phononDispatch.key') IS NOT NULL`);

    this.ensureColumn("runs", "input_json", "TEXT");
    this.ensureColumn("runs", "phase", "TEXT");
    this.ensureColumn("runs", "retry_at", "INTEGER");
    this.ensureColumn("runs", "owner_id", "TEXT");
    this.ensureColumn("runs", "owner_epoch", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "lease_until", "INTEGER");
    this.ensureColumn("runs", "event_seq", "INTEGER NOT NULL DEFAULT 0");
    // 旧版本允许重复行。先确定性保留最早一条，再建立真正的幂等唯一约束。
    this.db.exec(`
      DELETE FROM outbox_events
       WHERE id NOT IN (
         SELECT MIN(id) FROM outbox_events GROUP BY tenant_id, session_id, seq
       );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_unique
        ON outbox_events(tenant_id, session_id, seq);
    `);
    // env_vars.tenant_id 必须保持 nullable：升级前的行没有可证明的 tenant
    // 归属，留作隔离区，绝不能静默分配或作为所有 tenant 的共享兜底。
    this.ensureColumn("env_vars", "tenant_id", "TEXT");
    // 旧索引不含 tenant_id，会让不同 tenant 的同名变量互相冲突；迁移时
    // 原地重建。NULL tenant 的 legacy 行仍留库，但所有 API 都要求 tenant_id=?。
    this.db.exec(`
      DROP INDEX IF EXISTS idx_env_scope;
      DROP INDEX IF EXISTS idx_env_unique;
      CREATE INDEX idx_env_scope ON env_vars(tenant_id, scope, project_id, agent_id, skill_name);
      CREATE UNIQUE INDEX idx_env_unique ON env_vars(tenant_id, scope, IFNULL(project_id,''), IFNULL(agent_id,''), IFNULL(skill_name,''), name);
    `);
  }

  /** Reconcile once on open. Incremental triggers keep accounting in the same
   * transaction as source events and ACKs, with no payload scan per token. */
  private migrateDeliveryAccounting(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS delivery_totals (
          channel TEXT PRIMARY KEY, pending_count INTEGER NOT NULL, pending_bytes INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO delivery_totals VALUES ('stream',0,0),('workflow',0,0),('run',0,0);
        CREATE TABLE IF NOT EXISTS delivery_pending (
          channel TEXT NOT NULL, tenant_id TEXT NOT NULL, entity_id TEXT NOT NULL,
          seq INTEGER NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(channel,tenant_id,entity_id,seq)
        );
        CREATE TRIGGER IF NOT EXISTS delivery_counter_insert AFTER INSERT ON delivery_pending BEGIN
          UPDATE delivery_totals SET pending_count=pending_count+1,pending_bytes=pending_bytes+NEW.bytes WHERE channel=NEW.channel;
        END;
        CREATE TRIGGER IF NOT EXISTS delivery_counter_delete AFTER DELETE ON delivery_pending BEGIN
          UPDATE delivery_totals SET pending_count=pending_count-1,pending_bytes=pending_bytes-OLD.bytes WHERE channel=OLD.channel;
        END;
      `);
      const channels = [
        ["stream", "outbox_events", "session_id", "outbox_acks", "session_id", "last_seq"],
        ["workflow", "workflow_events", "workflow_id", "workflows", "workflow_id", "acked_seq"],
        ["run", "run_events", "run_id", "runs", "id", "acked_seq"],
      ];
      for (const [channel, table, id, parent, parentId, watermark] of channels) {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS delivery_${channel}_insert AFTER INSERT ON ${table}
          WHEN NEW.seq>COALESCE((SELECT ${watermark} FROM ${parent} WHERE ${parentId}=NEW.${id} AND tenant_id=NEW.tenant_id),-1) BEGIN
            INSERT OR IGNORE INTO delivery_pending VALUES ('${channel}',NEW.tenant_id,NEW.${id},NEW.seq,length(CAST(NEW.payload AS BLOB)));
          END;
          CREATE TRIGGER IF NOT EXISTS delivery_${channel}_delete AFTER DELETE ON ${table} BEGIN
            DELETE FROM delivery_pending WHERE channel='${channel}' AND tenant_id=OLD.tenant_id AND entity_id=OLD.${id} AND seq=OLD.seq;
          END;
          CREATE TRIGGER IF NOT EXISTS delivery_${channel}_ack_insert AFTER INSERT ON ${parent} BEGIN
            DELETE FROM delivery_pending WHERE channel='${channel}' AND tenant_id=NEW.tenant_id AND entity_id=NEW.${parentId} AND seq<=NEW.${watermark};
          END;
          CREATE TRIGGER IF NOT EXISTS delivery_${channel}_ack_update AFTER UPDATE OF ${watermark} ON ${parent} BEGIN
            DELETE FROM delivery_pending WHERE channel='${channel}' AND tenant_id=NEW.tenant_id AND entity_id=NEW.${parentId} AND seq<=NEW.${watermark};
          END;
        `);
      }
      this.db.exec("DELETE FROM delivery_pending; UPDATE delivery_totals SET pending_count=0,pending_bytes=0;");
      for (const [channel, table, id, parent, parentId, watermark] of channels) {
        // Orphan legacy events are conservatively counted, never discarded.
        this.db.exec(`INSERT INTO delivery_pending
          SELECT '${channel}',e.tenant_id,e.${id},e.seq,length(CAST(e.payload AS BLOB))
          FROM ${table} e LEFT JOIN ${parent} p ON p.${parentId}=e.${id} AND p.tenant_id=e.tenant_id
          WHERE e.seq>COALESCE(p.${watermark},-1)`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  private deliveryPending(): Record<DeliveryChannel, DeliveryPending> {
    const result = {} as Record<DeliveryChannel, DeliveryPending>;
    for (const row of this.db.prepare("SELECT * FROM delivery_totals").all() as Array<{ channel: DeliveryChannel; pending_count: number; pending_bytes: number }>) {
      result[row.channel] = { count: row.pending_count, bytes: row.pending_bytes };
    }
    return result;
  }

  /** Failure stays observable even when SQLite cannot store an audit row. */
  private deliveryWrite<T>(fn: () => T, refresh = true): T {
    try {
      const result = fn();
      if (refresh) this.delivery.snapshot();
      return result;
    } catch (error) {
      this.delivery.failed();
      throw error;
    }
  }

  /** 幂等加列：列不存在才 ALTER TABLE ADD COLUMN。 */
  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // ---- projects ----
  upsertProject(r: { projectId: string; name: string; path: string; git: boolean; remote?: string; createdAt: string; namespace?: string; employeeId?:string;directoryIdentity?:string }): void {
    this.db
      .prepare(
        `INSERT INTO projects(project_id,name,path,git,remote,created_at,namespace,employee_id,directory_identity)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET name=excluded.name, path=excluded.path, git=excluded.git, remote=excluded.remote,
         directory_identity=COALESCE(projects.directory_identity,excluded.directory_identity)`,
      )
      .run(r.projectId, r.name, r.path, r.git ? 1 : 0, r.remote ?? null, r.createdAt, r.namespace ?? null,r.employeeId??null,r.directoryIdentity??null);
  }
  deleteProject(projectId: string): void {
    this.db.prepare("DELETE FROM projects WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM worktrees WHERE project_id=?").run(projectId);
  }
  loadProjects(): Array<{ projectId: string; name: string; path: string; git: boolean; remote?: string; createdAt: string; namespace?: string; employeeId?:string;directoryIdentity?:string }> {
    return (this.db.prepare("SELECT * FROM projects").all() as Record<string, unknown>[]).map((row) => ({
      projectId: row.project_id as string,
      name: row.name as string,
      path: row.path as string,
      git: (row.git as number) === 1,
      remote: (row.remote as string) ?? undefined,
      createdAt: row.created_at as string,
      namespace: (row.namespace as string) ?? undefined,
      employeeId:(row.employee_id as string)??undefined,
      directoryIdentity:(row.directory_identity as string)??undefined,
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

  private namespacePaths():NamespacePath[]{
    return (this.db.prepare(`SELECT path,namespace,NULL path_key FROM projects
      UNION ALL SELECT w.path,p.namespace,NULL FROM worktrees w LEFT JOIN projects p ON p.project_id=w.project_id
      UNION ALL SELECT path,namespace,path_key FROM project_path_owners`).all() as Array<Record<string,unknown>>)
      .map(row=>({path:String(row.path),namespace:row.namespace==null?undefined:String(row.namespace),key:row.path_key==null?undefined:String(row.path_key)}));
  }
  assertWorkspacePath(path:string,namespace:string):void{
    assertNamespacePathAvailable(canonicalWorkspacePath(path),namespace,this.namespacePaths());
  }
  assertWorkspaceBrowsePath(path:string,namespace:string):void{
    assertNamespaceBrowsePath(canonicalWorkspacePath(path),namespace,this.namespacePaths());
  }
  reserveWorkspacePath(path:string,namespace:string):void{
    if(!namespace)throw new PhononError("errInvalidParams","workspace namespace is required");
    const canonical=canonicalWorkspacePath(path);
    // Commit ownership before asynchronous mkdir/git operations. Retain it on
    // uncertain failures or metadata removal; neither transfers existing files.
    this.db.exec("BEGIN IMMEDIATE");
    try{
      assertNamespacePathAvailable(canonical,namespace,this.namespacePaths());
      this.db.prepare("INSERT INTO project_path_owners(path_key,path,namespace,created_at) VALUES(?,?,?,?) ON CONFLICT(path_key) DO NOTHING")
        .run(workspacePathKey(canonical),canonical,namespace,new Date().toISOString());
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  // ---- skills ----
  skillReceiverIdentity(tenant:string,create=true):string|undefined{
    if(!this.supportsDurableSkillInstalls)return undefined;
    const current=this.db.prepare("SELECT receiver_id FROM skill_receivers WHERE tenant_id=?").get(tenant) as {receiver_id:string}|undefined;
    if(current)return current.receiver_id;
    if(!create)return undefined;
    this.db.prepare("INSERT INTO skill_receivers(tenant_id,receiver_id) VALUES(?,?) ON CONFLICT(tenant_id) DO NOTHING").run(tenant,randomUUID());
    return (this.db.prepare("SELECT receiver_id FROM skill_receivers WHERE tenant_id=?").get(tenant) as {receiver_id:string}).receiver_id;
  }
  skillInstallOperation(tenant:string,requestId:string):StoredSkillInstall|undefined{
    return this.db.prepare("SELECT * FROM skill_install_operations WHERE tenant_id=? AND request_id=?").get(tenant,requestId) as StoredSkillInstall|undefined;
  }
  assertSkillInstallUnfenced(tenant:string,requestId:string):void{
    if(this.skillInstallOperation(tenant,requestId)?.fence_id!=null)throw new PhononError("errSkillInstallUnconfirmed","the original skill transaction is fenced; its outcome remains unknown");
  }
  skillRecoveryContext(tenant:string,row:StoredSkillInstall):SkillInstallRecoveryContext|undefined{
    if(row.tenant_id!==tenant)throw new PhononError("errPolicyDenied");
    const receiverID=this.skillReceiverIdentity(tenant,false);if(!receiverID||row.scope!=="project")return undefined;
    const revision=requestFingerprint({schema:1,receiverID,operation:row,selection:this.skillSelectionRevision(tenant,row.name,row.scope,row.project_id??undefined)});
    return {revision,receiverID,originalReceiverID:row.receiver_id,fenced:row.fence_id!==null,...(row.fence_id?{fenceID:row.fence_id}:{})};
  }
  fenceSkillInstall(tenant:string,input:SkillInstallFenceParams):SkillInstallFenceResult{
    const fingerprint=requestFingerprint(input);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(!this.supportsDurableSkillInstalls||this.skillReceiverIdentity(tenant,false)!==input.expectedReceiverID)throw new PhononError("errSkillInstallUnconfirmed","skill recovery receiver changed");
      if(!this.db.prepare("SELECT 1 FROM projects WHERE project_id=? AND namespace=?").get(input.projectId,tenant))throw new PhononError("errProjectNotFound");
      const row=this.skillInstallOperation(tenant,input.originalRequestId);
      if(!row||row.agent_id!==input.agent||row.name!==input.name||row.scope!=="project"||row.project_id!==input.projectId)throw new PhononError("errSkillNotFound");
      if(row.receiver_id!==null&&row.receiver_id!==input.expectedReceiverID)throw new PhononError("errSkillInstallUnconfirmed","the original receiver binding differs");
      const prior=this.db.prepare("SELECT request_hash,result_json FROM skill_install_fences WHERE tenant_id=? AND request_id=?").get(tenant,input.clientRequestId) as {request_hash:string;result_json:string}|undefined;
      if(prior){
        if(prior.request_hash!==fingerprint)throw new PhononError("errInvalidParams","skill recovery identity changed");
        const result=SkillInstallFenceResult.parse(JSON.parse(prior.result_json));
        if(result.clientRequestId!==input.clientRequestId||result.originalRequestId!==input.originalRequestId||result.agent!==input.agent||result.name!==input.name||result.projectId!==input.projectId
          ||result.receiverID!==input.expectedReceiverID||result.originalReceiverID!==row.receiver_id||result.fenceID!==row.fence_id)throw new PhononError("errSkillInstallUnconfirmed","the original recovery receipt differs");
        this.db.exec("COMMIT");return result;
      }
      if(this.skillRecoveryContext(tenant,row)?.revision!==input.baseRecoveryRevision)throw new PhononError("errSkillRevisionChanged","skill recovery observation changed");
      if(row.fence_id!==null||!["dispatched","unknown"].includes(row.state)||!row.resource_key||!/^[a-f0-9]{64}$/.test(row.resource_key))
        throw new PhononError("errSkillInstallUnconfirmed","only a claimed uncertain transaction can be fenced");
      const fenceID=randomUUID(),recordedAt=new Date().toISOString();
      const changed=this.db.prepare(`UPDATE skill_install_operations SET state='unknown',fence_id=?,updated_at=? WHERE tenant_id=? AND request_id=?
        AND state IN ('dispatched','unknown') AND fence_id IS NULL`).run(fenceID,recordedAt,tenant,input.originalRequestId);
      if(changed.changes!==1)throw new PhononError("errSkillInstallUnconfirmed","skill recovery claim changed");
      const result:SkillInstallFenceResult={clientRequestId:input.clientRequestId,originalRequestId:input.originalRequestId,agent:input.agent,name:input.name,scope:"project",projectId:input.projectId,
        receiverID:input.expectedReceiverID,originalReceiverID:row.receiver_id,fenceID,disposition:"unconfirmed_metadata_fenced",outcomeKnown:false,targetLocked:true,filesDeleted:false,originalWritesMayContinue:true,recordedAt};
      this.db.prepare("INSERT INTO skill_install_fences(tenant_id,request_id,original_request_id,request_hash,fence_id,result_json) VALUES(?,?,?,?,?,?)")
        .run(tenant,input.clientRequestId,input.originalRequestId,fingerprint,fenceID,JSON.stringify(result));
      this.db.exec("COMMIT");return result;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  prepareSkillInstall(input:{tenant:string;requestId:string;requestHash:string;agent:string;name:string;scope:"project"|"global";projectId?:string}):StoredSkillInstall{
    const now=new Date().toISOString();
    this.db.prepare(`INSERT INTO skill_install_operations(tenant_id,request_id,request_hash,agent_id,name,scope,project_id,state,created_at,updated_at,receiver_id)
      VALUES(?,?,?,?,?,?,?,'prepared',?,?,?) ON CONFLICT(tenant_id,request_id) DO NOTHING`)
      .run(input.tenant,input.requestId,input.requestHash,input.agent,input.name,input.scope,input.scope==="project"?input.projectId??null:null,now,now,this.skillReceiverIdentity(input.tenant)??null);
    return this.skillInstallOperation(input.tenant,input.requestId)!;
  }
  claimSkillInstall(tenant:string,requestId:string,requestHash:string,resourceKey:string,owner:string):boolean{
    return this.db.prepare(`UPDATE skill_install_operations SET state='dispatched',resource_key=?,owner_id=?,updated_at=?
      WHERE tenant_id=? AND request_id=? AND request_hash=? AND state='prepared' AND fence_id IS NULL`)
      .run(resourceKey,owner,new Date().toISOString(),tenant,requestId,requestHash).changes===1;
  }
  failSkillInstallPreparation(tenant:string,requestId:string,requestHash:string):void{
    this.db.prepare(`UPDATE skill_install_operations SET state='failed',updated_at=? WHERE tenant_id=? AND request_id=? AND request_hash=? AND state='prepared'`)
      .run(new Date().toISOString(),tenant,requestId,requestHash);
  }
  unconfirmSkillInstall(tenant:string,requestId:string,owner:string):void{
    this.db.prepare(`UPDATE skill_install_operations SET state='unknown',updated_at=? WHERE tenant_id=? AND request_id=? AND owner_id=? AND state='dispatched'`)
      .run(new Date().toISOString(),tenant,requestId,owner);
  }
  assertSkillTargetWritable(resourceKey:string,owner?:string):void{
    const row=this.db.prepare("SELECT owner_id,state FROM skill_install_operations WHERE resource_key=? AND state IN ('dispatched','unknown')")
      .get(resourceKey) as {owner_id:string;state:string}|undefined;
    if(row&&(!owner||row.owner_id!==owner||row.state!=="dispatched"))throw new PhononError("errSkillInstallUnconfirmed","an earlier skill write is active or unconfirmed; do not retry with another identity");
  }
  private skillSelectionRows(tenant:string,name:string,scope:"project"|"global",projectId?:string):Record<string,unknown>[] {
    return this.db.prepare(`SELECT agent_id,name,scope,project_id,version,hash,installed_path,installed_at,tenant_id,execution_json FROM skills
      WHERE name=? AND scope=? AND IFNULL(project_id,'')=IFNULL(?,'') AND(tenant_id=? OR(tenant_id IS NULL AND scope='project'
        AND EXISTS(SELECT 1 FROM projects p WHERE p.project_id=skills.project_id AND p.namespace=?))) ORDER BY agent_id`)
      .all(name,scope,scope==="project"?projectId??null:null,tenant,tenant) as Record<string,unknown>[];
  }
  skillSelectionRevision(tenant:string,name:string,scope:"project"|"global",projectId?:string):string|null{
    const rows=this.skillSelectionRows(tenant,name,scope,projectId);return rows.length?requestFingerprint(rows):null;
  }
  pinSkillProjectRoot(tenant:string,projectId:string,path:string,identity:string):void{
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(!this.db.prepare("SELECT 1 FROM projects WHERE project_id=? AND namespace=? AND path=?").get(projectId,tenant,path))throw new PhononError("errProjectNotFound");
      const previous=this.db.prepare("SELECT path,root_identity FROM skill_project_roots WHERE tenant_id=? AND project_id=?").get(tenant,projectId) as {path:string;root_identity:string}|undefined;
      if(previous&&(previous.path!==path||previous.root_identity!==identity)||this.db.prepare("SELECT 1 FROM skill_project_roots WHERE root_identity=? AND tenant_id<>?").get(identity,tenant))
        throw new PhononError("errSkillScopeInvalid","skill Project root identity changed or has another namespace");
      this.db.prepare("INSERT INTO skill_project_roots(tenant_id,project_id,path,root_identity,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(tenant,projectId,path,identity,new Date().toISOString());
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  assertSkillProjectRoot(tenant:string,projectId:string,path:string,identity:string):void{
    if(!this.db.prepare("SELECT 1 FROM skill_project_roots WHERE tenant_id=? AND project_id=? AND path=? AND root_identity=?").get(tenant,projectId,path,identity))
      throw new PhononError("errSkillScopeInvalid","skill Project root binding is not current");
  }
  managedSkillVersion(tenant:string,id:string):{project_id:string;name:string;record_json:string;execution_json:string;revoked_at:string|null}|undefined{
    return this.db.prepare("SELECT project_id,name,record_json,execution_json,revoked_at FROM managed_skill_versions WHERE tenant_id=? AND installation_id=?").get(tenant,id) as {project_id:string;name:string;record_json:string;execution_json:string;revoked_at:string|null}|undefined;
  }
  hasLiveManagedSkillVersions(tenant:string,project:string,name:string):boolean{
    return !!this.db.prepare("SELECT 1 FROM managed_skill_versions WHERE tenant_id=? AND project_id=? AND name=? AND revoked_at IS NULL LIMIT 1").get(tenant,project,name);
  }
  private archiveSkillSelection(tenant:string,projectId:string,name:string,requestId:string):void{
    this.db.prepare("INSERT INTO skill_selection_history(tenant_id,project_id,name,request_id,records_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(tenant,projectId,name,requestId,JSON.stringify(this.skillSelectionRows(tenant,name,"project",projectId)),new Date().toISOString());
    this.db.prepare("DELETE FROM skills WHERE scope='project' AND project_id=? AND name=? AND(tenant_id=? OR tenant_id IS NULL)").run(projectId,name,tenant);
  }
  unpublishSkill(tenant:string,input:{clientRequestId:string;projectId:string;name:string;baseRevision:string},resourceKey:string,fingerprint:string):{projectId:string;name:string;deactivated:true;previousRevision:string}{
    const key=tenant+"\0skill.unpublish\0"+input.clientRequestId;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(!this.db.prepare("SELECT 1 FROM projects WHERE project_id=? AND namespace=?").get(input.projectId,tenant))throw new PhononError("errProjectNotFound");
      const prior=this.idempotencyGet(key);
      if(prior!==undefined){if(this.idempotencyFingerprint(key)!==fingerprint)throw new PhononError("errInvalidParams","unpublish identity changed");this.db.exec("COMMIT");return JSON.parse(prior);}
      this.assertSkillTargetWritable(resourceKey);
      if(this.skillSelectionRevision(tenant,input.name,"project",input.projectId)!==input.baseRevision)throw new PhononError("errSkillRevisionChanged","skill selection changed");
      this.archiveSkillSelection(tenant,input.projectId,input.name,input.clientRequestId);
      this.db.prepare("UPDATE managed_skill_versions SET revoked_at=? WHERE tenant_id=? AND project_id=? AND name=? AND revoked_at IS NULL").run(new Date().toISOString(),tenant,input.projectId,input.name);
      const result={projectId:input.projectId,name:input.name,deactivated:true as const,previousRevision:input.baseRevision};
      this.db.prepare("INSERT INTO idempotency(k,result,created_at,request_hash) VALUES(?,?,?,?)").run(key,JSON.stringify(result),Date.now(),fingerprint);
      this.db.exec("COMMIT");return result;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  confirmSkillInstall(tenant:string,requestId:string,owner:string,record:StoredSkillRecord,executionJson?:string,expectedRevision?:string|null):StoredSkillRecord{
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const row=this.skillInstallOperation(tenant,requestId);
      if(!row||row.state!=="dispatched"||row.fence_id!==null||row.owner_id!==owner||row.agent_id!==record.agent||row.name!==record.name||row.scope!==record.scope||row.project_id!==(record.projectId??null))
        throw new PhononError("errSkillInstallUnconfirmed","skill installation claim is no longer current");
      if(expectedRevision!==undefined){
        if(record.scope!=="project"||!record.projectId||this.skillSelectionRevision(tenant,record.name,"project",record.projectId)!==expectedRevision)throw new PhononError("errSkillRevisionChanged","skill selection changed before activation");
        this.archiveSkillSelection(tenant,record.projectId,record.name,requestId);
      }
      this.upsertSkill({...record,tenantId:tenant,executionJson});
      const result={...record,revision:this.skillSelectionRevision(tenant,record.name,record.scope,record.projectId)!};
      if(record.publication){
        if(expectedRevision===undefined||!executionJson||record.scope!=="project"||!record.projectId)throw new PhononError("errSkillInstallUnconfirmed","immutable activation is missing its original proof");
        this.db.prepare("INSERT INTO managed_skill_versions(installation_id,tenant_id,project_id,name,record_json,execution_json,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(record.publication.versionId,tenant,record.projectId,record.name,JSON.stringify(result),executionJson,new Date().toISOString());
      }
      this.db.prepare(`UPDATE skill_install_operations SET state='confirmed',result_json=?,updated_at=? WHERE tenant_id=? AND request_id=? AND owner_id=? AND state='dispatched'`)
        .run(JSON.stringify({skill:result}),new Date().toISOString(),tenant,requestId,owner);
      this.db.exec("COMMIT");return result;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  upsertSkill(r: { agent: string; name: string; scope: string; projectId?: string; version?: string; hash?: string; installedPath: string; installedAt: string;tenantId?:string;executionJson?:string }): void {
    if(r.tenantId!==undefined&&(!r.tenantId||r.scope==="project"&&!this.db.prepare("SELECT 1 FROM projects WHERE project_id=? AND namespace=?").get(r.projectId??null,r.tenantId)))
      throw new PhononError("errProjectNotFound","skill project is not in the current tenant");
    const result=this.db
      .prepare(
        `INSERT INTO skills(agent_id,name,scope,project_id,version,hash,installed_path,installed_at,tenant_id,execution_json)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT DO UPDATE SET version=excluded.version,hash=excluded.hash,installed_path=excluded.installed_path,
           installed_at=excluded.installed_at,tenant_id=excluded.tenant_id,execution_json=excluded.execution_json
         WHERE skills.tenant_id IS excluded.tenant_id OR(skills.tenant_id IS NULL AND excluded.tenant_id IS NOT NULL AND excluded.scope='project'
           AND EXISTS(SELECT 1 FROM projects WHERE project_id=excluded.project_id AND namespace=excluded.tenant_id))`,
      )
      .run(r.agent,r.name,r.scope,r.scope==="project"?r.projectId??null:null,r.version??null,r.hash??null,r.installedPath,r.installedAt,r.tenantId??null,r.executionJson??null);
    if(result.changes!==1)throw new PhononError("errPolicyDenied","skill metadata belongs to a different tenant");
  }
  skillExecutionReceipt(tenantId:string,record:{agent:string;name:string;scope:string;projectId?:string}):string|undefined{
    return (this.db.prepare(`SELECT execution_json FROM skills WHERE tenant_id=? AND agent_id=? AND name=? AND scope=?
      AND IFNULL(project_id,'')=IFNULL(?,'') AND(scope='global' OR EXISTS(SELECT 1 FROM projects WHERE project_id=skills.project_id AND namespace=?))`)
      .get(tenantId,record.agent,record.name,record.scope,record.scope==="project"?record.projectId??null:null,tenantId) as {execution_json?:string}|undefined)?.execution_json??undefined;
  }
  deleteSkill(r: { agent: string; name: string; scope: string; projectId?: string;tenantId?:string }): void {
    if(r.tenantId&&r.scope==="project")this.db.prepare(`UPDATE managed_skill_versions SET revoked_at=? WHERE tenant_id=? AND project_id=? AND name=? AND revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM projects WHERE project_id=? AND namespace=?)`).run(new Date().toISOString(),r.tenantId,r.projectId??null,r.name,r.projectId??null,r.tenantId);
    this.db
      .prepare(`DELETE FROM skills WHERE agent_id=? AND name=? AND scope=? AND IFNULL(project_id,'')=IFNULL(?,'')
        AND(? IS NULL OR tenant_id=? OR(tenant_id IS NULL AND scope='project'
          AND EXISTS(SELECT 1 FROM projects WHERE projects.project_id=skills.project_id AND namespace=?)))`)
      .run(r.agent,r.name,r.scope,r.scope==="project"?r.projectId??null:null,r.tenantId??null,r.tenantId??null,r.tenantId??null);
  }
  loadSkills(tenantId?:string):StoredSkillRecord[] {
    const rows=tenantId===undefined?this.db.prepare("SELECT * FROM skills").all():this.db.prepare(`SELECT * FROM skills
      WHERE(scope='global' AND tenant_id=?) OR(scope='project' AND(tenant_id=? OR tenant_id IS NULL)
        AND EXISTS(SELECT 1 FROM projects WHERE projects.project_id=skills.project_id AND namespace=?))`).all(tenantId,tenantId,tenantId);
    return (rows as Record<string, unknown>[]).map((row) => {
      let publication:StoredSkillRecord["publication"];try{const receipt=JSON.parse(String(row.execution_json));if(receipt.schema===2&&typeof receipt.installationId==="string"&&typeof receipt.tree?.hash==="string")publication={kind:"immutable",versionId:receipt.installationId,treeHash:receipt.tree.hash};}catch{}
      return {
      agent: row.agent_id as string,
      name: row.name as string,
      scope: row.scope as "global" | "project",
      projectId: (row.project_id as string) ?? undefined,
      version: (row.version as string) ?? undefined,
      hash: (row.hash as string) ?? undefined,
      installedPath: row.installed_path as string,
      installedAt: row.installed_at as string,
      ...(publication?{publication}:{}),...(tenantId?{revision:this.skillSelectionRevision(tenantId,String(row.name),row.scope as "project"|"global",row.project_id as string??undefined)!}:{}),
    };});
  }

  // ---- sessions（元数据，OpenClaw 原生可 resume）----
  upsertSession(r: { sessionId: string; tenantId: string; projectId?: string; worktreeId?: string; agent: string; model: string; status: string; verbosity: string; createdAt: string; lastActive?: string; transcriptPath?: string; streamSeq?: number; employeeId?:string; employeeRevision?:number; recoveryJSON?:string; ownerInstance?:string; nativeStopJSON?:string }): void {
    this.db
      .prepare(
        `INSERT INTO sessions(session_id,tenant_id,project_id,worktree_id,agent_id,model,status,verbosity,created_at,last_active,transcript_path,stream_seq,employee_id,employee_revision,recovery_json,native_stop_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET model=excluded.model, status=excluded.status, last_active=excluded.last_active,
           transcript_path=COALESCE(excluded.transcript_path, sessions.transcript_path),
           stream_seq=MAX(sessions.stream_seq, excluded.stream_seq),employee_revision=excluded.employee_revision,recovery_json=excluded.recovery_json,native_stop_json=excluded.native_stop_json
         WHERE sessions.tenant_id=excluded.tenant_id AND (? IS NULL OR EXISTS(
           SELECT 1 FROM session_native_owners o WHERE o.tenant_id=sessions.tenant_id AND o.session_id=sessions.session_id AND o.owner_instance=?))`,
      )
      .run(r.sessionId, r.tenantId, r.projectId ?? null, r.worktreeId ?? null, r.agent, r.model, r.status, r.verbosity, r.createdAt, r.lastActive ?? null, r.transcriptPath ?? null, r.streamSeq ?? 0,r.employeeId??null,r.employeeRevision??null,r.recoveryJSON??null,r.nativeStopJSON??null,r.ownerInstance??null,r.ownerInstance??null);
  }

  private nativeOwnerAlive(pid:number):boolean {
    if(!Number.isSafeInteger(pid)||pid<=0)return true;
    try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=="ESRCH";}
  }
  nativeSessionOwnedElsewhere(tenant:string,session:string,owner:string):boolean {
    const row=this.db.prepare("SELECT owner_instance,owner_pid FROM session_native_owners WHERE tenant_id=? AND session_id=?").get(tenant,session) as {owner_instance:string;owner_pid:number}|undefined;
    return !!row && row.owner_instance!==owner && this.nativeOwnerAlive(Number(row.owner_pid));
  }
  ownsNativeSession(tenant:string,session:string,owner:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM session_native_owners WHERE tenant_id=? AND session_id=? AND owner_instance=?").get(tenant,session,owner);
  }
  nativeSessionSnapshot(tenant:string,session:string):Record<string,unknown>|undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE tenant_id=? AND session_id=?").get(tenant,session) as Record<string,unknown>|undefined;
  }
  claimNativeSession(tenant:string,session:string,owner:string,expected?:{checkpoint:string|null;nativeStopJSON?:string|null;project:string;agent:string;model:string;employeeId?:string;employeeRevision?:number}):boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(this.nativeSessionOwnedElsewhere(tenant,session,owner)){this.db.exec("ROLLBACK");return false;}
      const row=this.db.prepare("SELECT * FROM sessions WHERE session_id=? AND tenant_id=?").get(session,tenant) as Record<string,unknown>|undefined;
      if(expected ? !row || !["idle","paused"].includes(String(row.status)) || row.recovery_json!==expected.checkpoint || expected.nativeStopJSON!==undefined&&(row.native_stop_json??null)!==expected.nativeStopJSON || row.project_id!==expected.project || row.agent_id!==expected.agent || row.model!==expected.model || (row.employee_id??null)!==(expected.employeeId??null) || (row.employee_revision??null)!==(expected.employeeRevision??null) : !!row){this.db.exec("ROLLBACK");return false;}
      this.db.prepare(`INSERT INTO session_native_owners(tenant_id,session_id,owner_instance,owner_pid) VALUES(?,?,?,?)
        ON CONFLICT(tenant_id,session_id) DO UPDATE SET owner_instance=excluded.owner_instance,owner_pid=excluded.owner_pid`).run(tenant,session,owner,process.pid);
      this.db.exec("COMMIT");return true;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  releaseNativeSession(tenant:string,session:string,owner:string):void {
    this.db.prepare("DELETE FROM session_native_owners WHERE tenant_id=? AND session_id=? AND owner_instance=?").run(tenant,session,owner);
  }
  loadSessions(tenantId?: string): Array<Record<string, unknown>> {
    if (tenantId !== undefined) {
      return this.db.prepare("SELECT * FROM sessions WHERE tenant_id=? AND status != 'terminated'").all(tenantId) as Record<string, unknown>[];
    }
    return this.db.prepare("SELECT * FROM sessions WHERE status != 'terminated'").all() as Record<string, unknown>[];
  }
  /** 列出全部 session（含 terminated）—— prune/审计用。 */
  listAllSessions(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM sessions ORDER BY COALESCE(last_active, created_at) DESC").all() as Record<string, unknown>[];
  }
  /** 删一条 session 元数据（不动快照文件，由调用方决定）。 */
  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
    this.db.prepare("DELETE FROM session_native_owners WHERE session_id=?").run(sessionId);
  }

  // ---- outbox ----
  rememberUpstreamRun(tenant:string,session:string,id:string):void{
    this.db.prepare("INSERT OR IGNORE INTO session_upstream_runs(tenant_id,session_id,upstream_id) VALUES(?,?,?)").run(tenant,session,id);
  }
  ownsUpstreamRun(tenant:string,session:string,id:string):boolean{return !!this.db.prepare("SELECT 1 FROM session_upstream_runs WHERE tenant_id=? AND session_id=? AND upstream_id=?").get(tenant,session,id);}
  proactiveEventHash(tenant:string,session:string,id:string):string|undefined{return (this.db.prepare("SELECT payload_hash FROM native_proactive_seen WHERE tenant_id=? AND session_id=? AND upstream_id=?").get(tenant,session,id) as {payload_hash:string}|undefined)?.payload_hash;}
  outboxAdd(tenantId: string, sessionId: string, seq: number, payload: string, createdAt: string,proactive?:{id:string;hash:string}): boolean {
    return this.deliveryWrite(() => {
      // Event durability and sequence advancement are one transaction. Advancing
      // sessions.stream_seq first would leave a permanent protocol gap if the
      // process crashed before the outbox row was inserted.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if(proactive){
          const existing=this.proactiveEventHash(tenantId,sessionId,proactive.id);
          if(existing){if(existing!==proactive.hash)throw new Error("native proactive identity changed");this.db.exec("COMMIT");return false;}
          this.db.prepare("INSERT INTO native_proactive_seen(tenant_id,session_id,upstream_id,payload_hash,seq,created_at) VALUES(?,?,?,?,?,?)").run(tenantId,sessionId,proactive.id,proactive.hash,seq,createdAt);
        }
        const result = this.db.prepare("INSERT OR IGNORE INTO outbox_events(tenant_id,session_id,seq,payload,created_at) VALUES(?,?,?,?,?)")
          .run(tenantId, sessionId, seq, payload, createdAt);
        this.db.prepare("UPDATE sessions SET stream_seq=MAX(stream_seq, ?) WHERE session_id=? AND tenant_id=?")
          .run(seq + 1, sessionId, tenantId);
        this.db.exec("COMMIT");
        return Number(result.changes) > 0;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw err;
      }
    });
  }
  outboxDelete(tenantId: string, sessionId: string, seq: number): void {
    return this.deliveryWrite(() => {
      this.db.prepare("DELETE FROM outbox_events WHERE tenant_id=? AND session_id=? AND seq=?")
        .run(tenantId, sessionId, seq);
    });
  }
  outboxMarkFinalized(tenantId: string, sessionId: string, lastSeq: number): void {
    return this.deliveryWrite(() => {
      this.db.prepare(
        `INSERT INTO outbox_acks(tenant_id,session_id,last_seq) VALUES(?,?,?)
         ON CONFLICT(tenant_id,session_id) DO UPDATE SET last_seq=MAX(last_seq, excluded.last_seq)`,
      ).run(tenantId, sessionId, lastSeq);
    });
  }
  outboxAck(tenantId: string, sessionId: string, lastSeq: number): void {
    this.deliveryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`INSERT INTO outbox_acks(tenant_id,session_id,last_seq) VALUES(?,?,?)
          ON CONFLICT(tenant_id,session_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq)`)
          .run(tenantId, sessionId, lastSeq);
        this.db.prepare("DELETE FROM outbox_events WHERE tenant_id=? AND session_id=? AND seq<=?").run(tenantId, sessionId, lastSeq);
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }
  outboxLoad(tenantId: string): Array<{ sessionId: string; seq: number; payload: string }> {
    return (this.db.prepare("SELECT session_id,seq,payload FROM outbox_events WHERE tenant_id=? ORDER BY id").all(tenantId) as Record<string, unknown>[]).map((r) => ({
      sessionId: r.session_id as string,
      seq: r.seq as number,
      payload: r.payload as string,
    }));
  }
  outboxLoadFinalized(tenantId: string): Array<{ sessionId: string; lastSeq: number }> {
    return (this.db.prepare("SELECT session_id,last_seq FROM outbox_acks WHERE tenant_id=? ORDER BY session_id").all(tenantId) as Record<string, unknown>[]).map((r) => ({
      sessionId: r.session_id as string,
      lastSeq: r.last_seq as number,
    }));
  }
  outboxNextSeq(tenantId: string, sessionId: string): number {
    const row = this.db.prepare(
      `SELECT MAX(seq) AS max_seq FROM (
         SELECT seq FROM outbox_events WHERE tenant_id=? AND session_id=?
         UNION ALL
         SELECT last_seq AS seq FROM outbox_acks WHERE tenant_id=? AND session_id=?
       )`,
    ).get(tenantId, sessionId, tenantId, sessionId) as { max_seq: number | null } | undefined;
    return row?.max_seq == null ? 0 : row.max_seq + 1;
  }
  outboxResumeFrom(tenantId: string): Array<{ sessionId: string; fromSeq: number }> {
    return (this.db.prepare(
      "SELECT session_id,MIN(seq) AS from_seq FROM outbox_events WHERE tenant_id=? GROUP BY session_id ORDER BY session_id",
    ).all(tenantId) as Array<{ session_id: string; from_seq: number }>).map((r) => ({
      sessionId: r.session_id,
      fromSeq: r.from_seq,
    }));
  }

  rememberConnectionTenant(serverUrl: string, tenantId: string, updatedAt: string): void {
    this.db.prepare(
      `INSERT INTO connection_tenants(server_url,tenant_id,updated_at) VALUES(?,?,?)
       ON CONFLICT(server_url) DO UPDATE SET tenant_id=excluded.tenant_id, updated_at=excluded.updated_at`,
    ).run(serverUrl, tenantId, updatedAt);
  }
  connectionTenant(serverUrl: string): string | undefined {
    const row = this.db.prepare("SELECT tenant_id FROM connection_tenants WHERE server_url=?").get(serverUrl) as { tenant_id: string } | undefined;
    return row?.tenant_id;
  }

  // ---- env vars（设备本地环境变量配置，默认脱敏返回）----
  envSet(r: { tenantId: string; scope: string; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret?: boolean; updatedAt: string }): void {
    this.envDelete(r);
    // 落库前加密 value(at-rest)。
    const stored = this.secrets.encrypt(r.value);
    this.db.prepare(
      `INSERT INTO env_vars(tenant_id,scope,project_id,agent_id,skill_name,name,value,secret,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(r.tenantId, r.scope, r.projectId ?? null, r.agent ?? null, r.skillName ?? null, r.name, stored, r.secret === false ? 0 : 1, r.updatedAt);
  }
  envDelete(r: { tenantId: string; scope: string; projectId?: string; agent?: string; skillName?: string; name: string }): void {
    this.db.prepare("DELETE FROM env_vars WHERE tenant_id=? AND scope=? AND IFNULL(project_id,'')=IFNULL(?,'') AND IFNULL(agent_id,'')=IFNULL(?,'') AND IFNULL(skill_name,'')=IFNULL(?,'') AND name=?")
      .run(r.tenantId, r.scope, r.projectId ?? null, r.agent ?? null, r.skillName ?? null, r.name);
  }
  envList(tenantId: string, filter?: { scope?: string; projectId?: string; agent?: string; skillName?: string }): Array<{ scope: string; projectId?: string; agent?: string; skillName?: string; name: string; value: string; secret: boolean; updatedAt: string }> {
    const where: string[] = ["tenant_id=?"];
    const params: unknown[] = [tenantId];
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

  interactionReceipt(tenant: string, request: string): Record<string,unknown> | undefined {
    return this.db.prepare("SELECT * FROM interaction_receipts WHERE tenant_id=? AND request_id=?").get(tenant,request) as Record<string,unknown> | undefined;
  }
  compressionReceipt(tenant:string,id:string):Record<string,any>|undefined{
    const row=this.db.prepare("SELECT document FROM compression_receipts WHERE tenant_id=? AND operation_id=?").get(tenant,id) as {document:string}|undefined;
    return row?JSON.parse(row.document):undefined;
  }
  latestCompression(tenant:string,session:string):Record<string,any>|undefined{
    const row=this.db.prepare("SELECT document FROM compression_receipts WHERE tenant_id=? AND session_id=? ORDER BY json_extract(document,'$.createdAt') DESC,rowid DESC LIMIT 1").get(tenant,session) as {document:string}|undefined;
    return row?JSON.parse(row.document):undefined;
  }
  compressionBlocked(tenant:string,session:string):boolean{
    return !!this.db.prepare("SELECT 1 FROM compression_receipts WHERE tenant_id=? AND session_id=? AND state IN ('running','unknown')").get(tenant,session);
  }
  beginCompression(tenant:string,receipt:{operationId:string;sessionId:string;state:string}):void{
    this.db.prepare("INSERT INTO compression_receipts(tenant_id,operation_id,session_id,state,document) VALUES(?,?,?,?,?)")
      .run(tenant,receipt.operationId,receipt.sessionId,receipt.state,JSON.stringify(receipt));
  }
  finishCompression(tenant:string,receipt:{operationId:string;state:string}):void{
    this.db.prepare("UPDATE compression_receipts SET state=?,document=? WHERE tenant_id=? AND operation_id=?")
      .run(receipt.state,JSON.stringify(receipt),tenant,receipt.operationId);
  }
  employeeProfile(tenant:string,id:string):Record<string,any>|undefined{
    const row=this.db.prepare("SELECT document FROM employee_profiles WHERE tenant_id=? AND employee_id=?").get(tenant,id) as {document:string}|undefined;
    return row?JSON.parse(row.document):undefined;
  }
  saveEmployeeProfile(tenant:string,id:string,document:unknown):void{
    this.db.prepare("INSERT INTO employee_profiles(tenant_id,employee_id,document) VALUES(?,?,?) ON CONFLICT(tenant_id,employee_id) DO UPDATE SET document=excluded.document").run(tenant,id,JSON.stringify(document));
  }
  employeeBusy(tenant:string,id:string):boolean{
    return !!this.db.prepare(`SELECT 1 FROM sessions s WHERE s.tenant_id=? AND s.employee_id=? AND
      (s.status IN ('running','paused') OR EXISTS(SELECT 1 FROM compression_receipts c WHERE c.tenant_id=s.tenant_id AND c.session_id=s.session_id AND c.state IN ('running','unknown'))) LIMIT 1`).get(tenant,id);
  }
  beginInteraction(tenant: string, request: string, hash: string, payload: string): void {
    this.db.prepare(`INSERT INTO interaction_receipts(tenant_id,request_id,request_hash,request_json,state,updated_at)
      VALUES(?,?,?,?,'pending',?) ON CONFLICT DO NOTHING`).run(tenant,request,hash,payload,new Date().toISOString());
  }
  updateInteraction(tenant: string, request: string, state: string, response?: string, hash?: string): void {
    this.db.prepare(`UPDATE interaction_receipts SET state=?,response_json=COALESCE(?,response_json),
      decision_hash=COALESCE(?,decision_hash),updated_at=? WHERE tenant_id=? AND request_id=?`)
      .run(state,response??null,hash??null,new Date().toISOString(),tenant,request);
  }
  close(): void {
    this.peers?.close();
    this.archives?.close();
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
  idempotencyFingerprint(key: string): string | undefined {
    const row = this.db.prepare("SELECT request_hash FROM idempotency WHERE k=?").get(key) as { request_hash: string | null } | undefined;
    return row?.request_hash ?? undefined;
  }

  idempotencyPut(key: string, result: string, fingerprint?: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO idempotency(k,result,created_at,request_hash) VALUES(?,?,?,?) ON CONFLICT(k) DO NOTHING")
        .run(key, result, Date.now(), fingerprint ?? null);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.delivery.failed();
      throw error;
    }
  }

  findWorkflowDispatch(tenantId:string,key:string):Record<string,unknown>|undefined {
    return this.db.prepare(`SELECT * FROM workflows WHERE tenant_id=? AND json_extract(metadata_json,'$._phononDispatch.key')=? LIMIT 1`).get(tenantId,key) as Record<string,unknown>|undefined;
  }

  workflowCancelIntent(tenantId:string,key:string): {project_id:string}|undefined {
    return this.db.prepare("SELECT project_id FROM workflow_cancel_intents WHERE tenant_id=? AND dispatch_key=?").get(tenantId,key) as {project_id:string}|undefined;
  }
  recordWorkflowCancelIntent(tenantId:string,key:string,project:string):void {
    const previous=this.workflowCancelIntent(tenantId,key);
    if(previous&&previous.project_id!==project)throw new Error("dispatch cancellation scope mismatch");
    this.db.prepare("INSERT INTO workflow_cancel_intents(tenant_id,dispatch_key,project_id,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(tenantId,key,project,new Date().toISOString());
  }

  workflowResumeDispatch(tenantId: string, key: string): { requestHash: string; resultJson: string } | undefined {
    return this.db.prepare("SELECT request_hash AS requestHash,result_json AS resultJson FROM workflow_resume_dispatches WHERE tenant_id=? AND request_key=?")
      .get(tenantId, key) as { requestHash: string; resultJson: string } | undefined;
  }

  // ---- workflows (L3 checkpoint) ----
  workflowInputGet(tenantId:string,workflowId:string,inputId:string):Record<string,unknown>|undefined {
    return this.db.prepare('SELECT * FROM workflow_input_receipts WHERE tenant_id=? AND workflow_id=? AND input_id=?').get(tenantId,workflowId,inputId) as Record<string,unknown>|undefined;
  }
  workflowInputReserve(input:{tenantId:string;workflowId:string;inputId:string;contentHash:string;nodeId:string;sessionId:string;turnId:string;ownerId:string;ownerEpoch:number;controlEpoch:number}):boolean {
    const now=new Date().toISOString();
    const result=this.db.prepare(`INSERT INTO workflow_input_receipts(tenant_id,workflow_id,input_id,request_hash,node_id,session_id,turn_id,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'inserting',?,? FROM workflows w WHERE w.tenant_id=? AND w.workflow_id=? AND w.owner_id=? AND w.owner_epoch=?
        AND w.status='running' AND w.lease_until>? AND json_extract(w.checkpoint_json,'$.controlEpoch')=?
        AND (SELECT count(*) FROM workflow_input_receipts i WHERE i.tenant_id=w.tenant_id AND i.workflow_id=w.workflow_id)<256
      ON CONFLICT(tenant_id,workflow_id,input_id) DO NOTHING`).run(input.tenantId,input.workflowId,input.inputId,input.contentHash,input.nodeId,input.sessionId,input.turnId,now,now,
        input.tenantId,input.workflowId,input.ownerId,input.ownerEpoch,Date.now(),input.controlEpoch);
    return Number(result.changes)===1;
  }
  workflowInputFinish(tenantId:string,workflowId:string,inputId:string,contentHash:string,state:'inserted'|'unknown',errorCode?:string):void {
    this.db.prepare(`UPDATE workflow_input_receipts SET state=?,error_code=?,updated_at=?
      WHERE tenant_id=? AND workflow_id=? AND input_id=? AND request_hash=? AND state='inserting'`).run(state,errorCode??null,new Date().toISOString(),tenantId,workflowId,inputId,contentHash);
  }
  upsertWorkflow(w: {
    workflowId: string; tenantId: string; projectId?: string; worktreeId?: string;
    mode: string; planJson: string; input?: string; policyJson?: string; sharedJson?: string;
    status: string; finalText?: string; error?: string; nodesJson: string;
    seq: number; ackedSeq: number; createdAt: string; updatedAt: string; completedAt?: string;
    checkpointJson?: string; ownerId?: string; ownerEpoch?: number; leaseUntil?: number; metadataJson?: string;
  }): boolean {
    // May run inside append/accept transaction: publish gauges only after commit.
    return this.deliveryWrite(() => {
      const result = this.db
        .prepare(
          `INSERT INTO workflows(workflow_id,tenant_id,project_id,worktree_id,mode,plan_json,input,policy_json,shared_json,status,final_text,error,nodes_json,seq,acked_seq,created_at,updated_at,completed_at,checkpoint_json,owner_id,owner_epoch,lease_until,metadata_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(workflow_id) DO UPDATE SET
             status=excluded.status,
             final_text=excluded.final_text,
             error=excluded.error,
             shared_json=excluded.shared_json,
             nodes_json=excluded.nodes_json,
             seq=excluded.seq,
             acked_seq=MAX(workflows.acked_seq, excluded.acked_seq),
             updated_at=excluded.updated_at,
             completed_at=excluded.completed_at,
             checkpoint_json=excluded.checkpoint_json,
             lease_until=excluded.lease_until,
             metadata_json=excluded.metadata_json
           WHERE workflows.tenant_id=excluded.tenant_id AND workflows.owner_id=excluded.owner_id AND workflows.owner_epoch=excluded.owner_epoch`,
        )
        .run(
          w.workflowId, w.tenantId, w.projectId ?? null, w.worktreeId ?? null, w.mode, w.planJson,
          w.input ?? null, w.policyJson ?? null, w.sharedJson ?? null,
          w.status, w.finalText ?? null, w.error ?? null, w.nodesJson,
          w.seq, w.ackedSeq, w.createdAt, w.updatedAt, w.completedAt ?? null,
          w.checkpointJson ?? null, w.ownerId ?? null, w.ownerEpoch ?? 0, w.leaseUntil ?? null, w.metadataJson ?? null,
        );
      return Number(result.changes) === 1;
    }, false);
  }

  /** Atomically persist the workflow checkpoint/seq and its emitted event. */
  appendWorkflowEvent(
    w: Parameters<PhononStore["upsertWorkflow"]>[0],
    event: { seq: number; payload: string; createdAt: string },
    resumeDispatch?: { key: string; hash: string; resultJson: string },
  ): boolean {
    return this.deliveryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const persisted = this.upsertWorkflow(w);
        if (!persisted) {
          this.db.exec("ROLLBACK");
          return false;
        }
        this.db.prepare(
          "INSERT OR IGNORE INTO workflow_events(workflow_id,tenant_id,seq,payload,created_at) VALUES(?,?,?,?,?)",
        ).run(w.workflowId, w.tenantId, event.seq, event.payload, event.createdAt);
        if (resumeDispatch) {
          this.db.prepare("INSERT INTO workflow_resume_dispatches(tenant_id,request_key,request_hash,workflow_id,result_json) VALUES(?,?,?,?,?)")
            .run(w.tenantId, resumeDispatch.key, resumeDispatch.hash, w.workflowId, resumeDispatch.resultJson);
        }
        this.db.exec("COMMIT");
        return true;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    });
  }

  workflowEvents(workflowId: string, tenantId: string, afterSeq = -1, limit = 200): Array<{ seq: number; payload: string }> {
    return this.db.prepare(
      "SELECT seq,payload FROM workflow_events WHERE workflow_id=? AND tenant_id=? AND seq>? ORDER BY seq LIMIT ?",
    ).all(workflowId, tenantId, afterSeq, limit) as Array<{ seq: number; payload: string }>;
  }

  unackedWorkflowEvents(tenantId: string): Array<{ workflowId: string; seq: number; payload: string }> {
    return this.db.prepare(
      `SELECT e.workflow_id AS workflowId,e.seq,e.payload
         FROM workflow_events e JOIN workflows w ON w.workflow_id=e.workflow_id AND w.tenant_id=e.tenant_id
        WHERE e.tenant_id=? AND e.seq>w.acked_seq
        ORDER BY w.created_at,e.seq`,
    ).all(tenantId) as Array<{ workflowId: string; seq: number; payload: string }>;
  }

  /** Atomically acquire the single executor lease for a tenant/workflow. */
  claimWorkflow(workflowId: string, tenantId: string, ownerId: string, leaseMs = 30_000): number | undefined {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT owner_id,owner_epoch,lease_until FROM workflows WHERE workflow_id=? AND tenant_id=?",
      ).get(workflowId, tenantId) as { owner_id: string | null; owner_epoch: number; lease_until: number | null } | undefined;
      if (!row || (row.owner_id !== null && row.owner_id !== ownerId && (row.lease_until ?? 0) > now)) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const epoch = row.owner_id === ownerId ? row.owner_epoch : row.owner_epoch + 1;
      this.db.prepare(
        "UPDATE workflows SET owner_id=?,owner_epoch=?,lease_until=? WHERE workflow_id=? AND tenant_id=?",
      ).run(ownerId, epoch, now + leaseMs, workflowId, tenantId);
      this.db.exec("COMMIT");
      return epoch;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }

  isWorkflowOwner(workflowId: string, tenantId: string, ownerId: string, ownerEpoch: number): boolean {
    const row = this.db.prepare(
      "SELECT 1 AS owned FROM workflows WHERE workflow_id=? AND tenant_id=? AND owner_id=? AND owner_epoch=?",
    ).get(workflowId, tenantId, ownerId, ownerEpoch) as { owned: number } | undefined;
    return row?.owned === 1;
  }

  renewWorkflowLease(workflowId: string, tenantId: string, ownerId: string, ownerEpoch: number, leaseMs = 30_000): boolean {
    const result = this.db.prepare(
      "UPDATE workflows SET lease_until=? WHERE workflow_id=? AND tenant_id=? AND owner_id=? AND owner_epoch=?",
    ).run(Date.now() + leaseMs, workflowId, tenantId, ownerId, ownerEpoch);
    return Number(result.changes) === 1;
  }

  releaseWorkflow(workflowId: string, tenantId: string, ownerId: string, ownerEpoch: number): boolean {
    const result = this.db.prepare(
      "UPDATE workflows SET owner_id=NULL,owner_epoch=owner_epoch+1,lease_until=NULL WHERE workflow_id=? AND tenant_id=? AND owner_id=? AND owner_epoch=?",
    ).run(workflowId, tenantId, ownerId, ownerEpoch);
    return Number(result.changes) === 1;
  }

  listRecoverableWorkflows(tenantId: string): Array<Record<string, unknown>> {
    return this.db.prepare(
      "SELECT * FROM workflows WHERE tenant_id=? AND status IN ('queued','running') ORDER BY created_at",
    ).all(tenantId) as Array<Record<string, unknown>>;
  }

  getWorkflow(workflowId: string, tenantId?: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM workflows WHERE workflow_id=?").get(workflowId) as Record<string, unknown> | undefined;
    // B1: tenant 越权防护——传了 tenantId 就强制校验归属
    if (row && tenantId !== undefined && row.tenant_id !== tenantId) return undefined;
    return row;
  }

  listWorkflows(tenantId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM workflows WHERE tenant_id=? ORDER BY created_at DESC").all(tenantId) as Array<Record<string, unknown>>;
  }

  ackWorkflow(workflowId: string, lastSeq: number, tenantId?: string): void {
    return this.deliveryWrite(() => {
      if (tenantId !== undefined) {
        this.db.prepare("UPDATE workflows SET acked_seq=MAX(acked_seq, MIN(?, seq-1)) WHERE workflow_id=? AND tenant_id=?").run(lastSeq, workflowId, tenantId);
      } else {
        this.db.prepare("UPDATE workflows SET acked_seq=MAX(acked_seq, MIN(?, seq-1)) WHERE workflow_id=?").run(lastSeq, workflowId);
      }
    });
  }

  // ---- schedules (L4 定时任务定义；device 为真相源) ----
  upsertSchedule(s: {
    id: string; tenantId: string; name: string; enabled: boolean;
    triggerJson: string; targetJson: string; consentJson: string; policyJson?: string;
    webhookToken?: string; createdAt: string; updatedAt: string; lastRunAt?: string; nextRunAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO schedules(id,tenant_id,name,enabled,trigger_json,target_json,consent_json,policy_json,webhook_token,created_at,updated_at,last_run_at,next_run_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, enabled=excluded.enabled,
           trigger_json=excluded.trigger_json, target_json=excluded.target_json,
           consent_json=excluded.consent_json, policy_json=excluded.policy_json,
           webhook_token=excluded.webhook_token,
           updated_at=excluded.updated_at, last_run_at=excluded.last_run_at, next_run_at=excluded.next_run_at
         WHERE schedules.tenant_id=excluded.tenant_id`,
      )
      .run(
        s.id, s.tenantId, s.name, s.enabled ? 1 : 0,
        s.triggerJson, s.targetJson, s.consentJson, s.policyJson ?? null,
        s.webhookToken ?? null, s.createdAt, s.updatedAt, s.lastRunAt ?? null, s.nextRunAt ?? null,
      );
  }
  getSchedule(id: string, tenantId?: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (row && tenantId !== undefined && row.tenant_id !== tenantId) return undefined; // B1 tenant 隔离
    return row;
  }
  getScheduleByWebhookToken(token: string, tenantId?: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE webhook_token=?").get(token) as Record<string, unknown> | undefined;
    if (row && tenantId !== undefined && row.tenant_id !== tenantId) return undefined; // B1
    return row;
  }
  listSchedules(tenantId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM schedules WHERE tenant_id=? ORDER BY created_at DESC").all(tenantId) as Array<Record<string, unknown>>;
  }
  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id=?").run(id);
    // Preserve run history/receipts for replay and ACK after schedule deletion.
  }

  /** Accept one cron run receipt and consume its due cursor atomically before
   * any provider call. A storage failure cannot advance the cursor alone. */
  acceptCronRun(run: Parameters<PhononStore["upsertRun"]>[0], nextRunAt: string): void {
    this.deliveryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!this.upsertRun(run)) throw new Error("cron run acceptance failed");
        const updated = this.db.prepare("UPDATE schedules SET next_run_at=?,last_run_at=? WHERE id=? AND tenant_id=?")
          .run(nextRunAt, run.createdAt, run.scheduleId, run.tenantId);
        if (Number(updated.changes) !== 1) throw new Error("cron schedule disappeared during acceptance");
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  // ---- runs (L4 每次执行记录) ----
  upsertRun(r: {
    id: string; scheduleId: string; tenantId: string; triggerSource: string; status: string;
    sessionId?: string; workflowId?: string; startedAt?: string; finishedAt?: string;
    exitReason?: string; error?: string; transcriptPath?: string; resultText?: string;
    usageJson?: string; pushState?: string; ackedSeq?: number; createdAt: string;
    attempt?: number; maxAttempts?: number; retryHistoryJson?: string; inputJson?: string; dispatchJson?: string;
    phase?: string; retryAt?: number; ownerId?: string; ownerEpoch?: number; leaseUntil?: number; eventSeq?: number;
  }): boolean {
    // May run inside append/accept transaction: publish gauges only after commit.
    return this.deliveryWrite(() => {
      const result = this.db
        .prepare(
          `INSERT INTO runs(id,schedule_id,tenant_id,trigger_source,status,session_id,workflow_id,started_at,finished_at,exit_reason,error,transcript_path,result_text,usage_json,push_state,acked_seq,created_at,attempt,max_attempts,retry_history_json,input_json,phase,retry_at,owner_id,owner_epoch,lease_until,event_seq,dispatch_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status, session_id=excluded.session_id, workflow_id=excluded.workflow_id,
             started_at=excluded.started_at, finished_at=excluded.finished_at,
             exit_reason=excluded.exit_reason, error=excluded.error,
             transcript_path=excluded.transcript_path, result_text=excluded.result_text,
             usage_json=excluded.usage_json,
             push_state=CASE WHEN runs.push_state='acked' THEN 'acked' ELSE excluded.push_state END,
             acked_seq=MAX(runs.acked_seq, excluded.acked_seq),
             attempt=excluded.attempt, max_attempts=excluded.max_attempts,
             retry_history_json=excluded.retry_history_json, input_json=excluded.input_json,
             dispatch_json=COALESCE(runs.dispatch_json,excluded.dispatch_json),
             phase=excluded.phase, retry_at=excluded.retry_at, lease_until=excluded.lease_until,
             event_seq=MAX(runs.event_seq, excluded.event_seq)
           WHERE runs.tenant_id=excluded.tenant_id AND
                 ((runs.owner_id IS NULL AND excluded.owner_id IS NULL) OR
                  (runs.owner_id=excluded.owner_id AND runs.owner_epoch=excluded.owner_epoch))`,
        )
        .run(
          r.id, r.scheduleId, r.tenantId, r.triggerSource, r.status,
          r.sessionId ?? null, r.workflowId ?? null, r.startedAt ?? null, r.finishedAt ?? null,
          r.exitReason ?? null, r.error ?? null, r.transcriptPath ?? null, r.resultText ?? null,
          r.usageJson ?? null, r.pushState ?? "pending", r.ackedSeq ?? -1, r.createdAt,
          r.attempt ?? 0, r.maxAttempts ?? 1, r.retryHistoryJson ?? "[]", r.inputJson ?? null,
          r.phase ?? null, r.retryAt ?? null, r.ownerId ?? null, r.ownerEpoch ?? 0, r.leaseUntil ?? null, r.eventSeq ?? 0,
          r.dispatchJson ?? null,
        );
      return Number(result.changes) === 1;
    }, false);
  }
  appendRunEvent(
    run: Parameters<PhononStore["upsertRun"]>[0],
    event: { seq: number; payload: string; createdAt: string },
  ): boolean {
    return this.deliveryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const persisted = this.upsertRun(run);
        if (!persisted) {
          this.db.exec("ROLLBACK");
          return false;
        }
        this.db.prepare("INSERT OR IGNORE INTO run_events(run_id,tenant_id,seq,payload,created_at) VALUES(?,?,?,?,?)")
          .run(run.id, run.tenantId, event.seq, event.payload, event.createdAt);
        this.db.exec("COMMIT");
        return true;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    });
  }

  unackedRunEvents(tenantId: string): Array<{ runId: string; seq: number; payload: string }> {
    return this.db.prepare(
      `SELECT e.run_id AS runId,e.seq,e.payload
         FROM run_events e JOIN runs r ON r.id=e.run_id AND r.tenant_id=e.tenant_id
        WHERE e.tenant_id=? AND e.seq>r.acked_seq
        ORDER BY r.created_at,e.seq`,
    ).all(tenantId) as Array<{ runId: string; seq: number; payload: string }>;
  }

  ackRun(runId: string, tenantId: string, opts?: { lastSeq?: number; finished?: boolean }): boolean {
    return this.deliveryWrite(() => {
      const row = this.db.prepare("SELECT acked_seq,event_seq,push_state FROM runs WHERE id=? AND tenant_id=?")
        .get(runId, tenantId) as { acked_seq: number; event_seq: number; push_state: string } | undefined;
      if (!row) return false;
      const ackedSeq = opts?.lastSeq === undefined
        ? row.acked_seq
        : Math.max(row.acked_seq, Math.min(opts.lastSeq, row.event_seq - 1));
      const pushState = opts?.finished === true ? "acked" : row.push_state;
      const result = this.db.prepare("UPDATE runs SET acked_seq=?,push_state=? WHERE id=? AND tenant_id=?")
        .run(ackedSeq, pushState, runId, tenantId);
      return Number(result.changes) === 1;
    });
  }

  claimRun(runId: string, tenantId: string, ownerId: string, leaseMs = 30_000): number | undefined {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT owner_id,owner_epoch,lease_until FROM runs WHERE id=? AND tenant_id=?",
      ).get(runId, tenantId) as { owner_id: string | null; owner_epoch: number; lease_until: number | null } | undefined;
      if (!row || (row.owner_id !== null && row.owner_id !== ownerId && (row.lease_until ?? 0) > now)) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const epoch = row.owner_id === ownerId ? row.owner_epoch : row.owner_epoch + 1;
      this.db.prepare("UPDATE runs SET owner_id=?,owner_epoch=?,lease_until=? WHERE id=? AND tenant_id=?")
        .run(ownerId, epoch, now + leaseMs, runId, tenantId);
      this.db.exec("COMMIT");
      return epoch;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }

  renewRunLease(runId: string, tenantId: string, ownerId: string, ownerEpoch: number, leaseMs = 30_000): boolean {
    const result = this.db.prepare(
      "UPDATE runs SET lease_until=? WHERE id=? AND tenant_id=? AND owner_id=? AND owner_epoch=?",
    ).run(Date.now() + leaseMs, runId, tenantId, ownerId, ownerEpoch);
    return Number(result.changes) === 1;
  }

  releaseRun(runId: string, tenantId: string, ownerId: string, ownerEpoch: number): boolean {
    const result = this.db.prepare(
      "UPDATE runs SET owner_id=NULL,owner_epoch=owner_epoch+1,lease_until=NULL WHERE id=? AND tenant_id=? AND owner_id=? AND owner_epoch=?",
    ).run(runId, tenantId, ownerId, ownerEpoch);
    return Number(result.changes) === 1;
  }

  getRun(id: string, tenantId?: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (row && tenantId !== undefined && row.tenant_id !== tenantId) return undefined; // B1
    return row;
  }
  listRunsForSchedule(scheduleId: string, opts?: { status?: string; limit?: number; tenantId?: string; unackedOnly?: boolean }): Array<Record<string, unknown>> {
    const where: string[] = ["schedule_id=?"];
    const params: unknown[] = [scheduleId];
    if (opts?.tenantId !== undefined) { where.push("tenant_id=?"); params.push(opts.tenantId); } // B1
    if (opts?.status) { where.push("status=?"); params.push(opts.status); }
    if (opts?.unackedOnly) where.push("push_state<>'acked'");
    const sql = `SELECT * FROM runs WHERE ${where.join(" AND ")} ORDER BY created_at ${opts?.unackedOnly ? "ASC" : "DESC"},id LIMIT ?`;
    params.push(opts?.limit ?? 50);
    return this.db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  }
  /** 重启时审计收敛：connection-scoped runtime 无法接管的 pending/running run。 */
  listActiveRuns(tenantId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM runs WHERE tenant_id=? AND status IN ('pending','running') ORDER BY created_at")
      .all(tenantId) as Array<Record<string, unknown>>;
  }
  /** 重启后恢复：未推送完成的 run（push_state != 'acked' 且已终态），用于补推。 */
  listUnackedFinishedRuns(tenantId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM runs WHERE tenant_id=? AND push_state!='acked' AND status NOT IN ('pending','running') ORDER BY created_at")
      .all(tenantId) as Array<Record<string, unknown>>;
  }
}
