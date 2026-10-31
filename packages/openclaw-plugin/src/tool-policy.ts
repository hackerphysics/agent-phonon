import { createHash } from "node:crypto";
import { nativeVersionAtLeast } from "@agent-phonon/protocol";
import { z } from "zod";
import { nativeGatewayAuthority, parameterHash, type GatewayCall } from "./native-interactions.js";
import type { NativePeerApi, NativePeerRuntimeResolver } from "./peer-context.js";

export const POLICY_BIND="phonon.policy.bind";
export const POLICY_CONFIRM="phonon.policy.confirm";
export const POLICY_RELEASE="phonon.policy.release";
export const POLICY_ID="phonon-noninteractive-v1";
export const BLOCKED_NATIVE_TOOLS=["ask_user","message","secrets","conversations_send","conversations_turn",
  "sessions_send","sessions_spawn","sessions","subagents","automations","cron","openclaw","gateway","plugins"];
const name=z.string().max(128).regex(/^[a-z0-9][a-z0-9_.-]*$/);
const effectiveSchema=z.object({agentId:z.string(),groups:z.array(z.object({
  source:z.enum(["core","plugin","channel","mcp"]),tools:z.array(z.object({id:name,source:z.enum(["core","plugin","channel","mcp"])}).passthrough()).max(1024),
}).passthrough()).max(256)}).passthrough();
const catalogSchema=z.object({agentId:z.string(),profiles:z.array(z.unknown()).max(32),groups:z.array(z.object({
  source:z.enum(["core","plugin"]),tools:z.array(z.object({id:name}).passthrough()).max(1024),
}).passthrough()).min(1).max(256),effective:effectiveSchema}).passthrough();
const inputSchema=z.object({version:z.literal(1),sessionKey:z.string().max(512).regex(/^agent:[a-zA-Z0-9_-]+:phonon-[a-zA-Z0-9_-]+$/),
  sessionId:z.string().uuid(),runId:z.string().uuid(),policyId:z.string().uuid(),agentId:z.string().max(128),model:z.string().min(3).max(512),
  expiresAt:z.number().int(),catalog:catalogSchema}).strict();
const releaseSchema=inputSchema.extend({dispatched:z.boolean().default(true)});
type Input=z.infer<typeof inputSchema>;
type Context={sessionKey?:string;sessionId?:string;runId?:string;agentId?:string;abortSignal?:AbortSignal};
type ToolEvent={toolName:string;runId?:string;toolKind?:string};
type NativeController={controller:AbortController;sessionKey:string;sessionId:string;agentId?:string;ownerConnId?:string};
type RetainedAccess={signal:AbortSignal;assertCurrent:()=>void;release:()=>void};
type PolicyCall=GatewayCall&{context?:{chatAbortControllers?:Map<string,NativeController>};sessionAccessAuthority?:{
  target:{sessionKey:string;sessionId:string;agentId:string};assertCurrent:()=>void;retain:()=>RetainedAccess;
}};
export interface NativePolicyApi extends NativePeerApi {
  registerGatewayMethod:(method:string,handler:(call:PolicyCall)=>void,opts:{scope:"operator.admin"|"operator.write";sessionAccess?:{mode:"write"}})=>void;
  registerTrustedToolPolicy?:(value:{id:string;description:string;evaluate:(event:ToolEvent,ctx:Context)=>unknown})=>void;
}
type RunIdentity=Pick<Input,"sessionKey"|"sessionId"|"runId"|"agentId">;
type KnownRun=RunIdentity&{owner:string;policyId:string;fingerprint:string;source:Map<string,NativeController>;controller?:NativeController};
type Binding={input:Input;owner:string;current:()=>boolean;toolsAllow:string[];fingerprint:string;configHash:string;
  source:Map<string,NativeController>;controller?:NativeController;retired:boolean;
  promptApplied:boolean;timer:ReturnType<typeof setTimeout>;detach:()=>void;receipt:Record<string,unknown>};

