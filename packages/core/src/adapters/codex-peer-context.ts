import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { discoveryProbe } from "../discovery-probe.js";
import { spawnSupervisedAgent, type ProcessSupervisor } from "../process-supervisor.js";
import type { PeerContextAccess } from "../peer-context.js";
import {readCodexContext} from "./codex-context.js";
import {nativeVersionAtLeast} from "@agent-phonon/protocol";

export async function qualifyCodexPeerContext(bin: string, scope?: {cwd:string;env:NodeJS.ProcessEnv;signal?:AbortSignal;onRuntime?:(runtime:ProcessSupervisor)=>void}): Promise<boolean> {
  if (process.platform === "win32" || !scope) return false;
  try {
    const version=(await discoveryProbe(bin,["--version"],scope.signal))?.trim().match(/^codex-cli (\S+)$/)?.[1];
    if (!nativeVersionAtLeast(version,"0.163.0-alpha.10.2")) return false;
    const command = quote(process.execPath)+" -e "+quote("process.stdout.write('{}')")+" phonon-peer-capability";
    const hooks = await listCodexHooks({bin,args:codexPeerDefinitions(command),...scope});
    return events.every(event => hooks.some(hook => hook.command===command && hook.eventName===event.wire && hook.source==="sessionFlags" && hook.enabled));
  }
  catch { return false; }
}

const events = [{config:"UserPromptSubmit",wire:"userPromptSubmit"},{config:"PostToolUse",wire:"postToolUse"}] as const;
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const codexPeerDefinitions = (command: string) => events.flatMap(event => ["-c",`hooks.${event.config}=[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 3, additionalContextLimit = 0 }] }]`]);
const HookMetadata = z.object({key:z.string(),currentHash:z.string(),eventName:z.string(),source:z.string(),
  enabled:z.boolean(),isManaged:z.boolean(),trustStatus:z.string(),handlerType:z.string(),command:z.string().optional(),
  timeoutSec:z.number(),additionalContextLimit:z.number().nullable(),async:z.boolean().optional()}).passthrough();
type HookMetadata = z.infer<typeof HookMetadata>;

export const CODEX_PEER_HOOK_SOURCE = String.raw`
import {request} from "node:http";
import {fileURLToPath} from "node:url";
import {readFileSync} from "node:fs";
async function main(){
  const config=JSON.parse(readFileSync(new URL("./channel.json",import.meta.url),"utf8"));
  const endpoint=new URL(config.url),token=config.token;
  if(endpoint.protocol!=="http:"||endpoint.hostname!=="127.0.0.1"||!endpoint.port||endpoint.pathname!=="/hook"
    ||endpoint.search||endpoint.hash||endpoint.username||endpoint.password||!/^[A-Za-z0-9_-]{43}$/.test(token||""))return {};
  let body="";for await(const chunk of process.stdin){body+=String(chunk);if(Buffer.byteLength(body)>1048576)return {};}
  const input=JSON.parse(body),event={};
  for(const key of ["hook_event_name","session_id","turn_id","cwd","transcript_path","prompt","tool_use_id","tool_response","model"])if(input[key]!==undefined)event[key]=input[key];
  return await new Promise(resolve=>{
    const req=request(endpoint,{method:"POST",agent:false,signal:AbortSignal.timeout(2500),headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"}},res=>{
      let text="";res.on("data",chunk=>{text+=String(chunk);if(Buffer.byteLength(text)>65536)res.destroy();});
      res.on("error",()=>resolve({}));res.on("end",()=>{try{resolve(res.statusCode===200?JSON.parse(text):{});}catch{resolve({});}});
    });req.on("error",()=>resolve({}));req.end(JSON.stringify(event));
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  let output={};try{output=await main();}catch{}process.stdout.write(JSON.stringify(output));
}
`;

/** Read-only discovery: no thread, inference, settings writes or hook-trust bypass. */
export async function listCodexHooks(input: {bin:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;signal?:AbortSignal;onRuntime?:(runtime:ProcessSupervisor)=>void}): Promise<HookMetadata[]> {
  input.signal?.throwIfAborted();
  const runtime = spawnSupervisedAgent(input.bin, ["app-server", ...input.args], {cwd:input.cwd,env:input.env}, {graceMs:250});
  const child = runtime.child;
  let buffer = "", bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { void runtime.terminate(); };
  try {
    input.onRuntime?.(runtime);
    input.signal?.addEventListener("abort",abort,{once:true});
    return await new Promise<HookMetadata[]>((resolve,reject) => {
      timer = setTimeout(() => reject(new Error("Codex hook discovery timed out")),8000);
      child.once("error",reject);
      child.once("close",() => reject(new Error("Codex hook discovery ended before its response")));
      child.stderr.resume();
      child.stdout.on("data",chunk => {
        bytes += chunk.length;
        if (bytes > 1_048_576) { reject(new Error("Codex hook discovery exceeds limit")); return; }
        buffer += String(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
          try {
            const frame = JSON.parse(line);
            if (frame.id === 1) {
              if (frame.error || !frame.result) throw new Error("Codex initialization failed");
              child.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
              child.stdin.write(JSON.stringify({id:2,method:"hooks/list",params:{cwds:[input.cwd]}})+"\n");
            } else if (frame.id === 2) {
              const result = z.object({data:z.array(z.object({cwd:z.string(),hooks:z.array(HookMetadata),errors:z.array(z.unknown())})).length(1)}).parse(frame.result);
              if (frame.error || result.data[0]!.errors.length || realpathSync(result.data[0]!.cwd) !== realpathSync(input.cwd)) throw new Error("Codex hook discovery is unavailable");
              resolve(result.data[0]!.hooks);
            }
          } catch (error) { reject(error); }
        }
      });
      child.stdin.on("error",reject);
      child.stdin.write(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"agent_phonon_hook_discovery",version:"1"},capabilities:{experimentalApi:true}}})+"\n");
    });
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort",abort);
    await stopCodexPeerProcess(runtime);
    if (!runtime.hasStopped()) throw new Error("Codex discovery process tree has not stopped");
  }
}

