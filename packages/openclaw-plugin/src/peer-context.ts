import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { loopbackEndpoint, nativeGatewayAuthority, parameterHash, readJson, type GatewayCall } from "./native-interactions.js";

export const PEER_CAPABILITIES="phonon.peers.capabilities";
export const PEER_BIND="phonon.peers.bind";
export const PEER_RELEASE="phonon.peers.release";
export const PEER_BLOCK_TAG="agentPhononPeerContext";
const identity=z.object({sessionKey:z.string().max(512).regex(/^agent:[a-zA-Z0-9_-]+:phonon-[a-zA-Z0-9_-]+$/),runId:z.string().uuid()}).strict();
const bindingInput=identity.extend({version:z.literal(1),sessionId:z.string().uuid(),workspaceDir:z.string().min(1),projectionId:z.string().uuid(),
  model:z.string().min(3).max(512),endpoint:z.string().url(),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),expiresAt:z.number().int(),nativeInput:z.literal(true).optional()}).strict();
const batchSchema=z.object({boundaryId:z.string().uuid(),nativeSessionId:z.string(),messages:z.array(z.object({messageId:z.string().uuid(),content:z.string()})).max(8),deferred:z.array(z.unknown())});
type NativeContext={sessionKey?:string;sessionId?:string;runId?:string;agentId?:string;workspaceDir?:string;runtime?:string;modelProviderId?:string;modelId?:string;contextTokenBudget?:number;contextWindowSource?:string;toolAuthority?:{assertActive:()=>void}};
export type NativePeerRuntimeResolver=(input:{config:unknown;sessionKey:string;model:string;sessionEntry:Record<string,unknown>})=>string|undefined;
type ToolResult={content:Array<Record<string,unknown>>;details?:unknown;[key:string]:unknown};
type NativeBudget={state:"unknown";source:"native_estimate"}|{state:"known";source:"native_estimate";contextWindowTokens:number;inputTokens:number;outputTokens:number;overheadTokens:number};
type RequestBudget={fingerprint:string;inputBytes:number;window?:number;calls:Set<string>;outputDebit:number;toolDebit:number;peerDebit:number;generation:number;valid:boolean;output:number};
const tokens=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0&&value<=1000000000;
const unknownBudget=():NativeBudget=>({state:"unknown",source:"native_estimate"});
function textOnlyHistory(messages:unknown[]):boolean{
  return messages.length<=4096&&messages.every((message:any)=>message&&typeof message==="object"
    &&(typeof message.content==="string"||Array.isArray(message.content)&&message.content.every((block:any)=>block&&["text","thinking","toolCall","tool_use","tool_result"].includes(block.type)
      &&(block.type!=="tool_result"||typeof block.content==="string"||Array.isArray(block.content)&&block.content.every((part:any)=>part?.type==="text")))));
}

