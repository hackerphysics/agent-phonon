import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SendOptions } from "../adapter.js";
import { AgentCoordinationInput } from "@agent-phonon/protocol";
import { zodToJsonSchema } from "zod-to-json-schema";
import { verifiedNativeToolChannel } from "../native-tool-channel.js";
import { buildChildProcessEnvironment } from "../child-env.js";

/** Native extension hooks, not messages, permission handlers or a mailbox tool. */
export const COPILOT_PEER_CONTEXT_SOURCE = String.raw`
import { request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
const coordinationSchema=__COORDINATION_SCHEMA__;
const integer=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000000;
const unknownBudget=()=>({state:"unknown",source:"native_estimate"});

export async function readCopilotNativeBudget(session,usage,toolResult,environment=process.env) {
  if(!usage||!integer(usage.tokenLimit)||usage.tokenLimit===0||!integer(usage.currentTokens)
    ||![usage.systemTokens,usage.conversationTokens,usage.toolDefinitionsTokens].every(integer)
    ||usage.currentTokens!==usage.systemTokens+usage.conversationTokens+usage.toolDefinitionsTokens)return unknownBudget();
  let timer,expired=false;
  try{return await Promise.race([(async()=>{
    const current=await session.rpc.model.getCurrent(),model=current?.modelId;
    if(expired||typeof model!=="string"||!model||model==="auto")return unknownBudget();
    let output,promptLimit=usage.tokenLimit;
    if(environment.COPILOT_PROVIDER_TYPE){
      if(!["openai","azure"].includes(environment.COPILOT_PROVIDER_TYPE)||environment.COPILOT_PROVIDER_WIRE_API!=="completions"
        ||environment.COPILOT_MODEL!==model||!/^[1-9][0-9]{0,9}$/.test(environment.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS??""))return unknownBudget();
      const route=new URL(environment.COPILOT_PROVIDER_BASE_URL);
      if(!["http:","https:"].includes(route.protocol)||route.username||route.password||route.search||route.hash)return unknownBudget();
      output=Number(environment.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS);
      if(environment.COPILOT_PROVIDER_MAX_PROMPT_TOKENS!==undefined){
        if(!/^[1-9][0-9]{0,9}$/.test(environment.COPILOT_PROVIDER_MAX_PROMPT_TOKENS))return unknownBudget();
        promptLimit=Math.min(promptLimit,Number(environment.COPILOT_PROVIDER_MAX_PROMPT_TOKENS));
      }
    }else{
      const models=await session.rpc.model.list();
      if(expired||!Array.isArray(models?.list)||models.list.length>512)return unknownBudget();
      const matches=models.list.filter(entry=>entry?.id===model),limits=matches.length===1?matches[0].capabilities?.limits:undefined;
      if(!limits||!integer(limits.max_output_tokens)||limits.max_output_tokens===0)return unknownBudget();
      output=limits.max_output_tokens;
      if(limits.max_prompt_tokens!==undefined){if(!integer(limits.max_prompt_tokens)||limits.max_prompt_tokens===0)return unknownBudget();promptLimit=Math.min(promptLimit,limits.max_prompt_tokens);}
      if(limits.max_context_window_tokens!==undefined){if(!integer(limits.max_context_window_tokens)||limits.max_context_window_tokens===0)return unknownBudget();promptLimit=Math.min(promptLimit,limits.max_context_window_tokens);}
    }
    if(!integer(output)||output===0||output>=promptLimit)return unknownBudget();
    const result=await session.rpc.metadata.contextInfo({selectedModel:model,promptTokenLimit:promptLimit,outputTokenLimit:output}),info=result?.contextInfo;
    if(expired)return unknownBudget();
    const after=await session.rpc.model.getCurrent();
    if(expired||after?.modelId!==model||after.contextTier!==current.contextTier||!info||info.modelName!==model
      ||![info.systemTokens,info.conversationTokens,info.toolDefinitionsTokens,info.totalTokens].every(integer)
      ||info.totalTokens!==info.systemTokens+info.conversationTokens+info.toolDefinitionsTokens
      ||info.promptTokenLimit!==promptLimit)return unknownBudget();
    const inputTokens=Math.max(usage.currentTokens,info.totalTokens)+Buffer.byteLength(JSON.stringify(toolResult??null));
    if(!integer(inputTokens))return unknownBudget();
    // Native prompt allocation excludes output; keep an additional conservative output/safety reserve.
    return {state:"known",source:"native_estimate",contextWindowTokens:promptLimit,inputTokens,outputTokens:output,outputReservation:"native_usable_window",overheadTokens:1024};
  })(),new Promise(resolve=>{timer=setTimeout(()=>{expired=true;resolve(unknownBudget());},750);})]);}
  catch{return unknownBudget();}finally{clearTimeout(timer);}
}

export function createCopilotPeerHooks({sessionId,cwd,promptHash,checkpoint,getNativeTasks,getPendingPermissions,getNativeBudget=async()=>unknownBudget(),active=()=>true,onClosed=()=>{}}) {
  const tools=new Map(),children=new Set();
  let live=true,submitted=false,pending=false,childGeneration=0,lookups=0,nativeHumanPending=false;
  let usage,usageGeneration=0,peerDebit=0,compacting=false;
  const running=()=>live&&active()&&!nativeHumanPending;
  const deactivate=()=>{if(!live)return;live=false;tools.clear();children.clear();try{onClosed();}catch{}};
  const owned=(input,invocation)=>{
    if(!running()||invocation?.sessionId!==sessionId||typeof input?.workingDirectory!=="string")return false;
    try{return realpathSync(input.workingDirectory)===realpathSync(cwd);}catch{return false;}
  };
  const nativeTasks=async()=>{
    try{
      if(++lookups>256)throw new Error("Native task scope budget exhausted");
      const permissions=await getPendingPermissions();
      if(!Array.isArray(permissions)||permissions.length>256)throw new Error("Native permission scope unavailable");
      if(permissions.length){nativeHumanPending=true;return;}
      const tasks=await getNativeTasks();
      if(!Array.isArray(tasks)||tasks.length>256||tasks.some(task=>!task||!["agent","shell"].includes(task.type)
        ||task.type==="agent"&&(typeof task.id!=="string"||!task.id||task.id.length>512||typeof task.toolCallId!=="string"||task.toolCallId.length>512||!["running","idle","completed","failed","cancelled"].includes(task.status))))throw new Error("Native task scope unavailable");
      return tasks;
    }catch{deactivate();return;}
  };
  const observe=event=>{
    if(!live||!active()||!event||typeof event.type!=="string")return;
    const data=event.data??{};
    if(!event.agentId&&event.type==="session.compaction_start")compacting=true;
    if(!event.agentId&&event.type==="session.compaction_complete")compacting=false;
    if(!event.agentId&&event.type==="session.usage_info"&&!compacting){usage=data;usageGeneration++;}
    if(!event.agentId&&["session.model_change","session.compaction_start","session.compaction_complete","session.truncation","session.context_changed","abort"].includes(event.type)){
      usage=undefined;usageGeneration++;
    }
    if(["permission.requested","user_input.requested","elicitation.requested"].includes(event.type)){nativeHumanPending=true;return;}
    if(["permission.completed","user_input.completed","elicitation.completed"].includes(event.type)){nativeHumanPending=false;return;}
    if(event.type==="subagent.started"){
      if(typeof event.agentId!=="string"||!event.agentId||children.size>=128){deactivate();return;}
      children.add(event.agentId);childGeneration++;
    }else if(event.type==="subagent.completed"||event.type==="subagent.failed"){
      if(typeof event.agentId!=="string"||!children.delete(event.agentId))deactivate();
    }else if(event.type==="tool.execution_start"){
      if(typeof data.toolCallId!=="string"||!data.toolCallId||typeof data.toolName!=="string"||tools.has(data.toolCallId)||tools.size>=256){deactivate();return;}
      tools.set(data.toolCallId,{id:data.toolCallId,name:data.toolName,args:data.arguments,root:!event.agentId&&!data.parentToolCallId,used:false});
    }else if(event.type==="tool.execution_complete")tools.delete(data.toolCallId);
    else if(!event.agentId&&(["session.shutdown","session.error"].includes(event.type)||submitted&&["session.idle","assistant.idle"].includes(event.type)))deactivate();
  };
  const deliver=async(eligible=()=>children.size===0,toolResult)=>{
    if(!running()||pending||!eligible())return;
    pending=true;
    const boundaryId=randomUUID();
    try{
      const generation=usageGeneration,budget=await getNativeBudget(usage,toolResult);
      if(!running()||!eligible()||generation!==usageGeneration)return;
      if(budget?.state==="known")budget.inputTokens+=peerDebit;
      const batch=await checkpoint("/peer-context",{boundaryId,nativeSessionId:sessionId,budget:budget??unknownBudget()});
      if(!running()||!eligible()||generation!==usageGeneration||batch.boundaryId!==boundaryId||batch.nativeSessionId!==sessionId||!Array.isArray(batch.messages)
        ||!batch.messages.length||batch.messages.length>8||batch.messages.some(item=>typeof item.messageId!=="string"||typeof item.content!=="string")
        ||Buffer.byteLength(batch.messages.map(item=>item.content).join("\n\n"))>16000)return;
      const additionalContext=batch.messages.map(item=>item.content).join("\n\n");
      peerDebit+=Buffer.byteLength(additionalContext)+64*batch.messages.length;
      try{await checkpoint("/peer-context/observe",{boundaryId,nativeSessionId:sessionId,messageIds:batch.messages.map(item=>item.messageId),evidence:"context_hook"});}
      catch{/* A native hook output is not a provider-payload or consumption receipt. */}
      if(!running()||!eligible()||generation!==usageGeneration)return;
      return {additionalContext};
    }catch{return;}
    finally{pending=false;}
  };
  return {observe,deactivate,isActive:running,async authorizeTool(invocation,args){
    if(!running()||!submitted||invocation?.sessionId!==sessionId||invocation.toolName!=="phonon_project_coordination"
      ||typeof invocation.toolCallId!=="string")return false;
    await new Promise(resolve=>setImmediate(resolve));
    const tool=tools.get(invocation.toolCallId),generation=childGeneration;
    if(!tool||!tool.root||tool.called||tool.name!==invocation.toolName||!isDeepStrictEqual(tool.args,args))return false;
    const tasks=await nativeTasks();
    if(!tasks||!running()||tools.get(tool.id)!==tool||children.size||childGeneration!==generation
      ||tasks.some(task=>task.type==="agent"&&task.status==="running"))return false;
    tool.called=true;return true;
  },hooks:{
    async onUserPromptSubmitted(input,invocation){
      if(!owned(input,invocation)||submitted||children.size||typeof input.prompt!=="string"
        ||createHash("sha256").update(input.prompt).digest("hex")!==promptHash)return;
      const tasks=await nativeTasks();
      if(!tasks||!owned(input,invocation))return;
      submitted=true;
      usage=undefined;usageGeneration++;
      if(tasks.some(task=>task.type==="agent"))return;
      return deliver();
    },
    async onPostToolUse(input,invocation){
      if(!owned(input,invocation)||!submitted||input.toolResult?.resultType!=="success")return;
      // A root-tool candidate alone cannot disambiguate identical child calls.
      await new Promise(resolve=>setImmediate(resolve));
      if(!owned(input,invocation))return;
      const matching=()=>[...tools.values()].filter(tool=>tool.name===input.toolName&&isDeepStrictEqual(tool.args,input.toolArgs));
      const matches=matching();
      if(matches.length!==1||!matches[0].root||matches[0].used)return;
      const tasks=await nativeTasks();
      if(!tasks||!owned(input,invocation))return;
      if(matches[0].name==="task"){
        const childId=input.toolResult.toolTelemetry?.restrictedProperties?.agent_id;
        const linked=tasks.filter(task=>task.type==="agent"&&task.toolCallId===matches[0].id);
        if(typeof childId!=="string"||linked.length!==1||linked[0].id!==childId)return;
      }else if(children.size||tasks.some(task=>task.type==="agent"&&task.status==="running"))return;
      const tool=matches[0],generation=childGeneration;tool.used=true;
      // Child terminal events can follow the root task's hook. Verify this exact root tool instead.
      return deliver(()=>tools.get(tool.id)===tool&&childGeneration===generation&&matching().length===1,input.toolResult);
    },
  }};
}

export async function installCopilotPeerContext({joinSession,channel,onReady=()=>{},onClosed=()=>{}}){
  const endpoint=new URL(channel.url||""),token=channel.token;
  if(endpoint.protocol!=="http:"||endpoint.hostname!=="127.0.0.1"||!endpoint.port||endpoint.pathname!=="/peer-context"
    ||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^[A-Za-z0-9_-]{43}$/.test(token||"")
    ||!/^[a-f0-9-]{36}$/.test(channel.sessionId||"")||process.env.SESSION_ID!==channel.sessionId
    ||!/^[a-f0-9]{64}$/.test(channel.promptHash||"")||typeof channel.cwd!=="string")throw new Error("Invalid owned native peer binding");
  let joined=false;
  const checkpoint=(path,input)=>new Promise((resolve,reject)=>{
    const req=request(new URL(path,endpoint),{method:"POST",agent:false,signal:AbortSignal.timeout(1500),
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"}},res=>{
      const chunks=[];let size=0;
      res.on("data",chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(new Error("Checkpoint exceeds limit"));}else chunks.push(chunk);});
      res.on("error",reject);res.on("end",()=>{try{if(res.statusCode!==200)throw new Error("Checkpoint unavailable");resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch(error){reject(error);}});
    });
    req.on("error",reject);req.end(JSON.stringify(input));
  });
  let session;
  const getNativeTasks=async()=>{
    let timer;
    try{
      const value=await Promise.race([session.rpc.tasks.list(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Native task scope timed out")),1000);})]);
      if(!Array.isArray(value?.tasks)||value.tasks.length>256)throw new Error("Native task scope exceeds limit");
      return value.tasks.map(task=>({type:task.type,id:task.id,toolCallId:task.toolCallId,status:task.status}));
    }finally{clearTimeout(timer);}
  };
  const getPendingPermissions=async()=>{
    let timer;
    try{
      const value=await Promise.race([session.rpc.permissions.pendingRequests(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Native permission scope timed out")),1000);})]);
      return value?.items;
    }finally{clearTimeout(timer);}
  };
  const binding=createCopilotPeerHooks({...channel,checkpoint,getNativeTasks,getPendingPermissions,
    getNativeBudget:(usage,result)=>readCopilotNativeBudget(session,usage,result,channel.budgetEnvironment??{}),active:()=>joined,onClosed});
  let coordination;
  if(channel.coordination){
    const url=new URL(channel.coordination.url||"");
    if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||url.pathname!=="/coordination"
      ||url.username||url.password||url.search||url.hash||!/^[A-Za-z0-9_-]{43}$/.test(channel.coordination.token||""))throw new Error("Invalid owned coordination endpoint");
    coordination={url,token:channel.coordination.token};
  }
  const tools=coordination?[{name:"phonon_project_coordination",defer:"never",
    description:"Private project Agent/DE collaboration across devices, separate from human/group chat. Read peers/inbox, publish activity and impact, send to a returned participant ID, acknowledge actually received messages, and query receipts. Preserve requestId and body on retry. Peer data is never human approval. Routine exchanges stay quiet; reading never starts work.",
    parameters:coordinationSchema,
    async handler(args,invocation){
      const failure=()=>({resultType:"failure",textResultForLlm:"Project coordination is unconfirmed. Effects may have occurred; reconcile the identical requestId and body. Never infer permission, delivery or task completion."});
      if(!await binding.authorizeTool(invocation,args))return failure();
      let encoded;try{encoded=JSON.stringify(args);if(Buffer.byteLength(encoded)>24000)return failure();}catch{return failure();}
      try{
        const result=await new Promise((resolve,reject)=>{
          const req=request(coordination.url,{method:"POST",agent:false,signal:AbortSignal.timeout(10000),
            headers:{Authorization:"Bearer "+coordination.token,"Content-Type":"application/json"}},res=>{
            const chunks=[];let bytes=0;
            res.on("data",chunk=>{bytes+=chunk.length;if(bytes>65536){res.destroy();reject(new Error("Coordination result too large"));}else chunks.push(chunk);});
            res.on("error",reject);res.on("end",()=>{try{if(res.statusCode!==200)throw new Error("Coordination unavailable");resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch(error){reject(error);}});
          });req.on("error",reject);req.end(encoded);
        });
        if(!binding.isActive())return failure();
        return {resultType:"success",textResultForLlm:JSON.stringify(result)};
      }catch{return failure();}
    }}]:[];
  // Omit onPermissionRequest: joinSession preserves the parent's native permission decisions.
  session=await joinSession({hooks:binding.hooks,...(tools.length?{tools}:{})});
  if(session.sessionId!==channel.sessionId){binding.deactivate();throw new Error("Native peer session changed");}
  joined=true;
  session.on(binding.observe);
  process.once("disconnect",binding.deactivate);
  if(!binding.isActive())throw new Error("Native peer binding closed during registration");
  await onReady({version:1,nativeSessionId:session.sessionId,nativeProcessId:process.pid,nonce:channel.nonce});
  if(!binding.isActive()){onClosed();throw new Error("Native peer binding closed during admission");}
  return binding;
}
`.replace("__COORDINATION_SCHEMA__",JSON.stringify({type:"object",...zodToJsonSchema(AgentCoordinationInput,{$refStrategy:"none"})}));

