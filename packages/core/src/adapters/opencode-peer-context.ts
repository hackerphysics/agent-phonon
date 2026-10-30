import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import type { SendOptions } from "../adapter.js";
import {verifiedNativeToolChannel} from "../native-tool-channel.js";
import {nativeVersionAtLeast} from "@agent-phonon/protocol";

export function openCodePure(environment?: Record<string, string>): boolean {
  const value = environment?.OPENCODE_PURE ?? process.env.OPENCODE_PURE;
  return !!value && !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function formatOpenCodeRunPrompt(prompt:string):string {
  return prompt.includes(" ")?'"'+prompt.replace(/"/g,'\\"')+'"':prompt;
}

/** One invocation-scoped Phonon bridge; reuses native dependencies without changing user configuration. */
export const OPENCODE_RECEIVE_RUNTIME = `const nativeVersionAtLeast = ${nativeVersionAtLeast.toString()};\n` + String.raw`
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import {createRequire} from "node:module";
import {join} from "node:path";
import {homedir} from "node:os";
import {readFileSync,realpathSync} from "node:fs";
import {pathToFileURL} from "node:url";
const canonical=value=>JSON.stringify(value&&typeof value==="object"?Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
async function openCodeCoordinationTool(description,execute){
 const home=process.env.OPENCODE_CONFIG_DIR||join(process.env.XDG_CONFIG_HOME||join(homedir(),".config"),"opencode");
 const require=createRequire(join(home,"package.json")),toolPath=join(home,"node_modules","@opencode-ai","plugin","dist","tool.js");
 if(!nativeVersionAtLeast(JSON.parse(readFileSync(join(toolPath,"..","..","package.json"),"utf8")).version,"1.14.20"))throw new Error("Native plugin dependency requires >=1.14.20");
 const {tool}=await import(pathToFileURL(toolPath).href),z=tool?.schema;
 if(typeof tool!=="function"||typeof z?.enum!=="function"||typeof z?.object!=="function")throw new Error("Native plugin tool API is unavailable");
 return tool({description,args:{operation:z.enum(["presence","peers","activity","send","inbox","acknowledge","receipt","leave"]),
  requestId:z.string().uuid().optional(),recipientId:z.string().uuid().optional(),kind:z.enum(["intent","question","notice","request","result"]).optional(),
  text:z.string().max(4000).optional(),references:z.array(z.string().max(512)).max(8).optional(),inReplyTo:z.string().uuid().optional(),
  after:z.string().optional(),baseRevision:z.number().int().nonnegative().optional(),activity:z.object({summary:z.string().max(500),phase:z.enum(["planning","working","validating","blocked","idle","completed"]),impact:z.array(z.string()).max(16),dependencies:z.string().optional()}).optional(),messageIds:z.array(z.string().uuid()).max(32).optional()},execute});
}
async function installOpenCodePeer(input,capsule,transport) {
  const endpoint = capsule.peer?new URL(capsule.url || ""):undefined;
  const token = capsule.token, nonce = capsule.nonce;
  const expected = capsule.expected || "";
  if(capsule.peer&&(endpoint.protocol!=="http:" || endpoint.hostname!=="127.0.0.1" || !endpoint.port || endpoint.pathname!=="/peer-context"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9_-]{43}$/.test(token||""))
    || !/^[a-f0-9]{32}$/.test(nonce||"")) throw new Error("Phonon native peer checkpoint unavailable");
  let root,originalMessage,rootAgent,ended = false;
  const calls=new Map(),nativeRequests=new Map(),wrappedProviders=new Map(),providerEvidence=new Map();
  const markerHeader="x-phonon-native-boundary";
  const own=async(sid,signal)=>{const session=(await input.client.session.get({path:{id:sid},...(signal?{signal}:{})}))?.data;
    return !ended&&(!transport||transport.active())&&sid===root&&session?.id===root&&!session.parentID&&realpathSync(session.directory)===realpathSync(input.directory)
      &&(!transport?.verify||await transport.verify())&&!ended&&(!transport||transport.active());};
  const checkpoint = (path, body) => transport?transport.checkpoint(path,body):new Promise((resolve,reject)=>{
    const req=request(new URL(path,endpoint),{method:"POST",agent:false,signal:AbortSignal.timeout(1500),
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"}},res=>{
      const chunks=[];let size=0;
      res.on("data",chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(new Error("checkpoint response too large"));}else chunks.push(chunk);});
      res.on("error",reject);
      res.on("end",()=>{try{if(res.statusCode!==200)throw new Error("checkpoint not admitted");resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch(error){reject(error);}});
    });
    req.on("error",reject);req.end(JSON.stringify(body));
  });
  const modelKey=model=>JSON.stringify([model?.providerID,model?.id,model?.api?.id,model?.api?.url,model?.api?.npm,model?.limit]);
  const windowFor=model=>{
    const value=model?.limit?.context;
    return Number.isSafeInteger(value)&&value>0&&value<=1000000000?value:undefined;
  };
  async function withPeerRequest(providerID,baseURL,next,target,init){
    const headers=new Headers(init?.headers),key=headers.get(markerHeader);headers.delete(markerHeader);
    const clean=key?{...init,headers}:init;
    const binding=nativeRequests.get(key);if(key)nativeRequests.delete(key);
    if(!binding||ended||init?.signal?.aborted||binding.providerID!==providerID)return next(target,clean);
    let changed,observation;
    const valid=()=>!ended&&!init?.signal?.aborted&&binding.messageID===originalMessage&&binding.modelKey===modelKey(binding.model);
    try{
      const url=new URL(typeof target==="string"||target instanceof URL?target:target.url),base=new URL(baseURL);
      if(url.origin!==base.origin||url.pathname!==base.pathname.replace(/\/$/,"")+"/chat/completions"
        ||String(init?.method??"GET").toUpperCase()!=="POST"||typeof init.body!=="string"||Buffer.byteLength(init.body)>8388608
        ||binding.messageID!==originalMessage||!await own(root,init.signal))throw new Error("Unqualified native request");
      const request=JSON.parse(init.body),caps=[request.max_tokens,request.max_completion_tokens].filter(value=>value!==undefined);
      const known=windowFor(binding.model)&&binding.model?.api?.npm==="@ai-sdk/openai-compatible"
        &&request.model===binding.model.api.id&&Array.isArray(request.messages)&&caps.length>0
        &&caps.every(value=>Number.isSafeInteger(value)&&value>0&&value<=1000000000);
      const budget=known?{state:"known",source:"native_estimate",contextWindowTokens:windowFor(binding.model),
        // At most 16KB of peer text can double in JSON escaping; reserve that expansion too.
        inputTokens:Buffer.byteLength(init.body),outputTokens:Math.max(...caps),overheadTokens:17024}:{state:"unknown",source:"native_estimate"};
      if(!valid())throw new Error("Native source ended");
      const boundaryId=randomUUID(),batch=await checkpoint("/peer-context",{boundaryId,nativeSessionId:root,budget,inputEvidence:binding.inputEvidence});
      if(!valid()||!await own(root,init.signal)||batch.boundaryId!==boundaryId||batch.nativeSessionId!==root||!Array.isArray(batch.messages)
        ||batch.messages.length>8||batch.messages.some(item=>typeof item.messageId!=="string"||typeof item.content!=="string"))throw new Error("Native context unconfirmed");
      if(batch.messages.length){
        // Final request copy only: native messages and authenticated transport stay owned by OpenCode.
        request.messages.push(...batch.messages.map(item=>({role:"user",content:item.content})));
        changed=JSON.stringify(request);observation={boundaryId,nativeSessionId:root,messageIds:batch.messages.map(item=>item.messageId),evidence:binding.inputEvidence};
      }
    }catch{/* Optional receive never retries or replaces the original provider operation. */}
    if(changed&&!ended&&!init?.signal?.aborted){
      let authorized=false;
      try{
        // A custom fetch may rewrite the body; it retains only the original hook ceiling.
        if(observation.evidence==="context_hook")await checkpoint("/peer-context/observe",observation);
        if(valid()&&await own(root,init.signal)){
          await checkpoint("/peer-context/authorize",observation);
          authorized=valid();
        }
      }catch{/* A denied batch must not enter the provider request. */}
      if(!authorized)return next(target,clean);
      // Invoke the selected transport exactly once before claiming native submission.
      const response=Promise.resolve(next(target,{...clean,body:changed}));
      void response.catch(()=>{});
      if(observation.evidence==="provider_payload"){
        try{await checkpoint("/peer-context/observe",observation);}catch{/* Submitted input stays unconfirmed; never retry the provider. */}
      }
      return response;
    }
    return next(target,clean);
  }
  let outgoing;
  if(capsule.coordination){
    const mcp=transport?.coordinate?undefined:new URL(capsule.mcp||"");
    if(mcp&&(mcp.protocol!=="http:"||mcp.hostname!=="127.0.0.1"||!mcp.port||mcp.pathname!=="/mcp"||mcp.username||mcp.password||mcp.search||mcp.hash||!/^[A-Za-z0-9_-]{43}$/.test(capsule.mcpToken||"")))throw new Error("Native coordination unavailable");
    let sequence=0;
    const rpc=(method,params,signal)=>new Promise((resolve,reject)=>{
      const id=++sequence,req=request(mcp,{method:"POST",agent:false,signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]),headers:{Authorization:"Bearer "+capsule.mcpToken,"Content-Type":"application/json",Accept:"application/json, text/event-stream"}},res=>{
        const chunks=[];let size=0;res.on("data",chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(new Error("Native result exceeds limit"));}else chunks.push(chunk);});
        res.on("error",reject);res.on("end",()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(res.statusCode!==200||value.id!==id||value.error||!value.result)throw new Error("Native result unconfirmed");resolve(value.result);}catch(error){reject(error);}});
      });req.on("error",reject);req.end(JSON.stringify({jsonrpc:"2.0",id,method,params}));
    });
    let description=transport?.description;
    if(mcp){
      await rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"phonon-opencode-current-turn",version:"1"}});
      const catalog=await rpc("tools/list",{}),selected=catalog.tools?.filter(tool=>tool.name==="phonon_project_coordination");
      if(selected?.length!==1||typeof selected[0].description!=="string"||selected[0].inputSchema?.type!=="object")throw new Error("Native coordination catalog unavailable");
      description=selected[0].description;
    }
    if(typeof description!=="string")throw new Error("Native coordination description unavailable");
    const require=createRequire(join(process.env.OPENCODE_CONFIG_DIR||join(process.env.XDG_CONFIG_HOME||join(homedir(),".config"),"opencode"),"package.json"));
    const {Effect}=await import(pathToFileURL(require.resolve("effect")).href);
    outgoing=await openCodeCoordinationTool(description,
      async function execute(args,context){
        const call=calls.get(context.callID);
        const valid=async()=>{
          if(context.abort?.aborted||!await own(context.sessionID,context.abort)||realpathSync(context.directory)!==realpathSync(input.directory)
            ||context.messages?.findLast(message=>message.info?.role==="user")?.info?.id!==originalMessage||typeof context.messageID!=="string")return false;
          const message=(await input.client.session.message({path:{id:root,messageID:context.messageID},signal:context.abort}))?.data;
          const part=message?.parts?.find(part=>part.type==="tool"&&part.callID===context.callID&&part.tool==="phonon_project_coordination");
          return !ended&&!context.abort?.aborted&&message?.info?.sessionID===root&&message.info.id===context.messageID&&message.info.role==="assistant"
            &&message.info.parentID===originalMessage&&part?.sessionID===root&&part.messageID===context.messageID
            &&["pending","running"].includes(part.state?.status)&&canonical(part.state.input)===canonical(args);
        };
        if(!call||call.used||call.args!==canonical(args)||!await valid()||call.used||typeof context.ask!=="function")throw new Error("Native coordination source unavailable");
        call.used=true;
        const permission=context.ask({permission:"phonon_project_coordination",patterns:["*"],always:["*"],metadata:{operation:args.operation}});
        if(Effect.isEffect(permission))await Effect.runPromise(permission,{signal:context.abort});
        else if(permission&&typeof permission.then==="function"){
          let abort;
          try{await Promise.race([permission,new Promise((_,reject)=>{
            abort=()=>reject(new Error("Native permission source ended"));
            if(context.abort?.aborted)abort();else context.abort?.addEventListener("abort",abort,{once:true});
          })]);}finally{if(abort)context.abort?.removeEventListener("abort",abort);}
        }else throw new Error("Native permission API is unavailable");
        if(!await valid())throw new Error("Native coordination source ended");
        let value;
        try{value=transport?.coordinate?await transport.coordinate({nativeAssistantId:context.messageID,toolCallId:context.callID,action:args},context.abort)
          :await rpc("tools/call",{name:"phonon_project_coordination",arguments:args},context.abort);}
        catch{throw new Error("Native coordination outcome is unconfirmed; do not automatically retry. Reconcile the original request identity.");}
        if(!await valid()||value.isError||!Array.isArray(value.content)||value.content.some(part=>part.type!=="text"||typeof part.text!=="string"))throw new Error("Native coordination result unconfirmed; reconcile the original request identity");
        return value.content.map(part=>part.text).join("\n");
      });
  }
  return {
    ...(capsule.peer?{
      async config(config){
        for(const [providerID,provider]of Object.entries(config.provider??{})){
          if(provider.npm!=="@ai-sdk/openai-compatible")continue;
          const baseURL=provider.options?.baseURL;
          if(typeof baseURL!=="string"||!baseURL||baseURL.includes("\${"))continue;
          const prior=provider.options?.fetch,next=typeof prior==="function"?prior:globalThis.fetch.bind(globalThis);
          if(prior!==undefined&&typeof prior!=="function")continue;
          const wrapper=(target,init)=>withPeerRequest(providerID,baseURL,next,target,init);
          const exposed=transport?.bindProvider?transport.bindProvider(providerID,wrapper):wrapper;
          provider.options={...provider.options,fetch:exposed};
          wrappedProviders.set(providerID,exposed);
          providerEvidence.set(providerID,prior===undefined?"provider_payload":"context_hook");
        }
      },
      async "chat.headers"(event,output){
        if(ended||event.sessionID!==root||event.message?.id!==originalMessage||typeof rootAgent!=="string"||event.agent!==rootAgent||!await own(root)||nativeRequests.size>=256)return;
        const model=event.model;
        if(model?.api?.npm!=="@ai-sdk/openai-compatible"||!wrappedProviders.has(model.providerID)||typeof model.api.id!=="string"
          ||event.provider?.options?.fetch!==wrappedProviders.get(model.providerID))return;
        const key=randomUUID();nativeRequests.set(key,{providerID:model.providerID,model,modelKey:modelKey(model),messageID:originalMessage,inputEvidence:providerEvidence.get(model.providerID)});
        output.headers[markerHeader]=key;
      },
    }:{}),
    ...(outgoing?{tool:{phonon_project_coordination:outgoing},async "tool.execute.before"(event,output){
      if(event.tool!=="phonon_project_coordination")return;
      if(!await own(event.sessionID)||typeof event.callID!=="string"||calls.has(event.callID)||calls.size>=128)throw new Error("Native coordination requires the original root call");
      calls.set(event.callID,{args:canonical(output.args),used:false});
    }}:{}),
    async "chat.message"(event, output) {
      const sid=event.sessionID;
      if(root&&sid===root&&output.message?.id!==originalMessage){ended=true;return;}
      if(ended || root || typeof sid!=="string" || !/^ses_[A-Za-z0-9]+$/.test(sid) || sid.length>512
        || expected && sid!==expected || output.message?.sessionID!==sid || output.message?.role!=="user") return;
      try {
        const value=await input.client.session.get({path:{id:sid}});
        const session=value?.data;
        if(ended || root || !session || session.id!==sid || session.parentID || session.directory!==input.directory) return;
        // Native run versions differ only in whether empty non-TTY stdin adds a newline.
        const prompt=output.parts?.filter(part=>part.type==="text").map(part=>part.text).join("\n");
        if(capsule.prompt&&prompt!==capsule.prompt&&prompt!==capsule.prompt+"\n")return;
        root=sid;originalMessage=output.message.id;rootAgent=output.message.agent;
        if(!transport)process.stderr.write("PHONON_OPENCODE_PEER_READY_"+nonce+":"+root+"\n");
      } catch { /* A missing native binding never authorizes a replacement session. */ }
    },
    async "experimental.chat.messages.transform"(){},
    async event({event}) {
      if(event.type==="session.idle" && event.properties?.sessionID===root
        || event.type==="session.deleted" && event.properties?.info?.id===root){ended=true;nativeRequests.clear();}
    },
  };
}
`;

export const OPENCODE_PHONON_SOURCE=OPENCODE_RECEIVE_RUNTIME+String.raw`
const capsule={url:process.env.AGENT_PHONON_PEER_CONTEXT_URL,token:process.env.AGENT_PHONON_PEER_CONTEXT_TOKEN,
  nonce:process.env.AGENT_PHONON_OPENCODE_NONCE,expected:process.env.AGENT_PHONON_OPENCODE_SESSION,
  coordination:process.env.AGENT_PHONON_OPENCODE_COORDINATION==="1",mcp:process.env.AGENT_PHONON_MCP_URL,mcpToken:process.env.AGENT_PHONON_INTERACTION_TOKEN,
  peer:process.env.AGENT_PHONON_OPENCODE_PEER!=="0",prompt:process.env.AGENT_PHONON_OPENCODE_PROMPT};
delete process.env.AGENT_PHONON_PEER_CONTEXT_URL;
delete process.env.AGENT_PHONON_PEER_CONTEXT_TOKEN;
delete process.env.AGENT_PHONON_COORDINATION_URL;
if(process.env.AGENT_PHONON_OPENCODE_OTHER_TOOLS!=="1"){
  delete process.env.AGENT_PHONON_MCP_URL;delete process.env.AGENT_PHONON_INTERACTION_TOKEN;delete process.env.AGENT_PHONON_INTERACTION_URL;
}
export default async function phonon(input) { return installOpenCodePeer(input,capsule); }
`;

export function prepareOpenCodePeerContext(options: SendOptions, expectedSession?: string,prompt?:string): {
  path: string; nonce: string; environment: Record<string, string>; cleanup: () => void;
} | undefined {
  if ((!options.peerContext&&!options.projectCoordination) || openCodePure(options.environment)) return undefined;
  const environment = options.environment ?? {};
  if(options.peerContext){const endpoint = new URL(environment.AGENT_PHONON_PEER_CONTEXT_URL ?? "");
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/peer-context"
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9_-]{43}$/.test(environment.AGENT_PHONON_PEER_CONTEXT_TOKEN ?? "")) throw new Error("OpenCode peer checkpoint requires an owned local capability");}
  if(options.projectCoordination)verifiedNativeToolChannel(environment);
  const original = environment.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}";
  const errors: ParseError[] = [];
  const config = parse(original, errors);
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)
    || config.plugin !== undefined && (!Array.isArray(config.plugin) || config.plugin.some((entry: unknown) => typeof entry !== "string"
      && !(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]))))) {
    throw new Error("OpenCode invocation configuration must be a valid object with a plugin list");
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "phonon-opencode-"))), path = join(directory, "phonon.mjs");
  const nonce = randomBytes(16).toString("hex");
  try {
    writeFileSync(path, OPENCODE_PHONON_SOURCE, { mode: 0o600, flag: "wx" });
    return { path, nonce, environment: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugin: [...config.plugin ?? [], pathToFileURL(path).href] }),
      AGENT_PHONON_OPENCODE_NONCE: nonce, AGENT_PHONON_OPENCODE_SESSION: expectedSession ?? "",
      AGENT_PHONON_OPENCODE_PEER:options.peerContext?"1":"0",AGENT_PHONON_OPENCODE_COORDINATION:options.projectCoordination?"1":"0",
      AGENT_PHONON_OPENCODE_PROMPT:prompt===undefined?"":formatOpenCodeRunPrompt(prompt),
      AGENT_PHONON_OPENCODE_OTHER_TOOLS:options.requestInteraction||options.conversationBoard||options.conversationWorkflow||options.conversationMessage||options.publishDocument?"1":"0",
    }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
