import { dirname, resolve, join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isMainThread } from "node:worker_threads";
import { ManagedMcpConfigureParams, ManagedMcpStatusResult, type AgentDescriptor } from "@agent-phonon/protocol";
import { DEFAULT_CONFIG_PATH, loadConfig, writeConfig, type DaemonConfig, type ServerConfig } from "./config.js";
import { managedConfigTarget, McpConfigurationError, patchManagedMcp, readPrivateFile, replacePrivateFile, withConfigLock, type OwnedMcpEntry } from "./managed-mcp-config.js";
import { runManagedMcpWorker } from "./managed-mcp-worker-client.js";
import { mcpRequestByteLimit } from "./mcp-request-budget.generated.js";
import {managedMcpEntryName,managedMcpServerForSource,managedMcpSourceAllowed,managedMcpSourceFingerprint,managedMcpSourceStatePath,validManagedMcpSource} from "./managed-mcp-source.js";
export {managedMcpSourceFingerprint} from "./managed-mcp-source.js";

export interface ManagedMcpLocalPolicy { allow: boolean; agents: string[]; configPaths?: Record<string, string>;sourceFingerprint?:string }
interface State {version:2;sourceFingerprint:string;snapshot: ManagedMcpConfigureParams; entries: Record<string, OwnedMcpEntry>; report: ManagedMcpStatusResult }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface ManagedMcpManagerOptions {
  server: string; configPath?: string; stateDir: string; inventory: () => Promise<AgentDescriptor[]>;
  command?: string; args?: string[]; home?: string; env?: NodeJS.ProcessEnv;
  sourceFingerprint?:string;
}

function parseSourceState(raw:string|undefined,source:string):State|undefined{
  if(!raw)return undefined;
  const value=JSON.parse(raw) as State;
  if(!value||typeof value!=="object"||Array.isArray(value))throw new McpConfigurationError("mcp_state_invalid");
  if(value.version!==2||value.sourceFingerprint!==source)throw new McpConfigurationError("mcp_state_source_unconfirmed");
  const snapshot=ManagedMcpConfigureParams.parse(value.snapshot),report=ManagedMcpStatusResult.parse(value.report);
  if(!value.entries||typeof value.entries!=="object"||Array.isArray(value.entries))throw new McpConfigurationError("mcp_state_invalid");
  const ids=new Set(snapshot.bindings.map(binding=>binding.id));
  for(const[id,entry]of Object.entries(value.entries)){
    const args=Array.isArray(entry?.entry?.args)?entry.entry.args:Array.isArray(entry?.entry?.command)?entry.entry.command.slice(1):undefined;
    if(!ids.has(id)||!entry||entry.name!==managedMcpEntryName(id,source)||!Array.isArray(entry.keys)||entry.keys.at(-1)!==entry.name
      ||!args||args.filter(value=>value==="--source").length!==1||args[args.indexOf("--source")+1]!==source
      ||args.filter(value=>value==="--binding").length!==1||args[args.indexOf("--binding")+1]!==id)
      throw new McpConfigurationError("mcp_state_source_unconfirmed");
  }
  return {...value,snapshot,report};
}
function readSourceState(path:string,source:string):State|undefined{return parseSourceState(readPrivateFile(path,1024*1024,true),source);}

