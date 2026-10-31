import { open, lstat, realpath } from "node:fs/promises";
import { nativeVersionAtLeast } from "@agent-phonon/protocol";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, relative, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PeerContextBudget } from "../peer-context.js";
import type { z } from "zod";

export interface ClaudeContextIdentity {
  home: string; cwd: string; sessionId: string; model: string; prompt: string; notBefore: number;
  userMessageId?: string; outputReserve?: number;
  tool?: { name: string; input: unknown; id?: string; phase: "before" | "after"; response?: unknown };
}
export interface ClaudeContextObservation {
  userMessageId: string; lastMessageId: string; toolCallId?: string; completedText?: string;
  budget: z.infer<typeof PeerContextBudget>;
}
const limit = 1024 * 1024, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1000000000;

/** Version-scoped original-root transcript proof, never screen prose or cumulative billing. */
export async function readClaudeContext(file: string, identity: ClaudeContextIdentity): Promise<ClaudeContextObservation | undefined> {
  let handle;
  try {
    if (!uuid.test(identity.sessionId) || identity.userMessageId !== undefined && !uuid.test(identity.userMessageId)
      || !/^claude-(?:sonnet|opus|haiku)-[a-z0-9.\[\]-]+$/.test(identity.model) || !Number.isFinite(identity.notBefore)) return;
    const root = join(await realpath(identity.home), "projects"), actual = await realpath(file), scoped = relative(root, actual), cwd = await realpath(identity.cwd);
    if (isAbsolute(scoped) || scoped === ".." || scoped.startsWith("../") || scoped.startsWith("..\\")
      || basename(actual) !== identity.sessionId + ".jsonl" || await realpath(dirname(actual)) !== dirname(actual)) return;
    let directory = dirname(actual);
    for (;;) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return;
      if (directory === root) break;
      const parent = dirname(directory); if (parent === directory) return; directory = parent;
    }
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || info.size < 1 || info.size > limit) return;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat(); if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) return;
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) { const value = await handle.read(bytes, count, bytes.length - count, null); if (!value.bytesRead) break; count += value.bytesRead; }
    if (count !== before.size || count > limit || bytes[count - 1] !== 10) return;
    const body = bytes.subarray(0, count).toString("utf8");
    if (Buffer.from(body).compare(bytes.subarray(0, count)) !== 0) return;
    let user: any, last: any, usage: number | undefined, trailing = 0, final: string | undefined;
    const seen = new Set<string>(), tools = new Map<string, { name: string; input: unknown; returned: boolean; error: boolean }>();
    let rowCount=0;
    for (const line of body.split("\n").slice(0, -1)) {
      if (!line.trim()) continue;
      if(++rowCount>4096)return;
      const row = JSON.parse(line);
      // Summary indexes do not claim messages; every other record is identity-bearing.
      if (row.type === "summary") continue;
      if (!nativeVersionAtLeast(row.version,"2.0.1") || row.sessionId !== identity.sessionId || typeof row.isSidechain!=="boolean" || row.userType !== "external"
        || typeof row.cwd !== "string" || await realpath(row.cwd) !== cwd || !uuid.test(row.uuid ?? "") || seen.has(row.uuid)) return;
      seen.add(row.uuid);
      const timestamp = Date.parse(row.timestamp);
      if (!Number.isFinite(timestamp)) return;
      // Native delegation interleaves sidechain rows in the root file; they
      // never advance its parent chain, tool authority, usage or final result.
      if(row.isSidechain)continue;
      const prompt = row.type === "user" && row.message?.role === "user" && typeof row.message.content === "string" && row.isMeta !== true;
      if (prompt) {
        // A later human/native follow-up starts a different authority, even if text repeats.
        user = row; last = row; usage = undefined; trailing = 0; final = undefined; tools.clear();
        continue;
      }
      if (!user) continue;
      if (row.parentUuid !== last.uuid || timestamp < Date.parse(last.timestamp)) return;
      last = row;
      if (row.type === "system") {
        if (row.subtype === "compact_boundary" || row.subtype === "error" || row.level === "error") return;
        trailing += Buffer.byteLength(line) + 1; continue;
      }
      if (row.type === "assistant") {
        if (row.message?.role !== "assistant" || row.message.model !== identity.model || row.isApiErrorMessage || row.error) return;
        const native = row.message, value = native.usage;
        final = undefined; usage = undefined; trailing = 0;
        if (value && [value.input_tokens, value.output_tokens, value.cache_creation_input_tokens, value.cache_read_input_tokens].every(integer)) {
          const total = value.input_tokens + value.output_tokens + value.cache_creation_input_tokens + value.cache_read_input_tokens;
          if (integer(total)) usage = total;
        }
        if (!Array.isArray(native.content)) return;
        for (const block of native.content) if (block.type === "tool_use") {
          if (typeof block.id !== "string" || !block.id || block.id.length > 512 || tools.has(block.id) || tools.size >= 256 || typeof block.name !== "string") return;
          tools.set(block.id, { name: block.name, input: block.input, returned: false, error: false });
        }
        if (native.stop_reason === "end_turn" && native.content.every((block: any) => block.type === "text" || block.type === "thinking")) {
          const text = native.content.filter((block: any) => block.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n");
          if (text.trim() && Buffer.byteLength(text) <= 128000 && [...tools.values()].every(tool => tool.returned)) final = text;
        }
      } else if (row.type === "user") {
        if (row.message?.role !== "user" || !Array.isArray(row.message.content)) return;
        for (const block of row.message.content) if (block.type === "tool_result") {
          const tool = tools.get(block.tool_use_id); if (!tool || tool.returned) return;
          tool.returned = true; tool.error = block.is_error === true;
        }
        trailing += Buffer.byteLength(line) + 1;
      } else return;
    }
    if (!user || user.message.content !== identity.prompt || Date.parse(user.timestamp) < identity.notBefore
      || identity.userMessageId !== undefined && user.uuid !== identity.userMessageId) return;
    const after = await handle.stat(), current = await lstat(file);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.isSymbolicLink()
      ||current.nlink!==1||current.uid!==process.getuid?.()||(current.mode&0o022)!==0) return;
    const result: ClaudeContextObservation = { userMessageId: user.uuid, lastMessageId: last.uuid, budget: { state: "unknown", source: "native_estimate" } };
    if (integer(usage) && integer(identity.outputReserve) && identity.outputReserve > 0) {
      const input = usage + trailing + Buffer.byteLength(JSON.stringify(identity.tool?.response ?? null));
      if (integer(input)) result.budget = { state: "known", source: "native_estimate", contextWindowTokens: 200000, inputTokens: input, outputTokens: identity.outputReserve, overheadTokens: 1024 };
    }
    if (identity.tool) {
      if (final) return;
      // 2.0.1 command hooks omit tool IDs and child identity. An overlapping
      // delegated call can emit the same name/args under the parent's hook PID.
      if([...tools.values()].some(tool=>tool.name==="Task"&&!tool.returned))return;
      const matches = [...tools].filter(([id, tool]) => (identity.tool!.id === undefined || id === identity.tool!.id) && tool.name === identity.tool!.name
        && isDeepStrictEqual(tool.input, identity.tool!.input) && (identity.tool!.phase === "before" ? !tool.returned : !tool.error));
      if (matches.length !== 1) return;
      result.toolCallId = matches[0]![0];
    }
    if (final) result.completedText = final;
    return result;
  } catch { return; }
  finally { await handle?.close(); }
}
