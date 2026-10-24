import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyEdits, modify, parse as parseJson, parseTree, type Node, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import {McpConfigurationError,windowsMcpFileOperation} from "./managed-mcp-security.js";
import {managedMcpEntryName} from "./managed-mcp-source.js";
export {McpConfigurationError} from "./managed-mcp-security.js";

export type ManagedAgentKind = "codex" | "claude-code" | "copilot" | "opencode" | "pi" | "hermes" | "openclaw";
export interface McpConfigTarget { path: string; format: "json" | "toml" | "yaml"; keys: string[]; entry: Record<string, unknown> }
export interface OwnedMcpEntry extends McpConfigTarget { name: string; block?: string }
const fail = (code: string): never => { throw new McpConfigurationError(code); };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function managedConfigTarget(agent: string, binding: string, command: string, args: string[], options: {
  home?: string; paths?: Record<string, string>; env?: NodeJS.ProcessEnv;sourceFingerprint?:string;
} = {}): OwnedMcpEntry | undefined {
  const home = options.home ?? homedir(), env = options.env ?? process.env, kind = agent.split(":")[0] as ManagedAgentKind;
  const name = managedMcpEntryName(binding,options.sourceFingerprint), stdio = { command, args };
  const override = options.paths?.[agent];
  if (agent.includes(":") && !["hermes:default", "openclaw:main"].includes(agent) && !override) return undefined;
  if (kind === "openclaw" && !["openclaw", "openclaw:main"].includes(agent)) return undefined;
  const defaults: Record<ManagedAgentKind, Omit<McpConfigTarget, "path"> & { path: string }> = {
    codex: { path: join(env.CODEX_HOME || join(home, ".codex"), "config.toml"), format: "toml", keys: ["mcp_servers", name], entry: stdio },
    "claude-code": { path: join(home, ".claude.json"), format: "json", keys: ["mcpServers", name], entry: { type: "stdio", ...stdio } },
    copilot: { path: join(home, ".copilot", "mcp-config.json"), format: "json", keys: ["mcpServers", name], entry: { type: "local", ...stdio, tools: ["*"] } },
    opencode: { path: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "opencode.json"), format: "json", keys: ["mcp", name], entry: { type: "local", command: [command, ...args], enabled: true } },
    pi: { path: join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "mcp.json"), format: "json", keys: ["mcpServers", name], entry: stdio },
    hermes: { path: join(env.HERMES_HOME || join(home, ".hermes"), "config.yaml"), format: "yaml", keys: ["mcp_servers", name], entry: stdio },
    openclaw: { path: env.OPENCLAW_CONFIG_PATH || join(env.OPENCLAW_STATE_DIR || join(home, ".openclaw"), "openclaw.json"), format: "json", keys: ["mcp", "servers", name], entry: { transport: "stdio", ...stdio, enabled: true } },
  };
  if (!Object.hasOwn(defaults, kind)) return undefined;
  const target = defaults[kind];
  return { ...target, path: resolve(override ?? target.path), name };
}

