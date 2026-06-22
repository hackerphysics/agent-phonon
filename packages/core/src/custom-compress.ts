import { copyFile, rename, readFile, writeFile } from "node:fs/promises";

export interface DropToolIOResult {
  filesChanged: number;
  recordsChanged: number;
  blocksRemoved: number;
  bytesBefore: number;
  bytesAfter: number;
  backups: string[];
}

export interface DropToolIOOptions {
  /** 保留最近 N 个 tool call 及其对应 result/中间块；默认 3。 */
  keepRecentToolCalls?: number;
  /**
   * 文件级算好的「保留集」(按对象引用)。
   * 用引用集而非 id，能正确保留**没有 id 的最近 tool 块**(item 3 修复)。
   */
  keepToolBlocks?: Set<unknown>;
  /** 兼容旧路径：按 id 保留(仍支持，但 keepToolBlocks 优先)。 */
  keepToolCallIds?: Set<string>;
}

export function dropToolIOFromValue(value: unknown, options: DropToolIOOptions = {}): { value: unknown; changed: boolean; removed: number } {
  if (Array.isArray(value)) {
    let changed = false;
    let removed = 0;
    const out: unknown[] = [];
    for (const item of value) {
      if (isToolBlock(item) && !shouldKeepToolBlock(item, options)) {
        changed = true;
        removed++;
        continue;
      }
      const r = dropToolIOFromValue(item, options);
      changed ||= r.changed;
      removed += r.removed;
      out.push(r.value);
    }
    return { value: out, changed, removed };
  }
  if (value && typeof value === "object") {
    if (isToolBlock(value) && !shouldKeepToolBlock(value, options)) return { value: undefined, changed: true, removed: 1 };
    let changed = false;
    let removed = 0;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, v] of Object.entries(out)) {
      if (isToolBlock(v) && !shouldKeepToolBlock(v, options)) {
        delete out[k];
        changed = true;
        removed++;
        continue;
      }
      const r = dropToolIOFromValue(v, options);
      changed ||= r.changed;
      removed += r.removed;
      out[k] = r.value;
    }
    return { value: out, changed, removed };
  }
  return { value, changed: false, removed: 0 };
}

function shouldKeepToolBlock(value: unknown, options: DropToolIOOptions): boolean {
  if (options.keepToolBlocks?.has(value)) return true;
  const id = toolBlockId(value);
  return !!id && !!options.keepToolCallIds?.has(id);
}

function toolBlockId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const id = o.id ?? o.toolCallId ?? o.tool_call_id ?? o.tool_use_id ?? o.call_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const t = (value as Record<string, unknown>).type;
  return t === "tool_use" || t === "tool_call" || t === "function_call";
}

/** 按文档顺序收集所有 tool 块的对象引用(块是原子单位，命中即不再深入)。 */
function collectToolBlocks(value: unknown, out: unknown[]): void {
  if (isToolBlock(value)) { out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectToolBlocks(item, out); return; }
  if (value && typeof value === "object") { for (const v of Object.values(value)) collectToolBlocks(v, out); }
}

/**
 * 文件级计算「保留集」：保留最近 keepRecent 个 tool **call** 起、直到末尾的所有 tool 块
 * (含中间的 result、以及没有 id 的块)。基于位置而非 id —— 这样最近但无 id 的块也能保留。
 */
export function computeKeepToolBlocks(records: unknown[], keepRecent: number): Set<unknown> {
  if (keepRecent <= 0) return new Set();
  const blocks: unknown[] = [];
  for (const r of records) collectToolBlocks(r, blocks);
  if (blocks.length === 0) return new Set();
  const callIdx: number[] = [];
  blocks.forEach((b, i) => { if (isToolCall(b)) callIdx.push(i); });
  if (callIdx.length === 0) {
    // 没有明确的 call 块：退化为保留末尾 keepRecent 个任意 tool 块
    return new Set(blocks.slice(Math.max(0, blocks.length - keepRecent)));
  }
  const cutoff = callIdx[Math.max(0, callIdx.length - keepRecent)]!;
  return new Set(blocks.slice(cutoff));
}

function isToolBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  // Anthropic / Claude Code / OpenClaw content blocks.
  if (type === "tool_use" || type === "tool_result") return true;
  // Phonon/OpenClaw trajectory style events; keep ordinary text/message records.
  if (type === "tool_call" || type === "tool_result_delta") return true;
  // Codex response_item / OpenAI Responses style.
  if (type === "function_call" || type === "function_call_output" || type === "custom_tool_call" || type === "custom_tool_call_output" || type === "local_shell_call") return true;
  const role = typeof o.role === "string" ? o.role : "";
  // Some providers encode tool-return messages by role/name instead of content block type.
  if (role === "tool") return true;
  return false;
}

export async function dropToolIOFromJsonlFiles(files: string[], options: DropToolIOOptions = {}): Promise<DropToolIOResult> {
  const result: DropToolIOResult = { filesChanged: 0, recordsChanged: 0, blocksRemoved: 0, bytesBefore: 0, bytesAfter: 0, backups: [] };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const keepRecent = options.keepRecentToolCalls ?? 3;
  for (const file of files) {
    const before = await readFile(file, "utf8");
    result.bytesBefore += Buffer.byteLength(before);
    const lines = before.split(/\n/);
    const parsed: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) { parsed.push(undefined); continue; }
      try {
        parsed.push(JSON.parse(line) as unknown);
      } catch {
        parsed.push(undefined);
      }
    }
    // 文件级保留集(按引用，覆盖最近 keepRecent 个 call 起的所有 tool 块)。
    const keepToolBlocks = computeKeepToolBlocks(parsed, keepRecent);
    let fileChanged = false;
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      const obj = parsed[i];
      if (obj === undefined) {
        out.push(line); // 不可解析行原样保留
        continue;
      }
      const r = dropToolIOFromValue(obj, { ...options, keepToolBlocks });
      if (r.changed) {
        fileChanged = true;
        result.recordsChanged++;
        result.blocksRemoved += r.removed;
      }
      out.push(JSON.stringify(r.value));
    }
    const after = out.join("\n");
    result.bytesAfter += Buffer.byteLength(after);
    if (fileChanged) {
      const backup = `${file}.bak-${stamp}`;
      await copyFile(file, backup);
      await writeFile(`${file}.tmp-${stamp}`, after);
      await rename(`${file}.tmp-${stamp}`, file);
      result.filesChanged++;
      result.backups.push(backup);
    }
  }
  return result;
}
