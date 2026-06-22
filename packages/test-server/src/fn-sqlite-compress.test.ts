import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dropToolIOFromJsonlFiles, dropToolIORowsSqlite, resolveCodexSessionFile, resolveHermesSessionByTitle } from "@agent-phonon/core";

// ---------- Codex (JSONL rollout) ----------

test("codex: dropToolIO trims function_call records from rollout, keeps reasoning + recent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-codex-"));
  const file = join(dir, "rollout.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "t1", cwd: "/x" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "KEEP_REASONING" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c_old" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c_old", output: "OLD_OUT" } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c_new" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c_new", output: "NEW_OUT" } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await dropToolIOFromJsonlFiles([file], { keepRecentToolCalls: 1 });
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("KEEP_REASONING"));
  assert.ok(text.includes("session_meta")); // non-tool record preserved
  assert.equal(text.includes("OLD_OUT"), false);
  assert.equal(text.includes("c_old"), false);
  assert.ok(text.includes("NEW_OUT")); // recent kept
  assert.ok(text.includes("c_new"));
  assert.equal(r.backups.length, 1);
});

test("codex: resolveCodexSessionFile finds rollout by thread_id suffix, newest wins", () => {
  const home = mkdtempSync(join(tmpdir(), "phonon-codexhome-"));
  const day = join(home, "sessions", "2026", "06", "20");
  mkdirSync(day, { recursive: true });
  const older = join(day, "rollout-2026-06-20T01-00-00-019ee5a1-thread.jsonl");
  const newer = join(day, "rollout-2026-06-20T02-00-00-019ee5a1-thread.jsonl");
  writeFileSync(older, "{}\n");
  writeFileSync(newer, "{}\n");
  // bump mtime of newer
  const now = Date.now();
  utimesSync(older, new Date(now - 10000), new Date(now - 10000));
  utimesSync(newer, new Date(now), new Date(now));
  const found = resolveCodexSessionFile("019ee5a1-thread", home);
  assert.equal(found, newer);
  assert.equal(resolveCodexSessionFile("nonexistent", home), undefined);
});

// ---------- OpenCode-style sqlite (delete whole tool part rows) ----------

function makeOpencodeDb(): { dbPath: string; sid: string } {
  const dir = mkdtempSync(join(tmpdir(), "phonon-oc-"));
  const dbPath = join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  const sid = "ses_test";
  const rows: Array<[string, string]> = [
    ["p1", JSON.stringify({ type: "text", text: "narration" })],
    ["p2", JSON.stringify({ type: "tool", tool: "read", callID: "old" })],
    ["p3", JSON.stringify({ type: "reasoning" })],
    ["p4", JSON.stringify({ type: "tool", tool: "read", callID: "new" })],
  ];
  rows.forEach(([id, data], i) => db.prepare("INSERT INTO part(id,session_id,time_created,data) VALUES(?,?,?,?)").run(id, sid, 1000 + i, data));
  db.close();
  return { dbPath, sid };
}

test("opencode-sqlite: deletes old tool parts, keeps recent + text, backs up", async () => {
  const { dbPath, sid } = makeOpencodeDb();
  const r = await dropToolIORowsSqlite({
    dbPath,
    keepRecentToolCalls: 1,
    selectRows: (db) => (db.prepare("SELECT id, data FROM part WHERE session_id=? ORDER BY time_created ASC").all(sid) as Array<{ id: string; data: string }>)
      .map((row) => ({ id: row.id, isTool: (JSON.parse(row.data) as { type?: string }).type === "tool" })),
    mutateRow: (db, row) => { db.prepare("DELETE FROM part WHERE id=?").run(row.id); },
  });
  assert.equal(r.blocksRemoved, 1); // only the older tool part
  assert.equal(r.backups.length, 1);
  assert.ok(existsSync(r.backups[0]!));
  const db = new DatabaseSync(dbPath);
  const remaining = (db.prepare("SELECT id FROM part ORDER BY id").all() as Array<{ id: string }>).map((x) => x.id);
  db.close();
  assert.deepEqual(remaining, ["p1", "p3", "p4"]); // text, reasoning, recent tool kept; p2 gone
});

test("opencode-sqlite: keepRecentToolCalls=0 removes all tool parts", async () => {
  const { dbPath, sid } = makeOpencodeDb();
  const r = await dropToolIORowsSqlite({
    dbPath,
    keepRecentToolCalls: 0,
    selectRows: (db) => (db.prepare("SELECT id, data FROM part WHERE session_id=? ORDER BY time_created ASC").all(sid) as Array<{ id: string; data: string }>)
      .map((row) => ({ id: row.id, isTool: (JSON.parse(row.data) as { type?: string }).type === "tool" })),
    mutateRow: (db, row) => { db.prepare("DELETE FROM part WHERE id=?").run(row.id); },
  });
  assert.equal(r.blocksRemoved, 2);
});

// ---------- Hermes-style sqlite (delete tool rows, clear assistant tool_calls; FTS triggers) ----------

