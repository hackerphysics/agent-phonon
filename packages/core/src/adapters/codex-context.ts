import {open, lstat, realpath,opendir} from "node:fs/promises";
import {constants} from "node:fs";
import {isAbsolute, relative,join} from "node:path";
import type {PeerContextBudget} from "../peer-context.js";
import type {z} from "zod";
import {isDeepStrictEqual} from "node:util";

export interface CodexContextObservation {contextWindow?:number;usedTokens?:number;peerBudget?:z.infer<typeof PeerContextBudget>;completedText?:string;toolCallVerified?:true}
const limit=1024*1024;
const integer=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;

export async function resolveCodexContextFile(home:string,threadID:string):Promise<string|undefined>{
  if(!/^[a-f0-9-]{36}$/i.test(threadID))return;
  try{
    const root=join(await realpath(home),"sessions"),pending=[{path:root,depth:0}];
    let inspected=0,winner:{path:string;mtime:number}|undefined;
    while(pending.length){
      const directory=pending.shift()!,info=await lstat(directory.path);if(!info.isDirectory()||info.isSymbolicLink())return;
      for await(const entry of await opendir(directory.path)){
        if(++inspected>10000)return;
        const file=join(directory.path,entry.name);
        if(entry.isDirectory()){
          if(directory.depth>=4||pending.length>=4096)return;
          pending.push({path:file,depth:directory.depth+1});
        }else if(entry.isFile()&&entry.name.endsWith('-'+threadID+'.jsonl')){
          const stat=await lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&(!winner||stat.mtimeMs>winner.mtime))winner={path:file,mtime:stat.mtimeMs};
        }
      }
    }
    return winner?.path;
  }catch{return;}
}