/** Only explicit, config-owned native completions models; no provider credentials are retained. */
export function openClawPeerBudgetConfig(config:unknown,model:string,agentId:string):{output:number;window:number;fingerprint:string}|undefined{
  try{
    const cfg=config as any,separator=model.indexOf("/"),providerId=model.slice(0,separator),modelId=model.slice(separator+1);
    if(separator<1||!modelId)return;
    const provider=cfg?.models?.providers?.[providerId];
    if(provider?.api!=="openai-completions"||!Array.isArray(provider.models))return;
    const matches=provider.models.filter((entry:any)=>entry?.id===modelId);if(matches.length!==1)return;
    const selected=matches[0];if(selected.api!==undefined&&selected.api!==provider.api||!tokens(selected.maxTokens)||!tokens(selected.contextWindow))return;
    const agent=cfg.agents?.entries?.[agentId]??cfg.agents?.list?.find((entry:any)=>entry?.id===agentId);
    const params=[selected.params,cfg.agents?.defaults?.params,cfg.agents?.defaults?.models?.[model]?.params,agent?.models?.[model]?.params,agent?.params];
    let output=selected.maxTokens;
    for(const source of params){
      if(source===undefined)continue;if(!source||typeof source!=="object"||Array.isArray(source))return;
      if(source.extra_body!==undefined||source.extraBody!==undefined)return;
      for(const key of ["maxTokens","max_tokens","maxOutputTokens","max_output_tokens","max_completion_tokens"]){
        if(source[key]===undefined)continue;if(!tokens(source[key]))return;output=Math.max(output,source[key]);
      }
    }
    if(output>=selected.contextWindow)return;
    return {output,window:selected.contextWindow,fingerprint:parameterHash({model,output,window:selected.contextWindow,params,api:provider.api,baseUrl:provider.baseUrl,compat:selected.compat})};
  }catch{return;}
}
export interface NativePeerApi {
  id?:string;
  config?:unknown;
  runtime?:{version?:string;config?:{current:()=>unknown};agent?:{session?:{getSessionEntry:(params:{agentId:string;sessionKey:string;readConsistency:"latest";hydrateSkillPromptRefs:false})=>Record<string,unknown>|undefined}}};
  registerGatewayMethod:(method:string,handler:(call:GatewayCall)=>void,opts:{scope:"operator.admin"})=>void;
  registerAgentToolResultMiddleware?:(handler:(event:{toolCallId:string;toolName:string;cwd?:string;isError?:boolean;result:ToolResult},ctx:NativeContext)=>Promise<{result:ToolResult}|void>,options:{runtimes:["openclaw"]})=>void;
  on:(name:string,handler:(event:any,ctx:any)=>unknown,options?:unknown)=>void;
  lifecycle?:{registerRuntimeLifecycle:(value:{id:string;cleanup:(ctx:{sessionKey?:string;runId?:string})=>void})=>void};
}
type ContextApplication={toolCallId:string;toolName:string;text:string;accepted:boolean;observation:{boundaryId:string;nativeSessionId:string;messageIds:string[]}};
type Binding=z.infer<typeof bindingInput>&{owner:string;current:()=>boolean;abort:AbortController;timer:ReturnType<typeof setTimeout>;detach:()=>void;fingerprint:string;pending:boolean;seen:Set<string>;budget?:RequestBudget;applications:Map<string,ContextApplication>};

/** Separate collaboration grants; human/group tools share transport helpers, not authority. */
export class NativePeerContexts {
  private bindings=new Map<string,Binding>();
  private ready=()=>false;
  private api?:NativePeerApi;
  private resolveRuntime?:NativePeerRuntimeResolver;
  private loading?:Promise<void>;
  constructor(private options:{resolveRuntime?:NativePeerRuntimeResolver;loadRuntimeResolver?:()=>Promise<NativePeerRuntimeResolver>}={}){this.resolveRuntime=options.resolveRuntime;}

  private selectedRuntime(sessionKey:string,model:string,sessionId:string):string|undefined {
    try{
      const api=this.api,entry=api?.runtime?.agent?.session?.getSessionEntry({agentId:sessionKey.split(":")[1]!,sessionKey,readConsistency:"latest",hydrateSkillPromptRefs:false});
      if(!entry||entry.sessionId!==sessionId||!this.resolveRuntime)return;
      return this.resolveRuntime({config:api?.runtime?.config?.current?.()??api?.config,sessionKey,model,sessionEntry:entry});
    }catch{return;}
  }