/** Catalog entries are inventory. The host still intersects this cap with every native deny/approval. */
export function deriveToolPolicy(raw:unknown,agentId:string,isMessagingTool:(name:string)=>boolean=()=>false):string[]{
  if(Buffer.byteLength(JSON.stringify(raw))>524288)throw new Error("catalog too large");
  const catalog=catalogSchema.parse(raw);
  if(catalog.agentId!==agentId||catalog.effective.agentId!==agentId)throw new Error("catalog agent mismatch");
  const seen=new Set<string>(),core=new Set<string>();
  for(const group of catalog.groups)for(const tool of group.tools){
    if(seen.has(tool.id)||seen.size>=4096)throw new Error("ambiguous catalog");
    seen.add(tool.id);if(group.source==="core")core.add(tool.id);
  }
  if(!["read","write","exec","ask_user","message","secrets","sessions_spawn"].every(id=>core.has(id)))throw new Error("incomplete native catalog");
  const effectiveSeen=new Set<string>();
  for(const group of catalog.effective.groups)for(const tool of group.tools){
    if(group.source!==tool.source||effectiveSeen.has(tool.id)||seen.size>=4096
      ||tool.source==="channel"&&seen.has(tool.id))throw new Error("ambiguous effective inventory");
    effectiveSeen.add(tool.id);seen.add(tool.id);
  }
  // Native mode controls do not grant their nested tools; every target keeps its own policy hook.
  for(const id of ["exec","wait","tool_search","tool_describe","tool_call"])seen.add(id);
  // These namespaces are the qualified host's late-bound MCP and LSP tools, not plugin-group grants.
  return [...seen].filter(id=>!BLOCKED_NATIVE_TOOLS.includes(id)&&!isMessagingTool(id)).concat("*__*","lsp_*").sort();
}

/** No config/session writes. A grant belongs to one transport and exact native session/run. */
export class NativeToolPolicy {
  private bindings=new Map<string,Binding>();
  private knownRuns=new Map<string,KnownRun>();
  private api?:NativePolicyApi;
  private resolveRuntime?:NativePeerRuntimeResolver;
  private isMessagingTool?: (name:string)=>boolean;
  private loading?:Promise<void>;
  constructor(private options:{resolveRuntime?:NativePeerRuntimeResolver;loadRuntimeResolver?:()=>Promise<NativePeerRuntimeResolver>;
    isMessagingTool?:(name:string)=>boolean;loadMessagingClassifier?:()=>Promise<(name:string)=>boolean>}={}){
    this.resolveRuntime=options.resolveRuntime;this.isMessagingTool=options.isMessagingTool;
  }

  register(api:NativePolicyApi):void{
    this.api=api;
    api.registerGatewayMethod(POLICY_BIND,call=>this.gateway(call,"bind"),{scope:"operator.write",sessionAccess:{mode:"write"}});
    api.registerGatewayMethod(POLICY_CONFIRM,call=>this.gateway(call,"confirm"),{scope:"operator.write",sessionAccess:{mode:"write"}});
    api.registerGatewayMethod(POLICY_RELEASE,call=>this.gateway(call,"release"),{scope:"operator.write",sessionAccess:{mode:"write"}});
    api.on("before_prompt_build",(_event:unknown,ctx:Context)=>{
      if(!this.protected(ctx))return;
      const binding=this.active(ctx,true);
      if(!binding)return {toolsAllow:[]};
      binding.promptApplied=true;
      return {toolsAllow:[...binding.toolsAllow]};
    },{priority:2000});
    api.on("before_agent_run",(_event:unknown,ctx:Context)=>{
      if(this.protected(ctx)&&!this.active(ctx,true)?.promptApplied)return {outcome:"block",reason:"phonon_policy_unavailable",message:"Phonon current-run tool policy is unavailable"};
    },{priority:2000});
    const evaluate=(event:ToolEvent,ctx:Context)=>{
      if(!this.protected(ctx))return;
      const binding=this.active(ctx,true),tool=event.toolName;
      if(!binding?.promptApplied||event.runId!==ctx.runId||BLOCKED_NATIVE_TOOLS.includes(tool)||this.isMessagingTool?.(tool)
        ||!(binding.toolsAllow.includes(tool)||/^[a-z0-9_.-]+__[a-z0-9_.-]+$/.test(tool)||/^lsp_[a-z0-9_.-]+$/.test(tool)))
        return {block:true,blockReason:"Tool is not authorized by the Phonon current-run policy"};
    };
    api.registerTrustedToolPolicy?.({id:POLICY_ID,description:"Enforce Phonon noninteractive current-run tool authority",evaluate});
    // Revalidate after asynchronous legacy pre-tool hooks without replacing native approvals.
    api.on("before_tool_call",evaluate,{priority:-1000000});
    api.on("agent_end",(_event:unknown,ctx:Context)=>{
      const known=this.knownRuns.get(ctx.runId??"");
      if(!known||!this.matchesInput(known,ctx))return;
      const binding=this.bindings.get(known.sessionKey);
      if(binding&&this.matches(binding,ctx))this.remove(binding,false);
    });
    api.lifecycle?.registerRuntimeLifecycle({id:POLICY_ID,cleanup:ctx=>{
      for(const binding of this.bindings.values())if((!ctx.sessionKey||binding.input.sessionKey===ctx.sessionKey)&&(!ctx.runId||binding.input.runId===ctx.runId))this.remove(binding);
    }});
  }