/** Prepares one Phonon plugin, without installing it or granting native permissions. */
export function prepareCopilotPeerContext(options: SendOptions, input: { sessionId: string; cwd: string; prompt: string }): {
  path: string; modulePath: string; isReady: () => boolean; deactivate: () => void; cleanup: () => void;
} {
  const endpoint = new URL(options.environment?.AGENT_PHONON_PEER_CONTEXT_URL ?? "");
  const token = options.environment?.AGENT_PHONON_PEER_CONTEXT_TOKEN;
  if (!options.peerContext || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/peer-context"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9_-]{43}$/.test(token ?? "")
    || !/^[a-f0-9-]{36}$/.test(input.sessionId)) throw new Error("Copilot peer context requires an owned native checkpoint");
  let coordination: {url:string;token:string} | undefined;
  if(options.projectCoordination){
    const native=verifiedNativeToolChannel(options.environment??{}),url=new URL(options.environment?.AGENT_PHONON_COORDINATION_URL??"");
    if(url.origin!==native.url.origin||url.pathname!=="/coordination"||url.search||url.hash||url.username||url.password)throw new Error("Copilot requires the current-turn coordination capability");
    coordination={url:url.href,token:native.token};
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "phonon-copilot-peer-")));
  const extension = join(directory, "extensions", "peer-context"), modulePath = join(extension, "bridge.mjs");
  const nonce = randomBytes(16).toString("hex");
  const nativeEnvironment=buildChildProcessEnvironment(options.environment),budgetEnvironment:Record<string,string>={};
  for(const key of ["COPILOT_PROVIDER_TYPE","COPILOT_PROVIDER_WIRE_API","COPILOT_MODEL",
    "COPILOT_PROVIDER_MAX_PROMPT_TOKENS","COPILOT_PROVIDER_MAX_OUTPUT_TOKENS"])if(nativeEnvironment[key]!==undefined)budgetEnvironment[key]=nativeEnvironment[key]!.slice(0,512);
  if(nativeEnvironment.COPILOT_PROVIDER_BASE_URL!==undefined){
    budgetEnvironment.COPILOT_PROVIDER_BASE_URL="";
    try{const route=new URL(nativeEnvironment.COPILOT_PROVIDER_BASE_URL);
      if(["http:","https:"].includes(route.protocol)&&!route.username&&!route.password&&!route.search&&!route.hash&&route.href.length<=2048)
        budgetEnvironment.COPILOT_PROVIDER_BASE_URL=route.href;
    }catch{/* Ambiguous provider routes remain unbudgeted without copying credentials. */}
  }
  let closed = false;
  try {
    // Keep credentials out of argv and native shell/MCP environments. The extension consumes this once.
    writeFileSync(join(directory, ".phonon-peer-owner.json"), JSON.stringify({ version: 1, pid: process.pid, workflow: "copilot-peer-context" }), { mode: 0o600, flag: "wx" });
    mkdirSync(extension, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "plugin.json"), JSON.stringify({ name: "agent-phonon", version: "1.0.0", extensions: "extensions/" }), { mode: 0o600, flag: "wx" });
    writeFileSync(modulePath, COPILOT_PEER_CONTEXT_SOURCE, { mode: 0o600, flag: "wx" });
    writeFileSync(join(extension, "channel.json"), JSON.stringify({ url: endpoint.href, token, sessionId: input.sessionId, cwd: realpathSync(input.cwd),
      promptHash: createHash("sha256").update(input.prompt).digest("hex"), nonce,budgetEnvironment,...(coordination?{coordination}:{}) }), { mode: 0o600, flag: "wx" });
    writeFileSync(join(extension, "extension.mjs"), String.raw`
import {joinSession} from "@github/copilot-sdk/extension";
import {readFileSync,lstatSync,unlinkSync,writeFileSync} from "node:fs";
import {dirname,isAbsolute,join} from "node:path";
import {installCopilotPeerContext} from "./bridge.mjs";
const path=new URL("./channel.json",import.meta.url),stat=lstatSync(path);
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096||(stat.mode&0o077)!==0)throw new Error("Unsafe peer capsule");
const channel=JSON.parse(readFileSync(path,"utf8"));unlinkSync(path);
const sdk=process.env.COPILOT_SDK_PATH;
if(typeof sdk!=="string"||!isAbsolute(sdk))throw new Error("Native bundled SDK identity unavailable");
const host=JSON.parse(readFileSync(join(dirname(sdk),"package.json"),"utf8"));
if(host.name!=="@github/copilot"||host.version!=="1.0.82")throw new Error("Native peer host version is unqualified");
const ready=new URL("./native-ready.json",import.meta.url);
await installCopilotPeerContext({joinSession,channel,onReady:value=>writeFileSync(ready,JSON.stringify(value),{mode:0o600,flag:"wx"}),onClosed:()=>{try{unlinkSync(ready);}catch{}}});
`, { mode: 0o600, flag: "wx" });
    return { path: directory, modulePath, isReady: () => {
      if (closed) return false;
      try {
        const path = join(extension, "native-ready.json"), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 || (stat.mode & 0o077) !== 0) return false;
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (value.version !== 1 || value.nativeSessionId !== input.sessionId || value.nonce !== nonce || !Number.isSafeInteger(value.nativeProcessId) || value.nativeProcessId <= 0) return false;
        process.kill(value.nativeProcessId, 0);
        return true;
      } catch { return false; }
    }, deactivate: () => { closed = true; try { rmSync(join(extension, "channel.json"), { force: true }); } catch {} },
      cleanup: () => { closed = true; rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
