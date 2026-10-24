import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { PhononError } from "../rpc.js";

const MAX_BYTES = 32 * 1024 * 1024;
const text = z.string().min(1).max(4096);
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const Header = z.object({ type: z.literal("session"), version: z.literal(3), id: text, timestamp: text, cwd: text, parentSession: text.optional() }).strict();
export const PiNativeObservation = z.object({
  home: text, cwd: text, sessionDir: text, path: text, sessionId: text, timestamp: text, nativeModel: text,
  device: text, inode: text, owner: z.number().int().nonnegative(), homeInode: text, directoryInode: text,
  bytes: z.number().int().positive().max(MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.number().int().positive(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  continuation: z.literal(true).optional(),
}).strict();
export type PiNativeObservation = z.infer<typeof PiNativeObservation>;
export const PiCheckpoint = z.object({
  phononSessionId: text, model: text, native: PiNativeObservation, pendingInject: z.array(z.string()).max(256), modelSwitchPending: z.boolean(),
}).strict();
export type PiCheckpoint = z.infer<typeof PiCheckpoint>;

export function piRecoveryFailure(): PhononError {
  return new PhononError("errSessionBusy", "Pi native session identity or settled history could not be verified; no fresh session was started");
}

function expandPath(value: string): string {
  return resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

function directory(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || typeof process.getuid !== "function" || stat.uid !== process.getuid()) throw piRecoveryFailure();
  return `${stat.dev}:${stat.ino}`;
}

/** Match the installed Pi v3 layout. Remote overlays never select these paths. */
export function piSessionLocation(cwd: string): { home: string; cwd: string; sessionDir: string } {
  const home = realpathSync(expandPath(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")));
  const workspace = realpathSync(cwd);
  const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
    ? realpathSync(expandPath(process.env.PI_CODING_AGENT_SESSION_DIR))
    : join(home, "sessions", encoded);
  return { home, cwd: workspace, sessionDir };
}

/** Continuation proves the original graph and active model, not task success.
 * Pi owns message normalization; its launch guard checks the complete loaded
 * snapshot so skipped records or silent migrations cannot lose context. */
function continuationModel(rows: unknown[]): string {
  const Entry = z.object({ type: text, id: text, parentId: z.string().nullable(), timestamp: text }).passthrough();
  const entries = new Map<string, z.infer<typeof Entry>>();
  let leaf: z.infer<typeof Entry> | undefined;
  for (const raw of rows.slice(1)) {
    const entry = Entry.parse(raw);
    if (entries.has(entry.id) || entry.parentId !== null && !entries.has(entry.parentId) || !Number.isFinite(Date.parse(entry.timestamp))) throw piRecoveryFailure();
    entries.set(entry.id, entry); leaf = entry;
  }
  while (leaf) {
    if (leaf.type === "model_change") {
      const selected = z.object({ provider: text, modelId: text }).parse(leaf);
      return `${selected.provider}/${selected.modelId}`;
    }
    if (leaf.type === "message") {
      const message = z.object({ role: text }).passthrough().parse(leaf.message);
      if (message.role === "assistant") {
        const selected = z.object({ provider: text, model: text }).parse(message);
        return `${selected.provider}/${selected.model}`;
      }
    }
    leaf = leaf.parentId === null ? undefined : entries.get(leaf.parentId);
  }
  throw piRecoveryFailure();
}

/** The separate settled observer remains useful for positive completion proof. */
function inspectTranscript(rows: unknown[], continuation = false): { header: z.infer<typeof Header>; nativeModel: string } {
  const header = Header.parse(rows[0]);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(header.id) || !Number.isFinite(Date.parse(header.timestamp))) throw piRecoveryFailure();
  if (continuation) return { header, nativeModel: continuationModel(rows) };
  let parent: string | null = null;
  let model = "";
  let lastRole = "";
  let lastStop = "";
  let users = 0;
  let retryModel: string | undefined;
  const ids = new Set<string>();
  const pending = new Map<string, string>();
  const calls = new Set<string>();
  for (const raw of rows.slice(1)) {
    const entry = z.object({ type: text, id: text, parentId: z.string().nullable(), timestamp: text }).passthrough().parse(raw);
    if (entry.parentId !== parent || ids.has(entry.id) || !Number.isFinite(Date.parse(entry.timestamp))) throw piRecoveryFailure();
    ids.add(entry.id);
    parent = entry.id;
    switch (entry.type) {
      case "model_change": {
        const record = z.object({ provider: text, modelId: text }).parse(entry);
        if (pending.size || retryModel) throw piRecoveryFailure();
        model = `${record.provider}/${record.modelId}`;
        break;
      }
      case "message": {
        const message = z.object({ role: z.enum(["user", "assistant", "toolResult"]), content: z.array(z.record(z.unknown())) }).passthrough().parse(entry.message);
        if (message.role !== "toolResult" && pending.size) throw piRecoveryFailure();
        for (const block of message.content) {
          if (block.type === "text" || block.type === "thinking") {
            if (typeof block[block.type] !== "string") throw piRecoveryFailure();
          } else if (block.type === "image") {
            if (typeof block.data !== "string" || typeof block.mimeType !== "string") throw piRecoveryFailure();
          } else if (block.type === "toolCall" && message.role === "assistant") {
            const call = z.object({ id: text, name: text, arguments: z.record(z.unknown()) }).parse(block);
            if (calls.has(call.id)) throw piRecoveryFailure();
            calls.add(call.id);
            pending.set(call.id, call.name);
          } else throw piRecoveryFailure();
        }
        if (message.role === "user") {
          if (pending.size || retryModel) throw piRecoveryFailure();
          users++;
        } else if (message.role === "assistant") {
          const assistant = z.object({ provider: text, model: text, stopReason: z.enum(["stop", "length", "toolUse", "error"]) }).parse(message);
          if ((pending.size > 0) !== (assistant.stopReason === "toolUse")) throw piRecoveryFailure();
          const assistantModel = `${assistant.provider}/${assistant.model}`;
          if (retryModel && retryModel !== assistantModel) throw piRecoveryFailure();
          // Native retry/overflow recovery retains failed attempts in the file.
          // They are not settled without same-model success before any new input.
          retryModel = assistant.stopReason === "error" ? assistantModel : undefined;
          // Pi getSessionContextSettings also restores from assistant messages:
          // --model on an existing session need not append model_change.
          model = assistantModel;
          lastStop = assistant.stopReason;
        } else {
          const result = z.object({ toolCallId: text, toolName: text, isError: z.boolean() }).parse(message);
          if (pending.get(result.toolCallId) !== result.toolName) throw piRecoveryFailure();
          pending.delete(result.toolCallId);
        }
        lastRole = message.role;
        break;
      }
      case "thinking_level_change":
        z.object({ thinkingLevel: text }).parse(entry);
        break;
      case "session_info":
        z.object({ name: z.string().optional() }).parse(entry);
        break;
      case "custom":
        z.object({ customType: text }).parse(entry);
        break;
      case "label":
        if (typeof entry.targetId !== "string" || !ids.has(entry.targetId)) throw piRecoveryFailure();
        break;
      case "compaction":
        if (pending.size || typeof entry.summary !== "string" || typeof entry.firstKeptEntryId !== "string" || !ids.has(entry.firstKeptEntryId) || typeof entry.tokensBefore !== "number") throw piRecoveryFailure();
        break;
      default:
        throw piRecoveryFailure();
    }
  }
  if (!users || !model || pending.size || retryModel || lastRole !== "assistant" || !["stop", "length"].includes(lastStop)) throw piRecoveryFailure();
  return { header, nativeModel: model };
}

export function observePiSession(cwd: string, sessionId: string, timestamp: string, path?: string, continuation = false): PiNativeObservation {
  let fd: number | undefined;
  try {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp)) throw piRecoveryFailure();
    const location = piSessionLocation(cwd);
    const expected = join(location.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    if (path !== undefined && (!isAbsolute(path) || path !== expected)) throw piRecoveryFailure();
    const homeInode = directory(location.home), directoryInode = directory(location.sessionDir);
    if (realpathSync(location.sessionDir) !== location.sessionDir || realpathSync(expected) !== expected) throw piRecoveryFailure();
    fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid!() || (before.mode & 0o022) !== 0 || before.size <= 0 || before.size > MAX_BYTES) throw piRecoveryFailure();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd), current = lstatSync(expected);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) throw piRecoveryFailure();
    const content = bytes.toString("utf8");
    if (!content.endsWith("\n") || !Buffer.from(content).equals(bytes)) throw piRecoveryFailure();
    const rows = content.slice(0, -1).split("\n").map(line => JSON.parse(line));
    const { header, nativeModel } = inspectTranscript(rows, continuation);
    if (header.id !== sessionId || header.timestamp !== timestamp || header.cwd !== cwd || realpathSync(header.cwd) !== location.cwd) throw piRecoveryFailure();
    return PiNativeObservation.parse({ ...location, path: expected, sessionId, timestamp, nativeModel,
      device: String(before.dev), inode: String(before.ino), owner: before.uid, homeInode, directoryInode,
      bytes: bytes.length, sha256: digest(bytes), entries: rows.length, snapshotHash: digest(JSON.stringify(rows)),
      ...(continuation ? { continuation: true } : {}),
    });
  } catch { throw piRecoveryFailure(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A daemon-side kill (turn timeout or user interrupt) SIGTERMs Pi while a tool is
 * running. Pi then cannot append the matching toolResult, so the transcript ends
 * with an assistant `toolUse` that never settles. inspectTranscript rightly refuses
 * that shape, but refusing forever bricks the Phonon Session: every later send and
 * every reattach fails with errSessionBusy. The prefix before the interrupted turn
 * is still an intact settled session, so roll the file back to its last settled
 * assistant entry. Only the exact file identity in `expected` is ever rewritten, and
 * the surviving prefix must pass the full strict inspection before the rename. */
export function rescuePiSession(cwd: string, sessionId: string, path: string, expected?: PiNativeObservation): PiNativeObservation {
  let fd: number | undefined;
  try {
    const location = piSessionLocation(cwd);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId) || !isAbsolute(path) || dirname(path) !== location.sessionDir) throw piRecoveryFailure();
    if (realpathSync(location.sessionDir) !== location.sessionDir || realpathSync(path) !== path) throw piRecoveryFailure();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0 || stat.size <= 0 || stat.size > MAX_BYTES) throw piRecoveryFailure();
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw piRecoveryFailure();
    if (expected && (String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode
      || stat.size !== expected.bytes || digest(bytes) !== expected.sha256
      || location.home !== expected.home || location.sessionDir !== expected.sessionDir)) throw piRecoveryFailure();
    const content = bytes.toString("utf8");
    if (!content.endsWith("\n") || !Buffer.from(content).equals(bytes)) throw piRecoveryFailure();
    const rows = content.slice(0, -1).split("\n").map(line => JSON.parse(line));
    const header = Header.parse(rows[0]);
    if (header.id !== sessionId || header.cwd !== cwd || realpathSync(header.cwd) !== location.cwd) throw piRecoveryFailure();
    if (expected && (header.id !== expected.sessionId || header.timestamp !== expected.timestamp)) throw piRecoveryFailure();
    // Only a linear chain may be rolled back; anything ambiguous is left untouched.
    let parent: string | null = null;
    let boundary = -1;
    const ids = new Set<string>();
    const pending = new Map<string, string>();
    for (let index = 1; index < rows.length; index++) {
      const entry = z.object({ type: text, id: text, parentId: z.string().nullable() }).passthrough().parse(rows[index]);
      if (entry.parentId !== parent || ids.has(entry.id)) throw piRecoveryFailure();
      ids.add(entry.id);
      parent = entry.id;
      if (entry.type !== "message") continue;
      const message = z.object({ role: z.enum(["user", "assistant", "toolResult"]), content: z.array(z.record(z.unknown())) }).passthrough().parse(entry.message);
      if (message.role === "assistant") {
        let calls = 0;
        for (const block of message.content) {
          if (block.type === "toolCall") { calls++; pending.set(String(block.id), String(block.name)); }
        }
        if (calls === 0 && pending.size === 0) boundary = index;
      } else if (message.role === "toolResult") {
        pending.delete(String((entry.message as Record<string, unknown>).toolCallId));
      } else if (pending.size) throw piRecoveryFailure();
    }
    if (boundary < 1) throw piRecoveryFailure();
    if (boundary === rows.length - 1) return observePiSession(cwd, sessionId, header.timestamp, path);
    const prefix = rows.slice(0, boundary + 1);
    // Prove the surviving prefix is a settled transcript before touching the file.
    inspectTranscript(prefix);
    const staging = join(location.sessionDir, `.${randomUUID()}.rescue`);
    writeFileSync(staging, prefix.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600, flag: "wx" });
    renameSync(staging, path);
    return observePiSession(cwd, sessionId, header.timestamp, path);
  } catch { throw piRecoveryFailure(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function verifyPiSession(saved: PiNativeObservation, cwd: string): PiNativeObservation {
  const observed = observePiSession(cwd, saved.sessionId, saved.timestamp, saved.path, saved.continuation === true);
  if (Object.entries(saved).some(([key, value]) => observed[key as keyof PiNativeObservation] !== value)) throw piRecoveryFailure();
  return observed;
}

/** RPC identifies its native path before the first prompt creates the file.
 * Read only that canonical directory, then reuse the complete settled proof. */
export function observePiRpcSession(cwd: string, sessionId: string, path: string, continuation = false): PiNativeObservation {
  let fd: number | undefined;
  try {
    const location = piSessionLocation(cwd);
    if (!isAbsolute(path) || dirname(path) !== location.sessionDir) throw piRecoveryFailure();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw piRecoveryFailure();
    const bytes = readFileSync(fd), end = bytes.indexOf(10);
    if (end < 0 || end > 16384) throw piRecoveryFailure();
    const header = Header.parse(JSON.parse(bytes.subarray(0, end).toString("utf8")));
    if (header.id !== sessionId || header.cwd !== cwd) throw piRecoveryFailure();
    return observePiSession(cwd, sessionId, header.timestamp, path, continuation);
  } catch { throw piRecoveryFailure(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** A private, per-launch extension closes Pi's create-if-missing race. Registration
 * is acknowledged before stdin is released; session_start runs before prompt(),
 * including automatic compaction. No dependency on remote-controlled env values. */
export function materializePiRecoveryGuard(saved: PiNativeObservation, model: string): { path: string; acknowledgement: string; cleanup: () => void } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "phonon-pi-recovery-"));
  const path = join(root, "guard.mjs"), acknowledgement = `phonon-pi-guard:${randomUUID()}`;
  const source = `import {createHash} from "node:crypto";
import {lstatSync,readFileSync,realpathSync} from "node:fs";
const saved=${JSON.stringify(saved)}, requested=${JSON.stringify(model)};
const hash=value=>createHash("sha256").update(value).digest("hex");
const fail=()=>{process.stderr.write("Pi native recovery guard rejected continuation\\n");process.exit(78);};
export default function activate(pi){
  const identity=ctx=>{
    const sm=ctx.sessionManager,h=sm.getHeader(),m=ctx.model;
    if(sm.getSessionId()!==saved.sessionId||sm.getSessionFile()!==saved.path||realpathSync(ctx.cwd)!==saved.cwd||h?.id!==saved.sessionId||h?.timestamp!==saved.timestamp||realpathSync(h.cwd)!==saved.cwd||!m)fail();
    const actual=m.provider+"/"+m.id;
    if(requested==="default"?actual!==saved.nativeModel:requested!==actual&&requested!==m.id)fail();
  };
  pi.on("session_start",(_event,ctx)=>{try{
    identity(ctx);
    for(const [path,inode] of [[saved.home,saved.homeInode],[saved.sessionDir,saved.directoryInode]]){
      const s=lstatSync(path);if(!s.isDirectory()||s.uid!==saved.owner||(s.mode&0o022)!==0||s.dev+":"+s.ino!==inode||realpathSync(path)!==path)fail();
    }
    const s=lstatSync(saved.path),bytes=readFileSync(saved.path);
    if(!s.isFile()||s.nlink!==1||s.uid!==saved.owner||(s.mode&0o022)!==0||String(s.dev)!==saved.device||String(s.ino)!==saved.inode||realpathSync(saved.path)!==saved.path||hash(bytes.subarray(0,saved.bytes))!==saved.sha256)fail();
    const rows=[ctx.sessionManager.getHeader(),...ctx.sessionManager.getEntries()];
    if(hash(JSON.stringify(rows.slice(0,saved.entries)))!==saved.snapshotHash)fail();
    const extra=bytes.subarray(saved.bytes).toString("utf8");
    if(extra&&(!extra.endsWith("\\n")||extra.trim().split("\\n").some(line=>!["thinking_level_change","model_change"].includes(JSON.parse(line).type))))fail();
  }catch{fail();}});
  for(const event of ["input","before_agent_start","before_provider_request","tool_call"])
    pi.on(event,(_event,ctx)=>{try{identity(ctx);}catch{fail();}});
  process.stderr.write(${JSON.stringify(acknowledgement + "\n")});
}
`;
  try { writeFileSync(path, source, { mode: 0o600, flag: "wx" }); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  return { path, acknowledgement, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