  register(api:NativePeerApi):void {
    this.api=api;
    this.ready=()=>{
      try{
        const raw=api.runtime?.config?.current?.()??api.config;
        const config=z.object({plugins:z.object({enabled:z.boolean().optional(),entries:z.record(z.unknown())}).passthrough()}).parse(raw);
        const entry=z.object({enabled:z.boolean().optional(),config:z.object({peerContext:z.boolean().optional()}).passthrough().optional(),
          hooks:z.object({allowPromptInjection:z.boolean().optional(),allowConversationAccess:z.boolean().optional()}).passthrough().optional()}).parse(config.plugins.entries[api.id??"agent-phonon-hitl"]);
        return ["2026.9.3","2026.10.7"].includes(api.runtime?.version??"")&&typeof api.registerAgentToolResultMiddleware==="function"&&config.plugins.enabled!==false
          &&entry?.enabled===true&&entry.config?.peerContext===true&&entry.hooks?.allowPromptInjection===true&&entry.hooks.allowConversationAccess===true;
      }catch{return false;}
    };
    api.registerGatewayMethod(PEER_CAPABILITIES,call=>{
      try{const authority=nativeGatewayAuthority(call);
        const input=z.union([z.object({version:z.literal(1)}).strict(),z.object({version:z.literal(1),sessionKey:identity.shape.sessionKey,sessionId:z.string().uuid(),model:z.string().min(3).max(512)}).strict()]).parse(call.params);
        const reply=()=>{if(!authority.current()){this.reject(call);return;}
          const selectedRuntime="sessionKey" in input?this.selectedRuntime(input.sessionKey,input.model,input.sessionId):null;
          call.respond(true,{version:1,available:this.ready()&&(!("sessionKey"in input)||selectedRuntime==="openclaw"),selectedRuntime:selectedRuntime??null,
            nativeVersion:api.runtime?.version??null,runtimes:["openclaw"],boundary:"after_tools",visibility:"collapsed",evidence:"context_hook",budget:"native_estimate",
            ...(this.ready()&&api.runtime?.version==="2026.10.7"?{currentTurnInput:"native_context_v1"}:{})});};
        if("sessionKey"in input&&this.ready()&&!this.resolveRuntime&&this.options.loadRuntimeResolver){
          this.loading??=this.options.loadRuntimeResolver().then(resolver=>{this.resolveRuntime=resolver;});
          void this.loading.then(reply,()=>this.reject(call));return;
        }
        reply();
      }catch{this.reject(call);}
    },{scope:"operator.admin"});
    api.registerGatewayMethod(PEER_BIND,call=>this.gateway(call,false),{scope:"operator.admin"});
    api.registerGatewayMethod(PEER_RELEASE,call=>this.gateway(call,true),{scope:"operator.admin"});
    api.on("llm_input",(event:any,ctx:NativeContext)=>{
      const binding=this.observedBinding(event,ctx);if(!binding)return;
      const configured=this.budgetConfig(binding);
      if(binding.budget){binding.budget.valid=false;binding.applications.clear();return;}
      binding.budget=undefined;
      if(!configured||!Array.isArray(event.historyMessages)||!Array.isArray(event.tools)||typeof event.systemPrompt!=="string"
        ||typeof event.prompt!=="string"||event.imagesCount!==0||!textOnlyHistory(event.historyMessages))return;
      try{
        const inputBytes=Buffer.byteLength(JSON.stringify({system:event.systemPrompt,messages:event.historyMessages,prompt:event.prompt,tools:event.tools}));
        if(inputBytes>1000000)return;
        binding.budget={fingerprint:configured.fingerprint,inputBytes,calls:new Set(),outputDebit:0,toolDebit:0,peerDebit:0,generation:0,valid:true,output:configured.output};
      }catch{return;}
    });
    api.on("model_call_started",async(event:any,ctx:NativeContext)=>{
      const binding=this.observedBinding(event,ctx),budget=binding?.budget;if(!binding||!budget)return;
      const configured=this.budgetConfig(binding);
      budget.generation++;
      if(!budget.valid||!configured||configured.fingerprint!==budget.fingerprint||!tokens(event.contextTokenBudget)||!tokens(ctx.contextTokenBudget)
        ||event.contextTokenBudget!==ctx.contextTokenBudget||!["model","modelsConfig","agentContextTokens"].includes(event.contextWindowSource)
        ||event.contextWindowSource!==ctx.contextWindowSource||event.api!=="openai-completions"||typeof event.callId!=="string"||!event.callId||event.callId.length>512
        ||budget.calls.has(event.callId)||budget.calls.size>=128){budget.valid=false;binding.applications.clear();return;}
      budget.calls.add(event.callId);budget.window=Math.min(configured.window,event.contextTokenBudget,budget.window??Infinity);
      // Each completed inference may contribute up to its full output allocation before the next tool boundary.
      budget.outputDebit+=configured.output+1024;
      const applications=[...binding.applications.values()];binding.applications.clear();
      for(const application of applications)if(application.accepted)await this.confirmContext(binding,application);
    });
    if(api.runtime?.version==="2026.10.7")api.on("tool_result_persist",(event:any,ctx:NativeContext&{toolCallId?:string})=>{
      const binding=this.get(ctx.sessionKey),message=event.message;
      if(!binding?.nativeInput||ctx.agentId!==binding.sessionKey.split(":")[1]||event.isSynthetic===true||message?.role!=="toolResult"
        ||message.isError===true||!Array.isArray(message.content)||message.content.length>200)return;
      for(const block of message.content){
        const tag=block?.[PEER_BLOCK_TAG],application=tag&&binding.applications.get(tag.boundaryId);
        if(application&&block.type==="text"&&block.text===application.text&&event.toolName===application.toolName
          &&event.toolCallId===application.toolCallId&&ctx.toolCallId===application.toolCallId&&message.toolCallId===application.toolCallId
          &&tag.version===1&&tag.projectionId===binding.projectionId&&tag.runId===binding.runId&&tag.sessionId===binding.sessionId)application.accepted=true;
      }
    });
    for(const name of ["before_compaction","after_compaction","before_reset"])api.on(name,(_event:unknown,ctx:NativeContext)=>{
      const binding=this.get(ctx.sessionKey);if(binding&&binding.runId===ctx.runId&&binding.sessionId===ctx.sessionId){binding.budget=undefined;binding.applications.clear();}
    });
    if(typeof api.registerAgentToolResultMiddleware==="function")api.registerAgentToolResultMiddleware(async(event,ctx)=>{
      try{
        const binding=this.get(ctx.sessionKey);
        if(binding&&binding.runId===ctx.runId&&binding.sessionId===ctx.sessionId&&ctx.agentId===binding.sessionKey.split(":")[1]&&ctx.runtime==="openclaw"&&binding.budget){
          const budget=binding.budget;budget.generation++;
          try{budget.toolDebit+=Buffer.byteLength(JSON.stringify(event.result))+1024;}catch{budget.valid=false;}
          if(!Array.isArray(event.result.content)||event.result.content.some(block=>block.type!=="text"))budget.valid=false;
        }
        const status=event.result.details&&typeof event.result.details==="object"?(event.result.details as {status?:unknown}).status:undefined;
        if(ctx.runtime!=="openclaw"||event.isError===true||typeof status==="string"&&/error|fail|denied|cancel|approval|timeout/i.test(status)
          ||!event.toolCallId||!Array.isArray(event.result.content)||!event.result.content.length||event.result.content.length>=200)return;
        const delivered=await this.deliver(ctx,"tool:"+event.toolCallId,event.cwd);
        if(!delivered)return;
        if(!binding||this.get(ctx.sessionKey)!==binding)return;
        if(binding.nativeInput)binding.applications.set(delivered.boundaryId,{toolCallId:event.toolCallId,toolName:event.toolName,text:delivered.text,accepted:false,
          observation:{boundaryId:delivered.boundaryId,nativeSessionId:binding.sessionId,messageIds:delivered.messageIds}});
        return {result:{...event.result,content:[...event.result.content,{type:"text",text:delivered.text,
          [PEER_BLOCK_TAG]:{version:1,projectionId:delivered.projectionId,runId:ctx.runId,sessionId:ctx.sessionId,boundaryId:delivered.boundaryId}}]}};
      }catch{return;}
    },{runtimes:["openclaw"]});
    api.on("before_prompt_build",async(_event:unknown,ctx:NativeContext)=>{
      try{
        if(!ctx.toolAuthority||!ctx.sessionKey||!ctx.sessionId||!ctx.modelProviderId||!ctx.modelId
          ||this.selectedRuntime(ctx.sessionKey,ctx.modelProviderId+"/"+ctx.modelId,ctx.sessionId)!=="openclaw")return;
        ctx.toolAuthority.assertActive();
        const delivered=await this.deliver(ctx,"initial",ctx.workspaceDir,()=>ctx.toolAuthority!.assertActive());
        if(delivered){ctx.toolAuthority.assertActive();return {appendContext:delivered.text};}
      }catch{return;}
    },{requiresToolAuthority:true,priority:50});
    api.on("agent_end",(_event:unknown,ctx:NativeContext)=>{const binding=this.get(ctx.sessionKey);if(binding&&binding.runId===ctx.runId)this.remove(binding);});
    api.lifecycle?.registerRuntimeLifecycle({id:"phonon-peer-context",cleanup:ctx=>{
      for(const binding of this.bindings.values())if((!ctx.sessionKey||ctx.sessionKey===binding.sessionKey)&&(!ctx.runId||ctx.runId===binding.runId))this.remove(binding);
    }});
  }