export async function stopCodexPeerProcess(runtime: ProcessSupervisor): Promise<void> {
  await runtime.terminate();
  // A force-signal deadline is not exit evidence; allow the observed tree to settle.
  const deadline = Date.now()+1000;
  while (!runtime.hasStopped() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
  if (!runtime.hasStopped()) throw new Error("Codex process tree has not stopped");
}

/** A current-turn ingress, never a model tool or an independent mailbox. */
export class CodexPeerContext {
  readonly directory = realpathSync(mkdtempSync(join(tmpdir(),"phonon-codex-peer-")));
  readonly command = quote(process.execPath)+" "+quote(join(this.directory,"hook.mjs"));
  private server?: Server;
  private token = randomBytes(32).toString("base64url");
  private authority = "";
  private active = true;
  private nativeThread?: string;
  private nativeTurn?: string;
  private pending = false;
  private seen = new Set<string>();
  private requests = 0;
  private peerBudgetDebit=0;

  constructor(private options: {access:PeerContextAccess;cwd:string;prompt:string;nativeThread?:string;signal?:AbortSignal;onRuntime?:(runtime:ProcessSupervisor)=>void;
    context?:{home:string;model:string;notBefore:number}}) {
    this.nativeThread = options.nativeThread;
  }
  bindNativeThread(id: string): void {
    if (!z.string().uuid().safeParse(id).success || this.nativeThread && this.nativeThread !== id) throw new Error("Codex native peer identity changed");
    this.nativeThread = id;
  }
  deactivate(): void { this.active = false; }
  /** Internal, owned-runtime dispatch used when another lifecycle owner hosts the same hook. */
  async acceptHook(input:Record<string,unknown>,signal:AbortSignal):Promise<object>{return this.deliver(input,signal);}
  environment(): Record<string,string> {
    if (!this.active || !this.authority) throw new Error("Codex peer ingress is unavailable");
    return {AGENT_PHONON_CODEX_PEER_URL:"http://"+this.authority+"/hook",AGENT_PHONON_CODEX_PEER_TOKEN:this.token};
  }

  async listen(): Promise<void> {
    try {
      writeFileSync(join(this.directory,"hook.mjs"),CODEX_PEER_HOOK_SOURCE,{mode:0o600,flag:"wx"});
      this.server = createServer((req,res) => {
        const reply = (value: unknown) => { if (!res.destroyed) res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(JSON.stringify(value)); };
        const abort = new AbortController(); res.once("close",() => abort.abort());
        void (async () => {
          const actual = Buffer.from(req.headers.authorization??""), expected = Buffer.from("Bearer "+this.token);
          if (!this.active || req.method !== "POST" || req.url !== "/hook" || req.headers.origin || req.headers.host !== this.authority
            || actual.length !== expected.length || !timingSafeEqual(actual,expected) || this.pending || ++this.requests > 256) { reply({}); return; }
          this.pending = true;
          try {
            let body = "";
            for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body)>1_048_576) throw new Error("Hook input too large"); }
            reply(await this.deliver(JSON.parse(body),abort.signal));
          } finally { this.pending = false; }
        })().catch(() => reply({}));
      });
      this.server.requestTimeout = 3000;
      await new Promise<void>((resolve,reject) => { this.server!.once("error",reject); this.server!.listen(0,"127.0.0.1",resolve); });
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("Codex peer hook unavailable");
      this.authority = "127.0.0.1:"+address.port;
      // Native tools inherit the process environment; keep this narrow capability separate.
      writeFileSync(join(this.directory,"channel.json"),JSON.stringify({url:"http://"+this.authority+"/hook",token:this.token}),{mode:0o600,flag:"wx"});
    } catch (error) { await this.close(); throw error; }
  }

  private async deliver(input: Record<string,unknown>, signal: AbortSignal): Promise<object> {
    if (!this.active || signal.aborted || this.options.signal?.aborted || !this.nativeThread || input.session_id !== this.nativeThread
      || typeof input.turn_id !== "string" || !input.turn_id || input.turn_id.length>512
      || typeof input.transcript_path !== "string" || !input.transcript_path.endsWith("-"+this.nativeThread+".jsonl")) return {};
    try { if (typeof input.cwd !== "string" || realpathSync(input.cwd) !== realpathSync(this.options.cwd)) return {}; } catch { return {}; }
    let key: string;
    if (input.hook_event_name === "UserPromptSubmit") {
      if (this.nativeTurn || input.prompt !== this.options.prompt) return {};
      this.nativeTurn = input.turn_id; key = "initial";
    } else if (input.hook_event_name === "PostToolUse") {
      if (input.turn_id !== this.nativeTurn || typeof input.tool_use_id !== "string" || !input.tool_use_id || input.tool_use_id.length>512) return {};
      key = "tool:"+input.tool_use_id;
    } else return {};
    if (this.seen.has(key) || this.seen.size>=256) return {};
    this.seen.add(key);
    const context=this.options.context;
    const budget=context?(await readCodexContext(input.transcript_path,{...context,cwd:this.options.cwd,threadID:this.nativeThread,turnID:this.nativeTurn}))?.peerBudget:undefined;
    if(budget?.state==="known"){
      const responseBytes=Buffer.byteLength(JSON.stringify(input.tool_response??null));
      budget.inputTokens+=responseBytes+this.peerBudgetDebit;
      if(budget.inputTokens>1000000000)return {};
    }
    const boundary = {boundaryId:randomUUID(),nativeSessionId:this.nativeThread,
      ...(context?{budget:budget??{state:"unknown" as const,source:"native_estimate" as const}}:{})};
    const batch = await this.options.access.prepare(boundary,signal);
    if (!this.active || signal.aborted || this.options.signal?.aborted || batch.boundaryId !== boundary.boundaryId || batch.nativeSessionId !== boundary.nativeSessionId
      || !Array.isArray(batch.messages) || batch.messages.length>8 || batch.messages.some(item => typeof item.messageId !== "string" || typeof item.content !== "string")) return {};
    if (!batch.messages.length) return {};
    const additionalContext = batch.messages.map(item => item.content).join("\n\n");
    if (Buffer.byteLength(additionalContext)>16000) return {};
    this.peerBudgetDebit+=Buffer.byteLength(additionalContext)+64*batch.messages.length;
    this.options.access.observe({boundaryId:boundary.boundaryId,nativeSessionId:boundary.nativeSessionId,messageIds:batch.messages.map(item => item.messageId),evidence:"context_hook"});
    if(!this.active||signal.aborted||this.options.signal?.aborted)return {};
    return {hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext}};
  }

  definitionArguments(): string[] {
    return codexPeerDefinitions(this.command);
  }

  async nativeArguments(bin: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
    return trustedCodexPeerArguments({bin,environment,cwd:this.options.cwd,command:this.command,signal:this.options.signal,onRuntime:this.options.onRuntime});
  }

  async close(): Promise<void> {
    this.deactivate(); this.token = "";
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    rmSync(this.directory,{recursive:true,force:true});
  }
}