export class ManagedMcpManager {
  private active = false;
  private readonly sourceFingerprint?:string;
  constructor(private options: ManagedMcpManagerOptions) {
    if(Object.hasOwn(options,"sourceFingerprint")){
      if(options.sourceFingerprint!==undefined&&!validManagedMcpSource(options.sourceFingerprint))throw new McpConfigurationError("mcp_source_invalid");
      this.sourceFingerprint=options.sourceFingerprint;
    }else{
      let config:DaemonConfig|undefined;try{config=loadConfig(this.configPath);}catch{}
      const server=config&&managedMcpServerForSource(config.servers,this.options.server);
      this.sourceFingerprint=server&&managedMcpSourceFingerprint(server);
    }
  }
  private get statePath() {
    if(!this.sourceFingerprint)throw new McpConfigurationError("mcp_source_unconfirmed");
    return managedMcpSourceStatePath(this.options.stateDir,this.sourceFingerprint);
  }
  private get configPath() { return resolve(this.options.configPath ?? DEFAULT_CONFIG_PATH); }
  private server(): ServerConfig | undefined {
    if(!this.sourceFingerprint)return undefined;
    let config:DaemonConfig;try{config=loadConfig(this.configPath);}catch{return undefined;}
    return managedMcpServerForSource(config.servers,this.options.server,this.sourceFingerprint);
  }
  private read(): State | undefined {
    return readSourceState(this.statePath,this.sourceFingerprint!);
  }
  status(): ManagedMcpStatusResult {
    if(!this.sourceFingerprint)return {revision:-1,allowed:false,bindings:[]};
    const saved = this.read();
    return { revision: saved?.snapshot.revision ?? -1, allowed: managedMcpSourceAllowed(this.server(),this.sourceFingerprint), bindings: saved?.report.bindings ?? [] };
  }
  async statusAsync(): Promise<ManagedMcpStatusResult> {
    if (process.platform !== "win32" || !isMainThread) return this.status();
    const { inventory: _inventory, ...options } = this.options;
    return runManagedMcpWorker({...options,sourceFingerprint:this.sourceFingerprint}, { operation: "status", inventory: [] });
  }
  async configure(raw: unknown): Promise<ManagedMcpStatusResult> {
    if (this.active) throw new McpConfigurationError("mcp_configuration_busy");
    this.active = true;
    try {
      const snapshot = ManagedMcpConfigureParams.parse(raw);
      if(!this.sourceFingerprint)return {revision:snapshot.revision,allowed:false,bindings:snapshot.bindings.map(binding=>({id:binding.id,agentId:binding.agentId,state:"error" as const,code:"mcp_source_unconfirmed"}))};
      if (process.platform === "win32" && isMainThread) {
        const { inventory: observe, ...options } = this.options;
        const inventory = snapshot.bindings.some(item => item.enabled) && managedMcpSourceAllowed(this.server(),this.sourceFingerprint) ? await observe() : [];
        return await runManagedMcpWorker({...options,sourceFingerprint:this.sourceFingerprint}, { operation: "configure", snapshot, inventory });
      }
      const inventory = snapshot.bindings.some(item => item.enabled) && managedMcpSourceAllowed(this.server(),this.sourceFingerprint) ? await this.options.inventory() : [];
      const source=this.sourceFingerprint;
      return withConfigLock(this.statePath,()=>{
      const original=readPrivateFile(this.statePath,1024*1024,true),prior = parseSourceState(original,source);
      if (prior && (snapshot.revision < prior.snapshot.revision || snapshot.revision === prior.snapshot.revision && !equal(snapshot, prior.snapshot))) throw new McpConfigurationError("mcp_revision_conflict");
      const server = this.server(), local = server?.managedMcp, allowed = managedMcpSourceAllowed(server,source);
      const entries = { ...prior?.entries }, report: ManagedMcpStatusResult = { revision: snapshot.revision, allowed, bindings: [] };
      const requested = new Set(snapshot.bindings.map(item => item.id));
      // A full snapshot also removes omitted owned entries. Never delete a
      // changed entry or another server's registration.
      for (const [id, entry] of Object.entries(entries)) if (!requested.has(id)) { patchManagedMcp(entry, false, entry); delete entries[id]; }
      for (const binding of snapshot.bindings) {
        const state = { id: binding.id, agentId: binding.agentId };
        try {
          const permitted = allowed && (local?.agents.includes("*") || local?.agents.includes(binding.agentId));
          const enabled = binding.enabled && permitted;
          const previous = entries[binding.id];
          if (!enabled) {
            if (previous) { patchManagedMcp(previous, false, previous); delete entries[binding.id]; }
            report.bindings.push({ ...state, state: binding.enabled ? "local_consent_required" : "removed" }); continue;
          }
          const harness = inventory.find(item => item.agentId === binding.agentId && item.available);
          if (!harness) { report.bindings.push({ ...state, state: "unsupported", code: "mcp_agent_unavailable" }); continue; }
          if (harness.adapter === "pi" && !supportsPiMcp(harness.version)) { report.bindings.push({ ...state, state: "unsupported", code: "mcp_native_version_unconfirmed" }); continue; }
          const args = [...(this.options.args ?? [resolve(process.argv[1]!)]), "mcp", "proxy", "--config", this.configPath,
            "--server", this.options.server, "--source",source,"--binding", binding.id];
          const target = managedConfigTarget(binding.agentId, binding.id, this.options.command ?? process.execPath, args,
            {sourceFingerprint:source, ...(this.options.home ? { home: this.options.home } : {}), paths: local?.configPaths, ...(this.options.env ? { env: this.options.env } : {}) });
          if (!target) { report.bindings.push({ ...state, state: "unsupported", code: "mcp_profile_scope_unsupported" }); continue; }
          if (previous && previous.path !== target.path) throw new McpConfigurationError("mcp_config_path_changed");
          entries[binding.id] = patchManagedMcp(target, true, previous)!;
          report.bindings.push({ ...state, state: "configured" });
        } catch (error) {
          const code = error instanceof McpConfigurationError ? error.code : "mcp_configuration_failed";
          report.bindings.push({ ...state, state: code.includes("conflict") || code.includes("changed") || code.includes("untrusted") || code.includes("removed_locally") ? "conflict" : "error", code });
        }
      }
      const state:State={version:2,sourceFingerprint:source,snapshot,entries,report};
      replacePrivateFile(this.statePath,original,JSON.stringify(state,null,2)+"\n");return report;
      });
    } finally { this.active = false; }
  }
}