  private reject(call:GatewayCall){call.respond(false,undefined,{code:"INVALID_REQUEST",message:"Peer context binding unavailable or unauthorized"});}
  private gateway(call:GatewayCall,release:boolean):void {
    try{
      const authority=nativeGatewayAuthority(call);
      if(release){const input=identity.parse(call.params),binding=this.get(input.sessionKey);
        if(binding&&binding.runId===input.runId){if(binding.owner!==authority.owner)throw new Error("foreign binding");this.remove(binding);call.respond(true,{version:1,released:true});}
        else call.respond(true,{version:1,released:false});return;}
      if(!this.ready())throw new Error("unsupported peer context");
      const input=bindingInput.parse(call.params);loopbackEndpoint(input.endpoint,"/peer-context");
      if(input.nativeInput&&this.api?.runtime?.version!=="2026.10.7")throw new Error("unsupported native input lifecycle");
      if(this.selectedRuntime(input.sessionKey,input.model,input.sessionId)!=="openclaw"||realpathSync(input.workspaceDir)!==input.workspaceDir||input.expiresAt<=Date.now()||input.expiresAt>Date.now()+1800000)throw new Error("invalid peer binding");
      for(const key of this.bindings.keys())this.get(key);
      const existing=this.get(input.sessionKey),fingerprint=parameterHash(input);
      if(existing){if(existing.owner!==authority.owner||existing.runId!==input.runId||existing.fingerprint!==fingerprint)throw new Error("busy binding");call.respond(true,{version:1,bound:true,projectionId:input.projectionId});return;}
      if(this.bindings.size>=64)throw new Error("peer binding limit");
      const retire=()=>this.remove(binding);
      const binding:Binding={...input,owner:authority.owner,current:authority.current,abort:new AbortController(),fingerprint,pending:false,seen:new Set(),applications:new Map(),
        timer:setTimeout(retire,input.expiresAt-Date.now()),detach:()=>authority.signal.removeEventListener("abort",retire)};
      binding.timer.unref();this.bindings.set(input.sessionKey,binding);authority.signal.addEventListener("abort",retire,{once:true});
      call.respond(true,{version:1,bound:true,projectionId:input.projectionId});
    }catch{this.reject(call);}
  }
  private get(key?:string):Binding|undefined {
    const binding=key?this.bindings.get(key):undefined;
    if(binding&&(!this.ready()||binding.nativeInput&&this.api?.runtime?.version!=="2026.10.7"||binding.expiresAt<=Date.now()||!binding.current()||this.selectedRuntime(binding.sessionKey,binding.model,binding.sessionId)!=="openclaw")){this.remove(binding);return;}
    return binding;
  }
  private remove(binding:Binding):void {
    if(this.bindings.get(binding.sessionKey)!==binding)return;
    this.bindings.delete(binding.sessionKey);binding.abort.abort();binding.token="";binding.seen.clear();binding.applications.clear();clearTimeout(binding.timer);binding.detach();
  }
  private budgetConfig(binding:Binding){return openClawPeerBudgetConfig(this.api?.runtime?.config?.current?.()??this.api?.config,binding.model,binding.sessionKey.split(":")[1]!);}
  private observedBinding(event:any,ctx:NativeContext):Binding|undefined{
    const binding=this.get(ctx.sessionKey);if(!binding||binding.runId!==ctx.runId||binding.sessionId!==ctx.sessionId||event.runId!==binding.runId||event.sessionId!==binding.sessionId)return;
    if(ctx.agentId!==undefined&&ctx.agentId!==binding.sessionKey.split(":")[1]||ctx.modelProviderId!==undefined&&ctx.modelProviderId+"/"+ctx.modelId!==binding.model)return;
    if(event.provider+"/"+event.model!==binding.model){binding.budget=undefined;binding.applications.clear();return;}
    if(event.sessionKey!==undefined&&event.sessionKey!==binding.sessionKey)return;
    return binding;
  }
  private budget(binding:Binding):NativeBudget{
    const value=binding.budget,configured=this.budgetConfig(binding);
    if(!value?.valid||!configured||configured.fingerprint!==value.fingerprint||!value.window||!value.calls.size)return unknownBudget();
    const inputTokens=value.inputBytes+value.outputDebit+value.toolDebit+value.peerDebit;
    if(!tokens(inputTokens))return unknownBudget();
    return {state:"known",source:"native_estimate",contextWindowTokens:value.window,inputTokens,outputTokens:value.output,overheadTokens:2048};
  }
  private async confirmContext(binding:Binding,application:ContextApplication):Promise<void>{
    if(!binding.nativeInput||this.get(binding.sessionKey)!==binding)return;
    try{
      await fetch(new URL("/peer-context/context-applied",binding.endpoint),{method:"POST",redirect:"error",signal:AbortSignal.any([binding.abort.signal,AbortSignal.timeout(1500)]),
        headers:{"Content-Type":"application/json",Authorization:"Bearer "+binding.token},body:JSON.stringify(application.observation)}).then(readJson);
    }catch{/* Native context remains unconfirmed; never start another native run. */}
  }
  private async deliver(ctx:NativeContext,key:string,cwd?:string,assertNative?:()=>void):Promise<{text:string;projectionId:string;boundaryId:string;messageIds:string[]}|undefined> {
    const binding=this.get(ctx.sessionKey);
    if(!binding||binding.pending||binding.runId!==ctx.runId||binding.sessionId!==ctx.sessionId||ctx.agentId!==binding.sessionKey.split(":")[1]
      ||binding.seen.has(key)||binding.seen.size>=256)return;
    if(binding.nativeInput&&(!key.startsWith("tool:")||binding.applications.size>=32))return;
    try{if(!cwd||realpathSync(cwd)!==binding.workspaceDir)return;}catch{return;}
    binding.pending=true;binding.seen.add(key);
    try{
      const signal=AbortSignal.any([binding.abort.signal,AbortSignal.timeout(1500)]),snapshot=binding.budget,generation=snapshot?.generation,
        boundary={boundaryId:randomUUID(),nativeSessionId:binding.sessionId,budget:this.budget(binding)};
      assertNative?.();
      const request=(path:string,input:unknown)=>fetch(new URL(path,binding.endpoint),{method:"POST",redirect:"error",signal,
        headers:{"Content-Type":"application/json",Authorization:"Bearer "+binding.token},body:JSON.stringify(input)}).then(readJson);
      const batch=batchSchema.parse(await request("/peer-context",boundary));
      assertNative?.();
      if(signal.aborted||this.get(ctx.sessionKey)!==binding||binding.budget!==snapshot||snapshot?.generation!==generation||batch.boundaryId!==boundary.boundaryId||batch.nativeSessionId!==binding.sessionId||!batch.messages.length)return;
      const current=this.budget(binding);
      if(boundary.budget.state!=="known"||current.state!=="known"||current.inputTokens>boundary.budget.inputTokens)return;
      const text=batch.messages.map(item=>item.content).join("\n\n");if(Buffer.byteLength(text)>16000)return;
      if(snapshot)snapshot.peerDebit+=Buffer.byteLength(text)+64*batch.messages.length;
      const messageIds=batch.messages.map(item=>item.messageId);
      await request(binding.nativeInput?"/peer-context/authorize":"/peer-context/observe",{boundaryId:boundary.boundaryId,nativeSessionId:boundary.nativeSessionId,messageIds,evidence:"context_hook"});
      assertNative?.();if(signal.aborted||this.get(ctx.sessionKey)!==binding||binding.budget!==snapshot||snapshot?.generation!==generation)return;
      return {text,projectionId:binding.projectionId,boundaryId:boundary.boundaryId,messageIds};
    }finally{binding.pending=false;}
  }
}