export async function trustedCodexPeerArguments(input:{bin:string;environment:NodeJS.ProcessEnv;cwd:string;command:string;signal?:AbortSignal;onRuntime?:(runtime:ProcessSupervisor)=>void}):Promise<string[]>{
    const definitions = codexPeerDefinitions(input.command);
    const read = (args: string[]) => listCodexHooks({bin:input.bin,args,cwd:input.cwd,env:input.environment,signal:input.signal,onRuntime:input.onRuntime});
    const hooks = await read(definitions);
    const own = hooks.filter(hook => hook.source === "sessionFlags" && hook.handlerType === "command" && hook.command === input.command);
    if (own.length !== events.length || events.some(event => own.filter(hook => hook.eventName === event.wire).length !== 1)
      || own.some(hook => !hook.enabled || hook.isManaged || hook.trustStatus !== "untrusted" || hook.async || hook.timeoutSec !== 3 || hook.additionalContextLimit !== 0
        || !hook.key.includes("<session-flags>") || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash))) {
      throw new Error("Codex native Phonon hooks could not be qualified; existing hook policy was retained");
    }
    // Native CLI dotted overrides split literal dots inside quoted keys, so use one table value.
    const state = "{ "+own.map(hook => `${JSON.stringify(hook.key)} = { trusted_hash = ${JSON.stringify(hook.currentHash)} }`).join(", ")+" }";
    const args = [...definitions,"-c","hooks.state="+state];
    const verified = await read(args), expected = new Map(hooks.map(hook => [hook.key,hook]));
    if (verified.length !== hooks.length || verified.some(hook => {
      const previous = expected.get(hook.key);
      return !previous || previous.currentHash !== hook.currentHash || previous.enabled !== hook.enabled
        || hook.trustStatus !== (own.some(item => item.key === hook.key)?"trusted":previous.trustStatus);
    })) throw new Error("Codex invocation-local hook trust could not be confirmed");
    return args;
}