function supportsPiMcp(version: string | undefined) {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return !!match && (Number(match[1]) >= 1 || Number(match[2]) >= 99);
}

export function managedMcpStateDir(config: DaemonConfig) { return join(dirname(config.dbPath), "managed-mcp"); }

function proxyAuthority(options:{configPath:string;server:string;binding:string},source:string){
  const config=loadConfig(options.configPath),server=managedMcpServerForSource(config.servers,options.server,source);
  if(!server?.deviceKey||!managedMcpSourceAllowed(server,source))throw new McpConfigurationError("mcp_local_access_disabled");
  const path=managedMcpSourceStatePath(managedMcpStateDir(config),source),state=readSourceState(path,source);
  const binding=state?.snapshot.bindings.find(item=>item.id===options.binding&&item.enabled),entry=state?.entries[options.binding];
  const reports=state?.report.bindings.filter(item=>item.id===options.binding&&item.agentId===binding?.agentId)??[];
  if(!binding||!entry||!state?.report.allowed||state.report.revision!==state.snapshot.revision||reports.length!==1||reports[0]?.state!=="configured"
    ||!(server.managedMcp!.agents.includes("*")||server.managedMcp!.agents.includes(binding.agentId)))throw new McpConfigurationError("mcp_local_access_disabled");
  return {server,proof:JSON.stringify([source,path,state.snapshot.revision,binding,entry])};
}

