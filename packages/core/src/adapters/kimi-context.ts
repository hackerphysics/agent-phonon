import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

export interface KimiWireIdentity {
  nativeVersion: string;
  shareDir: string;
  cwd: string;
  sessionId: string;
  prompt: string;
  notBefore: number;
  turnId?: string;
  tool?: { id: string; name: string; arguments: string };
}

/** Original-root request evidence only, not native consent, budget or completion. */
export interface KimiWireProof {
  turnId: string;
  startedAt: number;
  step: number;
  snapshotHash: string;
  toolCallId?: string;
}

const maxBytes = 4 * 1024 * 1024, maxRows = 8192;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const id = z.string().min(1).max(512);
const envelope = z.object({ type: z.string().min(1).max(64), payload: z.record(z.unknown()) });
const record = z.object({ timestamp: z.number().finite().nonnegative(), message: envelope });
const toolCall = z.object({ type: z.literal("function"), id,
  function: z.object({ name: id, arguments: z.string().max(32768) }) });
const toolResult = z.object({ tool_call_id: id, return_value: z.object({ is_error: z.boolean() }) });
const approval = z.object({ id, tool_call_id: id, source_kind: z.literal("foreground_turn"), source_id: id,
  agent_id: z.null().optional(), subagent_type: z.null().optional() });
const approvalResponse = z.object({ request_id: id, response: z.enum(["approve", "approve_for_session", "reject"]) });
const hook = z.object({ event: id, target: z.string().max(512).default("") });
type PendingTool = { name: string; arguments: string; returned: boolean };

function owned(info: Stats): boolean {
  return info.uid === process.getuid?.() && (info.mode & 0o022) === 0 && !info.isSymbolicLink();
}