function makeHermesDb(): { dbPath: string; sid: string } {
  const dir = mkdtempSync(join(tmpdir(), "phonon-hermes-"));
  const dbPath = join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL)");
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT)");
  db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(content)");
  db.exec(`CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, COALESCE(new.content,'')||' '||COALESCE(new.tool_name,''));
  END`);
  db.exec(`CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END`);
  db.exec(`CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, COALESCE(new.content,'')||' '||COALESCE(new.tool_name,''));
  END`);
  const sid = "20260621_000000_aaaaaa";
  db.prepare("INSERT INTO sessions(id,title,started_at) VALUES(?,?,?)").run(sid, "phonon-sess1", 1000);
  // assistant with tool_calls (must KEEP content, clear tool_calls), then tool result row (delete)
  const msgs: Array<[string, string, string | null, string | null, string | null]> = [
    ["user", "hi", null, null, null],
    ["assistant", "ASSIST_REASONING_OLD", null, JSON.stringify([{ id: "old" }]), "read"],
    ["tool", "OLD_TOOL_OUTPUT", "old", null, "read"],
    ["assistant", "ASSIST_REASONING_NEW", null, JSON.stringify([{ id: "new" }]), "read"],
    ["tool", "NEW_TOOL_OUTPUT", "new", null, "read"],
  ];
  msgs.forEach(([role, content, tcid, tc, tn]) =>
    db.prepare("INSERT INTO messages(session_id,role,content,tool_call_id,tool_calls,tool_name) VALUES(?,?,?,?,?,?)").run(sid, role, content, tcid, tc, tn));
  db.close();
  return { dbPath, sid };
}

test("hermes-sqlite: resolveHermesSessionByTitle exact + #N lineage", () => {
  const { dbPath, sid } = makeHermesDb();
  assert.equal(resolveHermesSessionByTitle(dbPath, "phonon-sess1"), sid);
  // add a numbered continuation -> should win
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO sessions(id,title,started_at) VALUES(?,?,?)").run("newer_id", "phonon-sess1 #2", 2000);
  db.close();
  assert.equal(resolveHermesSessionByTitle(dbPath, "phonon-sess1"), "newer_id");
  assert.equal(resolveHermesSessionByTitle(dbPath, "no-such"), undefined);
});

test("hermes-sqlite: clears assistant tool_calls + deletes tool rows, keeps reasoning + recent, FTS stays consistent", async () => {
  const { dbPath, sid } = makeHermesDb();
  const r = await dropToolIORowsSqlite({
    dbPath,
    keepRecentToolCalls: 1,
    selectRows: (db) => (db.prepare("SELECT id, role, tool_calls FROM messages WHERE session_id=? ORDER BY id ASC").all(sid) as Array<{ id: number; role: string; tool_calls: string | null }>)
      .map((row) => {
        const hasTc = row.tool_calls != null && row.tool_calls !== "" && row.tool_calls !== "[]";
        return { id: row.id, role: row.role, isTool: row.role === "tool" || hasTc, isToolCall: hasTc };
      }),
    mutateRow: (db, row) => {
      if (row.role === "tool") db.prepare("DELETE FROM messages WHERE id=?").run(row.id);
      else db.prepare("UPDATE messages SET tool_calls=NULL, tool_call_id=NULL, tool_name=NULL WHERE id=?").run(row.id);
    },
  });
  // old assistant tool_calls cleared (1) + old tool row deleted (1) = 2 trimmed; recent pair kept
  assert.equal(r.blocksRemoved, 2);
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT role, content, tool_calls FROM messages WHERE session_id=? ORDER BY id").all(sid) as Array<{ role: string; content: string; tool_calls: string | null }>;
  db.close();
  // reasoning preserved on both assistant rows
  assert.ok(rows.some((x) => x.content === "ASSIST_REASONING_OLD" && x.tool_calls === null));
  assert.ok(rows.some((x) => x.content === "ASSIST_REASONING_NEW" && x.tool_calls !== null)); // recent kept intact
  // old tool output gone, new tool output kept
  assert.equal(rows.some((x) => x.content === "OLD_TOOL_OUTPUT"), false);
  assert.ok(rows.some((x) => x.content === "NEW_TOOL_OUTPUT"));
  // FTS consistency: deleted tool row's content not searchable, kept content still searchable
  const db2 = new DatabaseSync(dbPath);
  const ftsOld = db2.prepare("SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?").get("OLD_TOOL_OUTPUT") as { c: number };
  const ftsNew = db2.prepare("SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?").get("NEW_TOOL_OUTPUT") as { c: number };
  db2.close();
  assert.equal(ftsOld.c, 0);
  assert.equal(ftsNew.c, 1);
});

test("sqlite compress: no tool rows -> no backup, no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phonon-noop-"));
  const dbPath = join(dir, "x.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT)");
  db.prepare("INSERT INTO part VALUES('a', ?)").run(JSON.stringify({ type: "text" }));
  db.close();
  const r = await dropToolIORowsSqlite({
    dbPath,
    selectRows: (d) => (d.prepare("SELECT id,data FROM part").all() as Array<{ id: string; data: string }>).map((row) => ({ id: row.id, isTool: (JSON.parse(row.data) as { type?: string }).type === "tool" })),
    mutateRow: (d, row) => { d.prepare("DELETE FROM part WHERE id=?").run(row.id); },
  });
  assert.equal(r.blocksRemoved, 0);
  assert.equal(r.backups.length, 0);
  // assert no stray backup files
  assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, 0);
  assert.ok(homedir().length > 0); // touch import to satisfy lint
});