/** Last native inference observation, never cumulative billing usage or an estimate. */
export async function readCodexContext(file:string,identity:{home:string;cwd:string;threadID:string;model:string;notBefore?:number;turnID?:string;verifyCompletion?:boolean;
  verifyToolCall?:{callID:string;itemID:string;namespace:string;name:string;arguments:unknown}}):Promise<CodexContextObservation>{
  let handle;
  try{
    const root=await realpath(identity.home),actual=await realpath(file),scoped=relative(root,actual);
    if(isAbsolute(scoped)||scoped===".."||scoped.startsWith("../")||scoped.startsWith("..\\")||actual!==file)return {};
    const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)return {};
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=await handle.stat();if(before.ino!==info.ino||before.dev!==info.dev||before.size<1)return {};
    const head=Buffer.alloc(Math.min(65536,before.size));const headRead=await handle.read(head,0,head.length,0);
    const end=head.subarray(0,headRead.bytesRead).indexOf(10);if(end<0)return {};
    const meta=JSON.parse(head.subarray(0,end).toString("utf8"));
    if(meta.type!=="session_meta"||meta.payload?.id!==identity.threadID||await realpath(meta.payload?.cwd)!==await realpath(identity.cwd))return {};
    const start=Math.max(0,before.size-limit),bytes=Buffer.alloc(before.size-start);let count=0;
    while(count<bytes.length){const read=await handle.read(bytes,count,bytes.length-count,start+count);if(!read.bytesRead)return {};count+=read.bytesRead;}
    let body=bytes.toString("utf8");if(!body.endsWith("\n"))return {};if(start>0){const newline=body.indexOf("\n");if(newline<0)return {};body=body.slice(newline+1);}
    let model:string|undefined,turnID:string|undefined,observation:CodexContextObservation={},seenContext=false,trailingBytes=0;
    let nativeWindow:{turnID:string;window:number}|undefined;
    let completedText:string|undefined;
    let toolCallVerified=false;
    for(const line of body.split("\n").slice(0,-1)){
      if(!line.trim())continue;
      let row;try{row=JSON.parse(line);}catch{return {};}
      if(row.type==="event_msg"&&row.payload?.type==="task_started"){
        completedText=undefined;
        toolCallVerified=false;
        observation={};trailingBytes=0;seenContext=false;model=undefined;turnID=undefined;
        const value=row.payload;
        nativeWindow=typeof value.turn_id==="string"&&integer(value.model_context_window)&&value.model_context_window>0
          ?{turnID:value.turn_id,window:value.model_context_window}:undefined;
      }else if(row.type==="turn_context"){
        completedText=undefined;
        toolCallVerified=false;
        model=row.payload?.model;turnID=row.payload?.turn_id;seenContext=true;observation={};trailingBytes=0;
      }else if(row.type==="compacted"||row.type==="event_msg"&&row.payload?.type==="context_compacted"){
        completedText=undefined;
        toolCallVerified=false;
        observation={};trailingBytes=0;nativeWindow=undefined;
      }else if(identity.verifyToolCall&&row.type==="event_msg"&&["task_complete","turn_aborted","error"].includes(row.payload?.type)){
        toolCallVerified=false;seenContext=false;
      }else if(identity.verifyToolCall&&row.type==="response_item"&&row.payload?.call_id===identity.verifyToolCall.callID){
        const value=row.payload,expected=identity.verifyToolCall,at=Date.parse(row.timestamp);
        toolCallVerified=false;
        if(value.type==="function_call"&&value.id===expected.itemID&&value.name===expected.name&&value.namespace===expected.namespace
          &&value.internal_chat_message_metadata_passthrough?.turn_id===identity.turnID&&row.metadata?.client_authored===false
          &&seenContext&&model===identity.model&&turnID===identity.turnID&&Number.isFinite(at)&&(identity.notBefore===undefined||at>=identity.notBefore)){
          try{toolCallVerified=isDeepStrictEqual(JSON.parse(value.arguments),expected.arguments);}catch{/* Native malformed arguments do not prove a tool call. */}
        }
      }else if(identity.verifyCompletion&&row.type==="event_msg"&&["task_complete","turn_aborted","error"].includes(row.payload?.type)){
        completedText=undefined;const value=row.payload,at=Date.parse(row.timestamp);
        if(value.type==="task_complete"&&seenContext&&model===identity.model&&turnID===identity.turnID&&value.turn_id===turnID&&value.root_turn_id===turnID
          &&Number.isFinite(at)&&(identity.notBefore===undefined||at>=identity.notBefore)&&typeof value.last_agent_message==="string"
          &&value.last_agent_message.trim()&&Buffer.byteLength(value.last_agent_message)<=128000)completedText=value.last_agent_message;
      }else if(identity.turnID!==undefined&&row.type==="token_usage_record"){
        observation={};trailingBytes=0;const value=row.payload,usage=value?.usage,at=Date.parse(row.timestamp);
        if(!seenContext||model!==identity.model||turnID!==identity.turnID||value?.turn_id!==turnID
          ||value.thread_id!==identity.threadID||value.session_id!==identity.threadID
          ||!nativeWindow||nativeWindow.turnID!==turnID||!Number.isFinite(at)||identity.notBefore!==undefined&&at<identity.notBefore
          ||!usage||!integer(usage.input_tokens)||!integer(usage.output_tokens)||!integer(usage.total_tokens)
          ||usage.total_tokens!==usage.input_tokens+usage.output_tokens)continue;
        observation={contextWindow:nativeWindow.window,usedTokens:usage.total_tokens};
      }else if(row.type==="event_msg"&&row.payload?.type==="token_count"){
        observation={};trailingBytes=0;
        const info=row.payload.info,usage=info?.last_token_usage;
        if(!seenContext||model!==identity.model||identity.turnID!==undefined&&turnID!==identity.turnID||!usage||!integer(usage.total_tokens)||!integer(usage.input_tokens)||!integer(usage.output_tokens))continue;
        if(usage.total_tokens!==usage.input_tokens+usage.output_tokens)continue;
        const at=Date.parse(row.timestamp);if(!Number.isFinite(at)||identity.notBefore!==undefined&&at<identity.notBefore)continue;
        if(!integer(info.model_context_window)||info.model_context_window===0)continue;
        if(identity.turnID!==undefined&&(!nativeWindow||nativeWindow.turnID!==turnID))continue;
        observation={contextWindow:identity.turnID!==undefined?Math.min(info.model_context_window,nativeWindow!.window):info.model_context_window,usedTokens:usage.total_tokens};
      }else if(identity.turnID!==undefined&&observation.usedTokens!==undefined){
        // Includes tool outputs and native event framing since the last inference observation.
        trailingBytes+=Buffer.byteLength(line)+1;
      }
    }
    const after=await handle.stat(),current=await lstat(file);
    if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.ino!==current.ino||after.dev!==current.dev
      ||current.size!==after.size||current.mtimeMs!==after.mtimeMs||current.nlink!==1||current.isSymbolicLink())return {};
    if(identity.verifyCompletion)return completedText===undefined?{}:{completedText};
    if(identity.verifyToolCall)return toolCallVerified?{toolCallVerified:true}:{};
    if(identity.turnID!==undefined&&observation.contextWindow&&observation.usedTokens!==undefined){
      const inputTokens=observation.usedTokens+trailingBytes;
      if(inputTokens>1000000000||observation.contextWindow>1000000000)return {};
      return {...observation,peerBudget:{state:"known",source:"native_estimate",contextWindowTokens:observation.contextWindow,
        inputTokens,outputTokens:0,outputReservation:"native_usable_window",overheadTokens:17024}};
    }
    return observation;
  }catch{return {};}finally{await handle?.close();}
}