/** Kimi CLI 1.40.0 / Wire 1.9. No active binding is enabled by this reader. */
export async function readKimiWireProof(file: string, identity: KimiWireIdentity): Promise<KimiWireProof | undefined> {
  let handle;
  try {
    if (process.platform === "win32" || identity.nativeVersion !== "1.40.0" || !uuid.test(identity.sessionId)
      || !isAbsolute(file) || !isAbsolute(identity.shareDir) || !isAbsolute(identity.cwd)
      || !Number.isFinite(identity.notBefore) || identity.notBefore < 0
      || identity.turnId !== undefined && !/^[a-f0-9]{64}$/.test(identity.turnId)) return;
    const share = await realpath(identity.shareDir), cwd = await realpath(identity.cwd);
    const expected = join(share, "sessions", createHash("md5").update(cwd).digest("hex"), identity.sessionId, "wire.jsonl");
    if (file !== expected || await realpath(file) !== expected) return;
    const directories: Array<{ path: string; dev: number; ino: number }> = [];
    for (let path = dirname(expected); ; path = dirname(path)) {
      const info = await lstat(path);
      if (!info.isDirectory() || !owned(info)) return;
      directories.push({ path, dev: info.dev, ino: info.ino });
      if (path === share) break;
      if (dirname(path) === path) return;
    }
    const info = await lstat(file);
    if (!info.isFile() || !owned(info) || info.nlink !== 1 || info.size < 1 || info.size > maxBytes) return;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) return;
    const bytes = Buffer.alloc(Math.min(maxBytes, before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const value = await handle.read(bytes, size, bytes.length - size, null);
      if (!value.bytesRead) break;
      size += value.bytesRead;
    }
    if (size !== before.size || bytes[size - 1] !== 10) return;
    const raw = bytes.subarray(0, size), body = raw.toString("utf8");
    if (!Buffer.from(body).equals(raw)) return;
    const lines = body.split("\n").slice(0, -1);
    if (lines.length < 2 || lines.length > maxRows) return;
    const header = JSON.parse(lines[0]!);
    if (header.type !== "metadata" || header.protocol_version !== "1.9") return;
    let offset = Buffer.byteLength(lines[0]!) + 1, previousTime = 0, candidates = 0;
    let turn: { id: string; startedAt: number; prompt: unknown; step: number; valid: boolean } | undefined;
    const tools = new Map<string, PendingTool>(), approvals = new Map<string, string>();
    const requestIds = new Set<string>(), questions = new Set<string>(), hooks = new Map<string, number>();
    for (const line of lines.slice(1)) {
      offset += Buffer.byteLength(line) + 1;
      const row = record.parse(JSON.parse(line));
      if (row.timestamp < previousTime || row.timestamp * 1000 > Date.now() + 1000) return;
      previousTime = row.timestamp;
      const { type, payload } = row.message;
      if (type === "TurnBegin") {
        if (row.timestamp * 1000 >= identity.notBefore) candidates++;
        turn = { id: createHash("sha256").update(raw.subarray(0, offset)).digest("hex"),
          startedAt: row.timestamp * 1000, prompt: payload.user_input, step: 0, valid: true };
        tools.clear(); approvals.clear(); requestIds.clear(); questions.clear(); hooks.clear();
        continue;
      }
      if (!turn) continue;
      if (!turn.valid) continue;
      switch (type) {
        case "StepBegin": {
          const step = z.number().int().positive().max(100000).parse(payload.n);
          if (step !== turn.step + 1 || approvals.size || questions.size || hooks.size
            || [...tools.values()].some(tool => !tool.returned)) return;
          turn.step = step;
          break;
        }
        case "ToolCall": {
          const call = toolCall.parse(payload);
          const argumentsValue: unknown = JSON.parse(call.function.arguments);
          if (!turn.step || tools.has(call.id) || tools.size >= 256 || argumentsValue === null
            || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return;
          tools.set(call.id, { name: call.function.name, arguments: call.function.arguments, returned: false });
          break;
        }
        case "ToolResult": {
          const result = toolResult.parse(payload), tool = tools.get(result.tool_call_id);
          if (!tool || tool.returned || [...approvals.values()].includes(result.tool_call_id)) return;
          tool.returned = true;
          questions.delete(result.tool_call_id);
          break;
        }
        case "ApprovalRequest": {
          const request = approval.parse(payload), tool = tools.get(request.tool_call_id);
          if (!tool || tool.returned || requestIds.has(request.id) || approvals.size >= 256) return;
          requestIds.add(request.id); approvals.set(request.id, request.tool_call_id);
          break;
        }
        case "ApprovalResponse": {
          const response = approvalResponse.parse(payload);
          if (!approvals.delete(response.request_id)) return;
          if (response.response === "reject") turn.valid = false;
          break;
        }
        case "QuestionRequest": {
          const request = z.object({ id, tool_call_id: id }).parse(payload), tool = tools.get(request.tool_call_id);
          if (!tool || tool.returned || requestIds.has(request.id)) return;
          requestIds.add(request.id); questions.add(request.tool_call_id);
          break;
        }
        case "HookTriggered": {
          const value = hook.parse(payload), key = JSON.stringify([value.event, value.target]);
          hooks.set(key, (hooks.get(key) ?? 0) + 1);
          break;
        }
        case "HookResolved": {
          const value = hook.extend({ action: z.enum(["allow", "block"]) }).parse(payload);
          const key = JSON.stringify([value.event, value.target]), count = hooks.get(key);
          if (!count) return;
          if (count === 1) hooks.delete(key); else hooks.set(key, count - 1);
          if (value.action === "block") turn.valid = false;
          break;
        }
        case "SubagentEvent": {
          // Children share the native session ID; only root Agent tool/result
          // pairs can delimit their lifetime. Nested events never grant root authority.
          const child = z.object({ parent_tool_call_id: id, agent_id: id, event: envelope }).parse(payload);
          const parent = tools.get(child.parent_tool_call_id);
          if (!parent || parent.name !== "Agent" || parent.returned) return;
          break;
        }
        case "ContentPart":
          z.union([z.object({ type: z.literal("text"), text: z.string() }),
            z.object({ type: z.literal("think"), think: z.string() })]).parse(payload);
          break;
        case "StatusUpdate":
        case "Notification":
        case "MCPLoadingBegin":
        case "MCPLoadingEnd": break;
        // TurnEnd also occurs after native prompt blocking/rejection. It is not success.
        case "TurnEnd":
        case "SteerInput":
        case "StepInterrupted":
        case "CompactionBegin":
        case "CompactionEnd":
        case "BtwBegin":
        case "BtwEnd":
        case "HookRequest":
        case "ToolCallRequest":
        default: turn.valid = false;
      }
    }
    if (!turn?.valid || !turn.step || candidates !== 1 || turn.prompt !== identity.prompt || turn.startedAt < identity.notBefore
      || identity.turnId !== undefined && turn.id !== identity.turnId || approvals.size || questions.size || hooks.size
      || [...tools.values()].some(tool => tool.name === "Agent" && !tool.returned)) return;
    let toolCallId: string | undefined;
    if (identity.tool) {
      const tool = tools.get(identity.tool.id);
      if (!tool || tool.returned || tool.name !== identity.tool.name || tool.arguments !== identity.tool.arguments) return;
      toolCallId = identity.tool.id;
    }
    const after = await handle.stat(), current = await lstat(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs
      || !current.isFile() || !owned(current) || current.nlink !== 1 || await realpath(file) !== expected) return;
    for (const directory of directories) {
      const current = await lstat(directory.path);
      if (current.dev !== directory.dev || current.ino !== directory.ino || !current.isDirectory() || !owned(current)) return;
    }
    return { turnId: turn.id, startedAt: turn.startedAt, step: turn.step,
      snapshotHash: createHash("sha256").update(raw).digest("hex"), ...(toolCallId ? { toolCallId } : {}) };
  } catch { return; }
  finally { await handle?.close(); }
}