export async function runManagedMcpProxy(options: { configPath: string; server: string; binding: string;sourceFingerprint?:string }): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(options.binding)) throw new McpConfigurationError("mcp_binding_invalid");
  if(!validManagedMcpSource(options.sourceFingerprint))throw new McpConfigurationError("mcp_source_unconfirmed");
  const source=options.sourceFingerprint;
  const transport = new StdioServerTransport(); let pending = 0;
  transport.onmessage = async message => {
    if (!("method" in message)) return;
    const id = "id" in message ? message.id : undefined;
    const reject = async (code: string) => { if (id !== undefined) await transport.send({ jsonrpc: "2.0", id, error: { code: -32000, message: code,
      ...(code==="mcp_result_source_changed"?{data:{requestMayHaveReachedServer:true,outcomeKnown:false}}:{}) } }); };
    if (pending >= 8) { await reject("mcp_busy"); return; }
    pending++;
    try {
      const original=proxyAuthority(options,source),server=original.server;
      // A request may already have effects. Withdraw late bytes, never resend
      // it under a replacement account, revision or newly configured binding.
      const current=()=>{
        try{if(proxyAuthority(options,source).proof!==original.proof)throw new Error("source changed");}
        catch{throw new McpConfigurationError("mcp_result_source_changed");}
      };
      const endpoint = new URL(server.url);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new McpConfigurationError("mcp_server_untrusted");
      if (endpoint.protocol === "wss:") endpoint.protocol = "https:";
      if (endpoint.protocol === "ws:") endpoint.protocol = "http:";
      if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname))) throw new McpConfigurationError("mcp_server_requires_https");
      endpoint.pathname = `/device/mcp/${options.binding}`;
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > mcpRequestByteLimit(message)) throw new McpConfigurationError("mcp_request_too_large");
      const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(65000),
        headers: { Authorization: "Bearer " + server.deviceKey, "Content-Type": "application/json", Accept: "application/json" }, body });
      if (response.status === 204 || response.status === 202) { if (id !== undefined) throw new McpConfigurationError("mcp_result_unconfirmed"); return; }
      if (!response.ok) throw new McpConfigurationError(response.status === 403 || response.status === 401 ? "mcp_access_disabled" : "mcp_request_unconfirmed");
      const reader = response.body?.getReader(); if (!reader) throw new McpConfigurationError("mcp_result_unconfirmed");
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new McpConfigurationError("mcp_result_too_large"); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result.jsonrpc !== "2.0" || result.id !== id || (!("result" in result) && !("error" in result))) throw new McpConfigurationError("mcp_result_unconfirmed");
      current();
      if (id !== undefined) await transport.send(result);
    } catch (error) { await reject(error instanceof McpConfigurationError ? error.code : "mcp_request_unconfirmed"); }
    finally { pending--; }
  };
  await transport.start();
  await new Promise<void>(resolve => { transport.onclose = resolve; process.stdin.once("end", () => { void transport.close().then(resolve); }); });
}

export function configureManagedMcpConsent(args: string[]): void {
  const opt = (name: string) => { const index = args.indexOf("--" + name); return index < 0 ? undefined : args[index + 1]; };
  const path = opt("config") ?? DEFAULT_CONFIG_PATH, config = loadConfig(path), server = managedMcpServerForSource(config.servers,opt("server")??"",opt("source"));
  if (!server || !["allow", "deny"].includes(args[0] ?? "")) throw new Error("usage: agent-phonon mcp allow|deny --server <registered-url> [--agents codex,pi | --all]");
  const agents = args.includes("--all") ? ["*"] : (opt("agents") ?? "").split(",").filter(Boolean);
  if (args[0] === "allow" && (!agents.length || agents.some(agent => !/^[a-zA-Z0-9_.:*-]{1,255}$/.test(agent)))) throw new McpConfigurationError("mcp_select_local_agents");
  const source=managedMcpSourceFingerprint(server);if(!source)throw new McpConfigurationError("mcp_source_unconfirmed");
  server.managedMcp = { ...server.managedMcp,sourceFingerprint:source, allow: args[0] === "allow", agents: args[0] === "allow" ? agents : server.managedMcp?.agents ?? [] };
  writeConfig(config, path);
  console.log(args[0] === "allow" ? "Phonon MCP configuration allowed. Sync the device in Phonon; restart an older daemon once to enable the new protocol." : "Local Phonon MCP access disabled, including existing proxy processes. Sync the device to remove owned registrations.");
}