  private protected(ctx:Context){
    if(ctx.runId&&this.knownRuns.has(ctx.runId))return true;
    return [...this.bindings.values()].some(binding=>binding.input.sessionKey===ctx.sessionKey||binding.input.sessionId===ctx.sessionId);
  }
  private matchesInput(p:RunIdentity,ctx:Context){return ctx.sessionKey===p.sessionKey&&ctx.sessionId===p.sessionId&&ctx.runId===p.runId&&ctx.agentId===p.agentId;}
  private matches(binding:Binding,ctx:Context){return this.matchesInput(binding.input,ctx);}
  private controller(binding:Binding):NativeController|undefined{
    const entry=binding.source.get(binding.input.runId),p=binding.input;
    return entry?.controller instanceof AbortController&&entry.sessionKey===p.sessionKey&&entry.sessionId===p.sessionId
      &&entry.agentId===p.agentId&&entry.ownerConnId===binding.owner?entry:undefined;
  }
  private qualified(input:Input):string{
    const api=this.api,cfg:any=api?.runtime?.config?.current?.()??api?.config,plugin=cfg?.plugins?.entries?.[api?.id??"agent-phonon-hitl"];
    if(!nativeVersionAtLeast(api?.runtime?.version,"2026.10.7")||!this.isMessagingTool||!api?.registerTrustedToolPolicy||!api.lifecycle?.registerRuntimeLifecycle||cfg?.plugins?.enabled===false
      ||plugin?.enabled!==true||plugin.hooks?.allowPromptInjection!==true||plugin.hooks?.allowConversationAccess!==true)throw new Error("unqualified host");
    const entry=api.runtime?.agent?.session?.getSessionEntry({agentId:input.agentId,sessionKey:input.sessionKey,readConsistency:"latest",hydrateSkillPromptRefs:false});
    const selected=entry?.modelOverride??entry?.model,provider=entry?.providerOverride??entry?.modelProvider;
    const model=typeof selected==="string"&&typeof provider==="string"&&!selected.startsWith(provider+"/")?provider+"/"+selected:selected;
    if(input.sessionKey.split(":")[1]!==input.agentId||!entry||entry.sessionId!==input.sessionId||model!==input.model
      ||this.resolveRuntime?.({config:cfg,sessionKey:input.sessionKey,model:input.model,sessionEntry:entry})!=="openclaw")throw new Error("native session mismatch");
    return parameterHash(cfg);
  }
  private active(ctx:Context,requireController=false):Binding|undefined{
    if(ctx.abortSignal?.aborted)return;
    const binding=this.bindings.get(ctx.sessionKey??"");
    if(!binding||!this.matches(binding,ctx))return;
    try{
      if(binding.retired||!binding.current()||binding.input.expiresAt<=Date.now()||this.qualified(binding.input)!==binding.configHash)throw new Error("stale policy");
      if(requireController||binding.controller){
        const entry=this.controller(binding);
        if(!entry||entry.controller.signal.aborted||binding.controller&&binding.controller!==entry)throw new Error("native controller changed");
        binding.controller??=entry;
        this.knownRuns.get(binding.input.runId)!.controller=entry;
      }
      return binding;
    }
    catch{this.remove(binding);return;}
  }
  private remove(binding:Binding,cancel=true){
    if(binding.retired)return;
    binding.retired=true;
    if(this.bindings.get(binding.input.sessionKey)===binding)this.bindings.delete(binding.input.sessionKey);
    clearTimeout(binding.timer);binding.detach();
    // An approval may outlive pre-tool hooks. Fence its exact native signal before returning.
    const original=binding.controller??this.controller(binding);
    if(cancel&&original&&!original.controller.signal.aborted)original.controller.abort();
  }
  private pruneRetiredRuns(){
    for(const [runId,known]of this.knownRuns){
      if(this.knownRuns.size<256)break;
      if(this.bindings.get(known.sessionKey)?.input.runId===runId)continue;
      // Keep pending native executions classified; completed/aborted runs have no effect authority.
      if(known.controller?.controller.signal.aborted||!known.source.has(runId))this.knownRuns.delete(runId);
    }
  }
  private async gateway(call:PolicyCall,operation:"bind"|"confirm"|"release"){
    try{
      if(typeof call.hasCurrentClientAuthority!=="function")throw new Error("missing native authority");
      const authority=nativeGatewayAuthority(call);
      let input:Input,dispatched=true;
      if(operation==="release")({dispatched,...input}=releaseSchema.parse(call.params));
      else input=inputSchema.parse(call.params);
      const access=call.sessionAccessAuthority;
      if(!access||access.target.sessionKey!==input.sessionKey||access.target.sessionId!==input.sessionId||access.target.agentId!==input.agentId)throw new Error("missing native session authority");
      access.assertCurrent();
      if(!call.hasCurrentClientAuthority())throw new Error("stale native authority");
      if(operation==="bind"&&(!this.resolveRuntime||!this.isMessagingTool)){
        this.loading??=(async()=>{
          if(!this.resolveRuntime&&this.options.loadRuntimeResolver)this.resolveRuntime=await this.options.loadRuntimeResolver();
          if(!this.isMessagingTool&&this.options.loadMessagingClassifier)this.isMessagingTool=await this.options.loadMessagingClassifier();
        })();await this.loading;
      }
      access.assertCurrent();
      if(!authority.current())throw new Error("disconnected");
      const existing=this.bindings.get(input.sessionKey),fingerprint=parameterHash(input);
      const known=this.knownRuns.get(input.runId);
      if(known&&(known.owner!==authority.owner||known.policyId!==input.policyId||known.fingerprint!==fingerprint))throw new Error("foreign or stale policy generation");
      if(existing&&(existing.owner!==authority.owner||existing.input.runId!==input.runId||existing.input.policyId!==input.policyId||existing.fingerprint!==fingerprint))throw new Error("foreign or stale policy");
      if(operation==="release"){
        if(existing)this.remove(existing);
        if(!dispatched&&known&&!known.controller&&!known.source.has(input.runId))this.knownRuns.delete(input.runId);
        call.respond(true,{version:1,released:!!existing});return;
      }
      if(operation==="confirm"){
        if(!existing||!this.active({...input}))throw new Error("policy unavailable");
        call.respond(true,existing.receipt);return;
      }
      const configHash=this.qualified(input),toolsAllow=deriveToolPolicy(input.catalog,input.agentId,this.isMessagingTool),now=Date.now();
      const source=call.context?.chatAbortControllers;
      if(!(source instanceof Map))throw new Error("native controller registry unavailable");
      if(input.expiresAt<=now||input.expiresAt>now+1800000)throw new Error("invalid lifetime");
      if(existing){if(configHash!==existing.configHash)throw new Error("policy changed");call.respond(true,existing.receipt);return;}
      this.pruneRetiredRuns();
      if(this.bindings.size>=64||this.knownRuns.size>=256||known)throw new Error("binding limit or retired run");
      const receipt={version:1,bound:true,policy:POLICY_ID,nativeVersion:this.api?.runtime?.version,policyId:input.policyId,sessionKey:input.sessionKey,sessionId:input.sessionId,runId:input.runId,
        catalogHash:createHash("sha256").update(JSON.stringify(call.params.catalog)).digest("hex"),executionFence:"native-controller-v1"};
      const retained=access.retain();
      const current=()=>{try{retained.assertCurrent();return !retained.signal.aborted&&authority.current();}catch{return false;}};
      const retire=()=>this.remove(binding),binding:Binding={input,owner:authority.owner,current,toolsAllow,fingerprint,configHash,promptApplied:false,receipt,source,retired:false,
        timer:setTimeout(retire,input.expiresAt-now),detach:()=>{
          authority.signal.removeEventListener("abort",retire);retained.signal.removeEventListener("abort",retire);retained.release();
        }};
      binding.timer.unref();this.bindings.set(input.sessionKey,binding);
      this.knownRuns.set(input.runId,{sessionKey:input.sessionKey,sessionId:input.sessionId,runId:input.runId,agentId:input.agentId,owner:authority.owner,policyId:input.policyId,fingerprint,source});
      authority.signal.addEventListener("abort",retire,{once:true});
      retained.signal.addEventListener("abort",retire,{once:true});
      if(!current()){this.remove(binding);throw new Error("revoked authority");}
      call.respond(true,receipt);
    }catch{call.respond(false,undefined,{code:"INVALID_REQUEST",message:"Phonon noninteractive policy unavailable: requires native OpenClaw >=2026.10.7 with policy APIs, current admin/session authority and unambiguous catalog/effective inventory"});}
  }
}
