import type {ModelInfo} from "@agent-phonon/protocol";
import {reportedReasoningLevels} from "../reasoning.js";

export function parseOpenClawNativeModels(value:{models?:unknown}):ModelInfo[]{
  if(!Array.isArray(value.models)||value.models.length>2000)throw new Error("Invalid native OpenClaw model inventory");
  const models:ModelInfo[]=[],seen=new Set<string>();
  for(const row of value.models){
    if(!row||typeof row!=="object")throw new Error("Invalid native OpenClaw model record");
    const nativeId=typeof row.id==="string"?row.id:undefined,provider=typeof row.provider==="string"?row.provider:undefined;
    const id=typeof row.key==="string"?row.key:nativeId&&provider&&!nativeId.startsWith(provider+"/")?provider+"/"+nativeId:nativeId;
    if(!id||id.length>240)throw new Error("Invalid native OpenClaw model identity");
    if(seen.has(id))throw new Error("Duplicate native OpenClaw model identity");
    seen.add(id);
    if(row.available===false||row.missing===true)continue;
    const contextWindow=typeof row.contextWindow==="number"?row.contextWindow:typeof row.contextTokens==="number"?row.contextTokens:undefined;
    models.push({id,...(row.thinkingLevels?{reasoningLevels:reportedReasoningLevels(row.thinkingLevels)}:{}),
      ...(typeof row.name==="string"?{displayName:row.name}:{}),...(contextWindow&&contextWindow>0?{contextWindow}:{}),available:true});
  }
  return models;
}
