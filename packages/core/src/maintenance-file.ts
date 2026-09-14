import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseTree, getNodeValue, modify, applyEdits, type ParseError, type Node as JsonNode } from "jsonc-parser";
import { parseDocument, visit, isAlias, isMap, isScalar, type Document } from "yaml";
import { parse as parseToml, TomlDate } from "smol-toml";
import { PhononError } from "./rpc.js";

export type ConfigFormat = "json" | "jsonc" | "yaml" | "toml" | "text";
export const MAX_CONFIG_BYTES = 1024 * 1024;
const invalid = (message: string): never => { throw new PhononError("errInvalidParams", message); };
export function decodeConfig(raw: Buffer): string {
  if (raw.length > MAX_CONFIG_BYTES) return invalid("config exceeds 1 MiB limit");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { return invalid("config must be valid UTF-8"); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return invalid("binary/control characters are not supported");
  return text;
}
export async function readConfigBytes(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const st = await file.stat();
    if (!st.isFile()) return invalid("config must be a regular file");
    if (st.size > MAX_CONFIG_BYTES) return invalid("config exceeds 1 MiB limit");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const raw = buffer.subarray(0, size);
    decodeConfig(raw);
    return raw;
  } finally { await file.close(); }
}
export function plainMapping(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function validateTree(value: unknown, depth = 0, budget = { n: 0 }): void {
  if (++budget.n > 20000 || depth > 64) return invalid("config complexity budget exceeded");
  if (value instanceof Date) return;
  if (value && typeof value === "object") {
    if (!Array.isArray(value) && !plainMapping(value)) return invalid("unsupported config value type");
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) return invalid("unsafe mapping key");
      validateTree(child, depth + 1, budget);
    }
  }
}
function checkJsonNode(node: JsonNode, depth = 0): void {
  if (depth > 64) return invalid("config complexity budget exceeded");
  if (node.type === "object") {
    const keys = node.children?.map(p => p.children![0]!.value);
    if (new Set(keys).size !== keys?.length) return invalid("duplicate JSON mapping key");
  }
  for (const child of node.children ?? []) checkJsonNode(child, depth + 1);
}
export function yamlDocument(text: string): Document {
  const doc = parseDocument(text, { schema: "core", customTags: [], uniqueKeys: true, merge: false, strict: true });
  // Never return parser excerpts: errors may contain secret source fragments.
  if (doc.errors.length || doc.warnings.length) return invalid("invalid or unsupported YAML (single document, core schema only)");
  let count = 0;
  visit(doc, (_key, node, path) => {
    if (++count > 20000 || path.length > 64) return invalid("YAML complexity budget exceeded");
    if (isAlias(node)) return invalid("YAML aliases are unsupported (alias budget 0)");
    if (node && typeof node === "object" && "tag" in node && node.tag) return invalid("explicit YAML tags are unsupported");
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "<<") return invalid("YAML requires string mapping keys; merge keys unsupported");
    }
  });
  return doc;
}
export function parseConfig(text: string, format: ConfigFormat): unknown {
  decodeConfig(Buffer.from(text));
  const body = text.replace(/^\uFEFF/, "");
  try {
    let value: unknown;
    if (format === "text") return text;
    if (format === "yaml") value = yamlDocument(body).toJS({ maxAliasCount: 0 });
    else if (format === "toml") value = parseToml(body, { maxDepth: 64, integersAsBigInt: "asNeeded" });
    else {
      const errors: ParseError[] = [];
      const tree = parseTree(body, errors, { disallowComments: format === "json", allowTrailingComma: format === "jsonc", allowEmptyContent: false });
      if (errors.length || !tree) return invalid(`invalid ${format} config`);
      checkJsonNode(tree);
      value = getNodeValue(tree);
    }
    validateTree(value);
    return value;
  } catch (error) {
    if (error instanceof PhononError) throw error;
    return invalid(`invalid or unsupported ${format} config`);
  }
}
// A lossless comparison projection for TOML's bigint, nonfinite floats and dates.
// It is not fed back into a serializer or accepted as merge-patch input.
export function comparable(value: unknown): unknown {
  if (value instanceof TomlDate) return { $tomlDate: value.toISOString(), local: value.isLocal(), date: value.isDate(), time: value.isTime() };
  if (typeof value === "bigint") return { $tomlInteger: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map(comparable);
  if (plainMapping(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, comparable(v)]));
  return value;
}
export function equalConfig(a: unknown, b: unknown): boolean {
  if (a instanceof TomlDate || b instanceof TomlDate) return a instanceof TomlDate && b instanceof TomlDate && a.toISOString() === b.toISOString() && a.isLocal() === b.isLocal() && a.isDate() === b.isDate() && a.isTime() === b.isTime();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equalConfig(v, b[i]));
  if (plainMapping(a) || plainMapping(b)) return plainMapping(a) && plainMapping(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equalConfig(a[k], b[k]));
  return isDeepStrictEqual(a, b);
}
export function assertRootChanges(before: unknown, after: unknown, allowed: string[]): void {
  if (!plainMapping(before) || !plainMapping(after)) return invalid("structured maintenance requires a plain mapping root");
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !equalConfig(before[k], after[k]) || Object.hasOwn(before, k) !== Object.hasOwn(after, k));
  if (changed.some(k => !allowed.includes(k))) throw new PhononError("errPolicyDenied", "edit touches non-allowlisted root keys");
}
export function editConfigText(text: string, edits: Array<{ oldText: string; newText: string }>): string {
  if (!edits.length || edits.length > 100) return invalid("edits must contain 1 to 100 replacements");
  const spans = edits.map(({ oldText, newText }) => {
    if (typeof oldText !== "string" || typeof newText !== "string" || Buffer.from(oldText).toString("utf8") !== oldText || Buffer.from(newText).toString("utf8") !== newText) return invalid("edit strings must contain well-formed Unicode");
    if (!oldText || oldText.includes("***") || newText.includes("***")) return invalid("empty match or redacted placeholder in edit");
    const start = text.indexOf(oldText);
    if (start < 0 || text.indexOf(oldText, start + 1) !== -1) return invalid("oldText must match exactly once");
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) if (spans[i]!.start < spans[i - 1]!.end) return invalid("overlapping edits");
  let out = text;
  for (const span of spans.reverse()) out = out.slice(0, span.start) + span.newText + out.slice(span.end);
  decodeConfig(Buffer.from(out));
  return out;
}
/** Source-preserving JSON/JSONC leaf operations; YAML uses its safe Document API.
 * TOML deliberately uses validated exact edits, never stringify or JSON roundtrip. */
export function formatMergePatch(text: string, format: ConfigFormat, current: unknown, patch: Record<string, unknown>): string {
  if (format === "toml" || format === "text") return invalid(`${format} does not support merge patch; use config.edit`);
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  let body = text.slice(bom.length);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const doc = format === "yaml" ? yamlDocument(body) : undefined;
  const walk = (base: unknown, change: Record<string, unknown>, path: string[]): void => {
    for (const [key, value] of Object.entries(change)) {
      const nextPath = [...path, key];
      const old = plainMapping(base) ? base[key] : undefined;
      if (value === null && old === undefined) continue;
      if (plainMapping(value)) {
        if (!plainMapping(old)) set(nextPath, {});
        walk(old, value, nextPath);
      } else if (!equalConfig(old, value)) set(nextPath, value === null ? undefined : value);
    }
  };
  const set = (path: string[], value: unknown): void => {
    if (doc) {
      if (value === undefined) doc.deleteIn(path);
      // Newly inserted collections must be AST nodes before a later setIn
      // descends into them. Scalars stay raw to retain existing node comments.
      else doc.setIn(path, value && typeof value === "object" ? doc.createNode(value) : value);
    }
    else body = applyEdits(body, modify(body, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }));
  };
  validateTree(patch);
  walk(current, patch, []);
  if (doc) {
    body = doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, eol);
    if (!text.endsWith("\n")) body = body.replace(/\r?\n$/, "");
  }
  return bom + body;
}
// Explicit owner attestation is still required for text visibility. This is an
// additional conservative deny, not a claim to recognize every possible secret.
export function uncertainText(text: string): boolean {
  return /(?:api[-_ ]?key|token|secret|password|authorization|credential|cookie|private[-_ ]?key|BEGIN .*PRIVATE|Bearer\s|https?:\/\/[^\s/]+:[^\s/]+@)/i.test(text);
}