function secureDirectory(path: string) {
  if(process.platform==="win32"){windowsMcpFileOperation("directory",path);return;}
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) fail("mcp_config_directory_untrusted");
  // Pin existing parent identity; do not follow redirected dotfile directories.
  if (realpathSync(path) !== resolve(path)) fail("mcp_config_symlink_refused");
}
export function readPrivateFile(path: string, limit = 1024 * 1024, privateOnWindows = false): string | undefined {
  if (process.platform === "win32") return windowsMcpFileOperation("read", path, { private: privateOnWindows, limit });
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new McpConfigurationError("mcp_config_file_untrusted"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) fail("mcp_config_file_untrusted");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function withConfigLock<T>(path: string, fn: () => T): T {
  if(process.platform==="win32"){
    const lock=path+".phonon-lock";
    try{windowsMcpFileOperation("create",lock,{content:""});}catch(error){if(error instanceof McpConfigurationError&&error.code==="mcp_config_file_exists")fail("mcp_config_busy");throw error;}
    try{return fn();}finally{windowsMcpFileOperation("inspect",lock,{private:true});unlinkSync(lock);}
  }
  secureDirectory(dirname(path));
  let fd: number;
  const lock = path + ".phonon-lock";
  try { fd = openSync(lock, "wx", 0o600); } catch { return fail("mcp_config_busy"); }
  try { return fn(); } finally { closeSync(fd); unlinkSync(lock); }
}
export function replacePrivateFile(path: string, source: string | undefined, next: string): void {
  const temp = join(dirname(path), ".phonon-mcp-" + randomUUID());
  let written = false;
  try {
    if (process.platform === "win32") windowsMcpFileOperation("prepare", path, { content: next, source, temporary: temp });
    else {
      if (readPrivateFile(path) !== source) fail("mcp_config_changed");
      writeFileSync(temp, next, { mode: 0o600, flag: "wx" });
    }
    written = true;
    if (process.platform !== "win32" && readPrivateFile(path) !== source) fail("mcp_config_changed");
    renameSync(temp, path); written = false;
  } finally { if (written) unlinkSync(temp); }
}

function parse(source: string, format: McpConfigTarget["format"]): Record<string, unknown> {
  let value: unknown;
  try {
    if (format === "toml") value = parseToml(source);
    else if (format === "yaml") { const document = parseDocument(source, { uniqueKeys: true }); if (document.errors.length) return fail("mcp_config_parse_error"); value = document.toJS({ maxAliasCount: 0 }) ?? {}; }
    else {
      const errors: ParseError[] = [], tree=parseTree(source||"{}",errors,{allowTrailingComma:true,disallowComments:false});
      if(errors.length||!tree)return fail("mcp_config_parse_error");
      const visit=(node:Node)=>{
        if(node.type==="object"){
          const names=(node.children??[]).map(property=>String(property.children?.[0]?.value));
          if(new Set(names).size!==names.length)fail("mcp_config_duplicate_keys");
        }
        for(const child of node.children??[])visit(child);
      };
      visit(tree);value=parseJson(source||"{}");
    }
  } catch (error) { if(error instanceof McpConfigurationError)throw error;return fail("mcp_config_parse_error"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("mcp_config_parse_error");
  return value as Record<string, unknown>;
}
function at(value: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) { if (!current || typeof current !== "object" || Array.isArray(current)) return undefined; current = (current as Record<string, unknown>)[key]; }
  return current;
}
function withoutEntry(value: Record<string, unknown>, keys: string[]): unknown {
  const copy = structuredClone(value); let current = copy;
  let found = true;
  for (const key of keys.slice(0, -1)) {
    const next = current[key]; if (!next || typeof next !== "object" || Array.isArray(next)) { found = false; break; }
    current = next as Record<string, unknown>;
  }
  if (found) delete current[keys.at(-1)!];
  // Empty parent maps introduced by the patch are semantically neutral.
  const prune = (item: Record<string, unknown>) => { for (const [key, child] of Object.entries(item)) if (child && typeof child === "object" && !Array.isArray(child)) { prune(child as Record<string, unknown>); if (!Object.keys(child).length) delete item[key]; } };
  prune(copy); return copy;
}

export function patchManagedMcp(target: OwnedMcpEntry, enabled: boolean, previous?: OwnedMcpEntry): OwnedMcpEntry | undefined {
  return withConfigLock(target.path, () => {
    const raw = readPrivateFile(target.path), source = raw ?? "", before = parse(source, target.format), existing = at(before, target.keys);
    if (enabled && previous && existing === undefined) fail("mcp_config_removed_locally");
    if (existing !== undefined && (!previous || previous.path !== target.path || canonical(existing) !== canonical(previous.entry))) fail("mcp_config_conflict");
    if (!enabled && existing === undefined) return undefined;
    if (enabled && existing !== undefined && canonical(existing) === canonical(target.entry)) return previous ?? target;
    if (!enabled && !previous) fail("mcp_config_ownership_unconfirmed");
    let next: string, owned = { ...target };
    if (target.format === "toml") {
      next = source;
      if (existing !== undefined) {
        const block = previous?.block;
        if (!block || source.split(block).length !== 2) return fail("mcp_config_conflict");
        next = source.replace(block, "");
      }
      if (enabled) {
        const block = `\n# BEGIN ${target.name}\n[${target.keys.join(".")}]\ncommand = ${JSON.stringify(target.entry.command)}\nargs = ${JSON.stringify(target.entry.args)}\n# END ${target.name}\n`;
        owned.block = block; next += block;
      }
    } else if (target.format === "yaml") {
      const doc = parseDocument(source, { uniqueKeys: true });
      if (enabled) doc.setIn(target.keys, target.entry); else doc.deleteIn(target.keys);
      next = String(doc);
    } else next = applyEdits(source || "{}\n", modify(source || "{}\n", target.keys, enabled ? target.entry : undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    const after = parse(next, target.format);
    if (canonical(withoutEntry(before, target.keys)) !== canonical(withoutEntry(after, target.keys))
      || (enabled && canonical(at(after, target.keys)) !== canonical(target.entry)) || (!enabled && at(after, target.keys) !== undefined)) fail("mcp_config_change_unconfirmed");
    replacePrivateFile(target.path, raw, next);
    if (digest(readPrivateFile(target.path) ?? "") !== digest(next)) fail("mcp_config_change_unconfirmed");
    return enabled ? owned : undefined;
  });
}
