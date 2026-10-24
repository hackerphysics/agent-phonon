import { mkdtempSync, realpathSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { basename, dirname, delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { discoveryProbe } from "../discovery-probe.js";
import type { SendOptions } from "../adapter.js";
import {verifiedNativeToolChannel} from "../native-tool-channel.js";
import {createRequire} from "node:module";

export interface ClaudeSdkBinding { entry: string; sdk: string }

/** Use the SDK shipped with the owner-selected CLI, never one installed from a project. */
export async function qualifyClaudePeerContext(bin: string): Promise<ClaudeSdkBinding | undefined> {
  try {
    const candidate = isAbsolute(bin) ? bin : (process.env.PATH ?? "").split(delimiter).map(path => join(path, bin)).find(path => existsSync(path));
    if (!candidate) return undefined;
    const entry = realpathSync(candidate), sdk = join(dirname(entry), "sdk.mjs");
    if (basename(entry) !== "cli.js" || !statSync(sdk).isFile()) return undefined;
    const version = await discoveryProbe(bin, ["--version"]);
    if (!/^2\.0\.1(?:\s|$)/.test(version?.trim() ?? "")) return undefined;
    const result = await discoveryProbe(process.execPath, ["--input-type=module", "-e",
      "const sdk=await import(process.argv[1]);if(typeof sdk.query==='function'&&typeof sdk.createSdkMcpServer==='function')console.log('phonon_claude_hooks_v1');", pathToFileURL(sdk).href]);
    return result?.trim() === "phonon_claude_hooks_v1" ? {entry,sdk} : undefined;
  } catch { return undefined; }
}

export const CLAUDE_PEER_RUNNER_SOURCE = String.raw`
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, isAbsolute } from "node:path";
import { realpathSync, writeFileSync, readFileSync, readSync, statSync, lstatSync, openSync, fstatSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";

const coordinationName="mcp__phonon_current_turn__phonon_project_coordination";
const canonical=value=>JSON.stringify(value&&typeof value==="object"?Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
export function createCoordinationGuard({sessionId,cwd,active=()=>true,ready=()=>true,invoke}) {
  const tools=new Map();let submitted=false,closed=false;
  const own=input=>{try{return input.session_id===sessionId&&basename(input.transcript_path)===sessionId+".jsonl"&&realpathSync(input.cwd)===realpathSync(cwd);}catch{return false;}};
  const live=()=>!closed&&active()&&ready()&&submitted;
  return {
    submitted(){submitted=true;},
    record(message){
      if(closed||message.parent_tool_use_id||message.session_id!==sessionId||message.type!=="assistant")return;
      for(const block of message.message?.content??[])if(block.type==="tool_use"&&block.name===coordinationName&&typeof block.id==="string"){
        if(tools.has(block.id)||tools.size>=128){closed=true;return;}
        tools.set(block.id,{args:canonical(block.input),admitted:false,used:false});
      }
    },
    async pre(input,id,options){
      if(input.tool_name!==coordinationName)return {};
      await new Promise(resolve=>setImmediate(resolve));
      const tool=tools.get(id);
      if(!live()||!own(input)||options?.signal?.aborted||!tool||tool.used||tool.admitted||tool.args!==canonical(input.tool_input))
        return {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Phonon coordination requires the active original root tool call"}};
      tool.admitted=true;return {}; // Native tool permissions remain authoritative.
    },
    async call(params,extra){
      const id=extra?._meta?.["claudecode/toolUseId"],tool=tools.get(id);
      if(!live()||extra?.signal?.aborted||params.name!=="phonon_project_coordination"||!tool||!tool.admitted||tool.used||tool.args!==canonical(params.arguments))throw new Error("Native coordination source unavailable");
      tool.used=true;
      const result=await invoke(params.arguments,extra?.signal);
      if(!live()||extra?.signal?.aborted)throw new Error("Native coordination result unconfirmed");
      return result;
    },
    close(){closed=true;tools.clear();}
  };
}

// The SDK bundled with CLI 2.0.1 forces a mode; retain native config resolution.
export function prepareNativeStartup({entry,directory,parentPID=process.pid}) {
  const nonce=randomUUID(),preload=join(directory,"native-startup.mjs"),proof=join(directory,"native-startup.json");
  const source=[
    'import{realpathSync,writeFileSync}from"node:fs";import{fileURLToPath}from"node:url";',
    'if(process.ppid!=='+JSON.stringify(parentPID)+'||realpathSync(process.argv[1])!=='+JSON.stringify(entry)+')throw new Error("Unexpected native startup owner");',
    'const modes=process.argv.map((value,index)=>value==="--permission-mode"||value.startsWith("--permission-mode=")?index:-1).filter(index=>index>=0);',
    'if(modes.length!==1||process.argv[modes[0]]!=="--permission-mode"||process.argv[modes[0]+1]!=="default"||process.argv.includes("--dangerously-skip-permissions"))throw new Error("Unexpected SDK permission override");',
    'process.argv.splice(modes[0],2);',
    'const own=fileURLToPath(import.meta.url);for(let i=process.execArgv.length-2;i>=0;i--)if(process.execArgv[i]==="--import"&&(process.execArgv[i+1]===own||process.execArgv[i+1]===import.meta.url))process.execArgv.splice(i,2);',
    'writeFileSync('+JSON.stringify(proof)+',JSON.stringify({nonce:'+JSON.stringify(nonce)+',parentPID:process.ppid,pid:process.pid}),{mode:0o600,flag:"wx"});',
  ].join('\n');
  writeFileSync(preload,source,{mode:0o600,flag:"wx"});
  return {executableArgs:["--import",pathToFileURL(preload).href],confirmed(){
    try{const meta=statSync(proof);if(!meta.isFile()||meta.size>2048)return false;const value=JSON.parse(readFileSync(proof,"utf8"));
      return value.nonce===nonce&&value.parentPID===parentPID&&Number.isInteger(value.pid)&&value.pid>0;}catch{return false;}
  }};
}

const integer=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000000;
const unknownBudget=()=>({state:"unknown",source:"native_estimate"});
// CLI 2.0.1 has a 32K output default/cap but an environment-selected thinking budget.
export function claudeOutputReserve({cwd,settingsPath,environment=process.env,home=homedir(),platform=process.platform}) {
  let reserve=32000;
  const charge=value=>{
    if(value===undefined||value==="")return;
    if(typeof value!=="string"||!/^\d{1,9}$/.test(value))throw new Error("Unknown native thinking budget");
    const tokens=Number(value);if(!integer(tokens)||tokens>=1000000000)throw new Error("Unknown native thinking budget");
    reserve=Math.max(reserve,tokens+1);
  };
  try{
    charge(environment.MAX_THINKING_TOKENS);
    const files=new Set();
    if(settingsPath)files.add(settingsPath);
    else{
      files.add(join(environment.CLAUDE_CONFIG_DIR??join(home,".claude"),"settings.json"));
      let directory=realpathSync(cwd),depth=0;
      for(;;){
        files.add(join(directory,".claude","settings.json"));files.add(join(directory,".claude","settings.local.json"));
        const parent=dirname(directory);if(parent===directory)break;
        if(++depth>32)return;
        directory=parent;
      }
    }
    if(platform==="darwin")files.add("/Library/Application Support/ClaudeCode/managed-settings.json");
    else if(platform==="linux")files.add("/etc/claude-code/managed-settings.json");
    else return;
    for(const path of files){
      let stat;try{stat=lstatSync(path);}catch(error){if(error?.code==="ENOENT")continue;throw error;}
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>262144)return;
      const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw;
      try{const before=fstatSync(fd);if(before.ino!==stat.ino||before.dev!==stat.dev)return;
        const bytes=Buffer.alloc(262145),count=readSync(fd,bytes,0,bytes.length,0);
        if(count!==before.size||count>262144)return;
        raw=bytes.subarray(0,count).toString("utf8");const after=fstatSync(fd),current=lstatSync(path);
        if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||current.ino!==before.ino||current.dev!==before.dev)return;
      }finally{closeSync(fd);}
      const settings=raw.trim()?JSON.parse(raw):{};
      if(!settings||typeof settings!=="object"||Array.isArray(settings)||settings.env!==undefined&&(!settings.env||typeof settings.env!=="object"||Array.isArray(settings.env)))return;
      charge(settings.env?.MAX_THINKING_TOKENS);
    }
    return reserve;
  }catch{return;}
}

// Use the smaller qualified native window even when a 1M variant is selected.
export function createClaudePeerBudget({sessionId,outputReserve=()=>undefined}) {
  const initialOutput=outputReserve();
  let model,usage,trailingBytes=0,generation=0,largestOutput=initialOutput;
  const invalidate=()=>{usage=undefined;trailingBytes=0;generation++;};
  return {invalidate,generation:()=>generation,observe(message){
    if(message?.parent_tool_use_id||message?.session_id!==sessionId)return;
    if(message.type==="system"&&message.subtype==="init"){model=message.model;invalidate();return;}
    if(message.type==="system"&&message.subtype==="compact_boundary"){invalidate();return;}
    if(message.type==="assistant"){
      const native=message.message,value=native?.usage;
      invalidate();
      if(typeof model!=="string"||!/^claude-(?:sonnet|opus|haiku)-[a-z0-9.\[\]-]+$/.test(model)||native?.model!==model
        ||!value||![value.input_tokens,value.output_tokens,value.cache_creation_input_tokens,value.cache_read_input_tokens].every(integer))return;
      const total=value.input_tokens+value.output_tokens+value.cache_creation_input_tokens+value.cache_read_input_tokens;
      if(!integer(total))return;
      usage=total;
    }else if(usage!==undefined&&message.type==="user"){
      trailingBytes+=Buffer.byteLength(JSON.stringify(message));
    }
  },budget(toolResponse){
    if(usage===undefined||!integer(initialOutput)||initialOutput===0)return unknownBudget();
    const output=outputReserve();if(!integer(output)||output===0)return unknownBudget();
    largestOutput=Math.max(largestOutput,output);
    const inputTokens=usage+trailingBytes+Buffer.byteLength(JSON.stringify(toolResponse??null));
    if(!integer(inputTokens))return unknownBudget();
    return {state:"known",source:"native_estimate",contextWindowTokens:200000,inputTokens,outputTokens:largestOutput,overheadTokens:1024};
  }};
}

export function createPeerHooks({sessionId,cwd,prompt,checkpoint,rootTools,getBudget=()=>unknownBudget(),invalidateBudget=()=>{},budgetGeneration=()=>0,active=()=>true}) {
  let firstPrompt=true;
  let peerDebit=0,toolDebit=0,toolGeneration=-1,pending=false;
  const own = input => {
    try { return input.session_id===sessionId && basename(input.transcript_path)===sessionId+".jsonl"
      && realpathSync(input.cwd)===realpathSync(cwd); } catch { return false; }
  };
  async function deliver(input, toolUseId, options) {
    if(!active() || !own(input) || options?.signal?.aborted) return {};
    const submitted=input.hook_event_name==="UserPromptSubmit" && firstPrompt && typeof prompt==="string" && input.prompt===prompt;
    if(submitted){firstPrompt=false;invalidateBudget();}
    const initial=submitted || input.hook_event_name==="SessionStart" && ["startup","resume","compact"].includes(input.source);
    if(initial)invalidateBudget();
    if(!initial) {
      if(input.hook_event_name!=="PostToolUse" || typeof toolUseId!=="string") return {};
      // Let the native assistant event reach the iterator before checking its tool IDs.
      await new Promise(resolve=>setImmediate(resolve));
      if(!active() || !rootTools.delete(toolUseId)) return {};
    }
    const observedGeneration=budgetGeneration(),observedBudget=getBudget(input.tool_response);
    if(observedBudget.state==="known"&&toolGeneration!==observedGeneration){toolDebit=0;toolGeneration=observedGeneration;}
    const previousToolDebit=toolDebit,currentToolBytes=initial?0:Buffer.byteLength(JSON.stringify(input.tool_response??null));
    toolDebit+=currentToolBytes;
    if(pending)return {};
    pending=true;
    const boundaryId=randomUUID();
    try {
      const generation=observedGeneration,budget=observedBudget;
      if(budget.state==="known")budget.inputTokens+=peerDebit+previousToolDebit;
      const batch=await checkpoint("/peer-context",{boundaryId,nativeSessionId:sessionId,budget},options?.signal);
      if(!active() || options?.signal?.aborted || generation!==budgetGeneration() || batch.boundaryId!==boundaryId || batch.nativeSessionId!==sessionId || !Array.isArray(batch.messages)
        || batch.messages.length>8 || batch.messages.some(item=>typeof item.messageId!=="string" || typeof item.content!=="string")) return {};
      if(!batch.messages.length) return {};
      const current=getBudget(input.tool_response);
      if(budget.state!=="known"||current.state!=="known"||current.contextWindowTokens<budget.contextWindowTokens||current.outputTokens>budget.outputTokens
        ||current.inputTokens+peerDebit+toolDebit-currentToolBytes>budget.inputTokens)return {};
      const additionalContext=batch.messages.map(item=>item.content).join("\n\n");
      if(Buffer.byteLength(additionalContext)>16000)return {};
      peerDebit+=Buffer.byteLength(additionalContext)+64*batch.messages.length;
      try { await checkpoint("/peer-context/observe",{boundaryId,nativeSessionId:sessionId,messageIds:batch.messages.map(item=>item.messageId),evidence:"context_hook"},options?.signal); }
      catch { /* A returned hook value is not a provider request or a consumption ACK. */ }
      if(!active() || options?.signal?.aborted || generation!==budgetGeneration()||toolDebit-currentToolBytes>previousToolDebit) return {};
      return {hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext}};
    } catch { return {}; }finally{pending=false;}
  }
  return {SessionStart:[{hooks:[deliver]}],UserPromptSubmit:[{hooks:[deliver]}],PostToolUse:[{hooks:[deliver]}],PreCompact:[{hooks:[async()=>{invalidateBudget();return {}; }]}]};
}

async function main() {
  const [sdkPath,entry,sessionId,typesPath]=process.argv.slice(2);
  const peerUrl=process.env.AGENT_PHONON_PEER_CONTEXT_URL,token=process.env.AGENT_PHONON_PEER_CONTEXT_TOKEN;
  const mcpUrl=process.env.AGENT_PHONON_MCP_URL,mcpToken=process.env.AGENT_PHONON_INTERACTION_TOKEN;
  let body="";for await(const chunk of process.stdin){body+=String(chunk);if(Buffer.byteLength(body)>8388608)throw new Error("Native input exceeds limit");}
  const frame=JSON.parse(body);
  for(const key of ["AGENT_PHONON_PEER_CONTEXT_URL","AGENT_PHONON_PEER_CONTEXT_TOKEN","AGENT_PHONON_COORDINATION_URL"])delete process.env[key];
  if(!frame.otherControllerTools)for(const key of ["AGENT_PHONON_MCP_URL","AGENT_PHONON_INTERACTION_TOKEN","AGENT_PHONON_INTERACTION_URL"])delete process.env[key];
  if(typeof frame.prompt!=="string" || typeof frame.model!=="string" || typeof frame.resume!=="boolean"
    || frame.settingsPath!==undefined&&(typeof frame.settingsPath!=="string"||!isAbsolute(frame.settingsPath))
    || !/^[a-f0-9-]{36}$/.test(sessionId||"")) throw new Error("Invalid native invocation");
  const local=(value,path)=>{const url=new URL(value||"");if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||url.pathname!==path||url.username||url.password||url.search||url.hash)throw new Error("Invalid native channel");return url;};
  const endpoint=frame.peerEnabled?local(peerUrl,"/peer-context"):undefined;
  if(frame.peerEnabled&&!/^[A-Za-z0-9_-]{43}$/.test(token||""))throw new Error("Invalid native checkpoint");
  const mcpEndpoint=frame.coordination?local(mcpUrl,"/mcp"):undefined;
  if(frame.coordination&&!/^[A-Za-z0-9_-]{43}$/.test(mcpToken||""))throw new Error("Invalid coordination channel");
  const controller=new AbortController();
  process.once("SIGTERM",()=>controller.abort());process.once("SIGINT",()=>controller.abort());
  const checkpoint=(path,input,signal)=>new Promise((resolve,reject)=>{
    const signals=[AbortSignal.timeout(1500),controller.signal];if(signal)signals.push(signal);
    const req=request(new URL(path,endpoint),{method:"POST",agent:false,signal:AbortSignal.any(signals),
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"}},res=>{
      const chunks=[];let size=0;
      res.on("data",chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(new Error("Checkpoint too large"));}else chunks.push(chunk);});
      res.on("error",reject);res.on("end",()=>{try{if(res.statusCode!==200)throw new Error("Checkpoint denied");resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch(error){reject(error);}});
    });
    req.on("error",reject);req.end(JSON.stringify(input));
  });
  const rootTools=new Set(),sdk=await import(sdkPath);
  let active=true;
  const peerBudget=createClaudePeerBudget({sessionId,outputReserve:()=>claudeOutputReserve({cwd:process.cwd(),settingsPath:frame.settingsPath})});
  const startup=prepareNativeStartup({entry,directory:dirname(fileURLToPath(import.meta.url))});
  let startupRejected=false;
  const hooks=frame.peerEnabled?createPeerHooks({sessionId,cwd:process.cwd(),prompt:frame.prompt,checkpoint,rootTools,
    getBudget:peerBudget.budget,invalidateBudget:peerBudget.invalidate,budgetGeneration:peerBudget.generation,active:()=>active}):{};
  let guard,mcpServer,sequence=0;
  if(frame.coordination){
    const rpc=(method,params,signal)=>new Promise((resolve,reject)=>{
      const id=++sequence,req=request(mcpEndpoint,{method:"POST",agent:false,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000),...(signal?[signal]:[])]),
        headers:{Authorization:"Bearer "+mcpToken,"Content-Type":"application/json",Accept:"application/json, text/event-stream"}},res=>{
        const chunks=[];let size=0;res.on("data",chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(new Error("Native result exceeds limit"));}else chunks.push(chunk);});
        res.on("error",reject);res.on("end",()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(res.statusCode!==200||value.id!==id||value.error||!value.result)throw new Error("Native result unconfirmed");resolve(value.result);}catch(error){reject(error);}});
      });req.on("error",reject);req.end(JSON.stringify({jsonrpc:"2.0",id,method,params}));
    });
    await rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"phonon-claude-current-turn",version:"1"}});
    const catalog=await rpc("tools/list",{}),selected=catalog.tools?.filter(tool=>tool.name==="phonon_project_coordination");
    if(selected?.length!==1||selected[0].inputSchema?.type!=="object"||typeof selected[0].description!=="string")throw new Error("Native coordination catalog unavailable");
    guard=createCoordinationGuard({sessionId,cwd:process.cwd(),active:()=>active&&!controller.signal.aborted,ready:()=>startup.confirmed(),
      invoke:(args,signal)=>rpc("tools/call",{name:"phonon_project_coordination",arguments:args},signal)});
    hooks.PreToolUse=[{matcher:coordinationName,hooks:[guard.pre]}];
    const original=hooks.UserPromptSubmit?.[0]?.hooks?.[0];
    hooks.UserPromptSubmit=[{hooks:[async(input,id,options)=>{
      if(input.session_id===sessionId&&input.prompt===frame.prompt&&realpathSync(input.cwd)===realpathSync(process.cwd())&&basename(input.transcript_path)===sessionId+".jsonl")guard.submitted();
      return original?original(input,id,options):{};
    }]}];
    const {ListToolsRequestSchema,CallToolRequestSchema}=await import(typesPath);
    mcpServer=sdk.createSdkMcpServer({name:"phonon_current_turn",version:"1"});
    mcpServer.instance.server.registerCapabilities({tools:{}});
    mcpServer.instance.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:selected}));
    mcpServer.instance.server.setRequestHandler(CallToolRequestSchema,async(params,extra)=>{
      try{return await guard.call(params.params,extra);}catch{return {isError:true,content:[{type:"text",text:"Native coordination result unconfirmed. Reconcile the original request identity; never infer permission or completion."}]};}
    });
  }
  for(const matchers of Object.values(hooks))for(const matcher of matchers)matcher.hooks=matcher.hooks.map(callback=>async(...args)=>{
    if(!startup.confirmed()) {startupRejected=true;active=false;return {continue:false,stopReason:"Native startup policy could not be verified"};}
    return callback(...args);
  });
  const extraArgs={...(!frame.resume?{"session-id":sessionId}:{}),...(frame.settingsPath?{"setting-sources":"",settings:frame.settingsPath}:{})};
  const options={cwd:process.cwd(),env:{...process.env},executable:"node",pathToClaudeCodeExecutable:entry,
    executableArgs:startup.executableArgs,extraArgs,abortController:controller,hooks,
    ...(frame.model&&frame.model!=="default"?{model:frame.model}:{}),
    ...(frame.resume?{resume:sessionId}:{}),
    ...(mcpServer?{mcpServers:{phonon_current_turn:mcpServer}}:{}),
    stderr:text=>process.stderr.write(text)};
  let outcome;
  try { for await(const message of sdk.query({prompt:frame.prompt,options})) {
    if(message.parent_tool_use_id)continue;
    if(message.session_id!==sessionId) throw new Error("Native session changed");
    peerBudget.observe(message);
    guard?.record(message);
    if(message.type==="assistant" && !message.parent_tool_use_id) {
      for(const block of message.message?.content??[])if(block.type==="tool_use"&&typeof block.id==="string") {
        rootTools.add(block.id);
        if(rootTools.size>512)rootTools.delete(rootTools.values().next().value);
      }
    }
    if(message.type==="result"){outcome=message;active=false;}
    if(!process.stdout.write(JSON.stringify(message)+"\n")) await once(process.stdout,"drain");
  }}finally{active=false;guard?.close();await mcpServer?.instance.close();}
  if(startupRejected || !startup.confirmed() || !outcome || outcome.subtype!=="success" || outcome.is_error!==false || typeof outcome.result!=="string" || !outcome.result.trim())process.exitCode=1;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch { process.stderr.write("Claude native SDK execution is unconfirmed\n");process.exitCode=1; }
}
`;

export function prepareClaudePeerRunner(options: SendOptions, binding: ClaudeSdkBinding, input: {
  sessionId: string; prompt: string; model: string; resume: boolean; settingsPath?: string;
}): { args: string[]; stdin: string; cleanup: () => void } {
  if(options.peerContext){
    const endpoint = new URL(options.environment?.AGENT_PHONON_PEER_CONTEXT_URL ?? "");
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/peer-context"
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[A-Za-z0-9_-]{43}$/.test(options.environment?.AGENT_PHONON_PEER_CONTEXT_TOKEN ?? "")) throw new Error("Claude SDK requires an owned checkpoint");
  }
  if(options.projectCoordination)verifiedNativeToolChannel(options.environment??{});
  if(!options.peerContext&&!options.projectCoordination)throw new Error("Claude native capability unavailable");
  const directory = realpathSync(mkdtempSync(join(tmpdir(),"phonon-claude-"))), path = join(directory,"runtime.mjs");
  try {
    writeFileSync(path,CLAUDE_PEER_RUNNER_SOURCE,{mode:0o600,flag:"wx"});
    const types=options.projectCoordination?pathToFileURL(createRequire(import.meta.url).resolve("@modelcontextprotocol/sdk/types.js")).href:"";
    return {args:[path,pathToFileURL(binding.sdk).href,binding.entry,input.sessionId,types],stdin:JSON.stringify({prompt:input.prompt,model:input.model,resume:input.resume,peerEnabled:!!options.peerContext,coordination:!!options.projectCoordination,
      otherControllerTools:!!(options.requestInteraction||options.conversationBoard||options.conversationWorkflow||options.conversationMessage||options.publishDocument),...(input.settingsPath?{settingsPath:input.settingsPath}:{})}),
      cleanup:()=>rmSync(directory,{recursive:true,force:true})};
  } catch(error) {rmSync(directory,{recursive:true,force:true});throw error;}
}
