import type { ModelInfo } from "@agent-phonon/protocol";
import { DiscoveryRPC } from "../discovery-rpc.js";
import { reportedReasoningLevels } from "../reasoning.js";

export function parseCopilotNativeModels(value:unknown):ModelInfo[]{
  const records=(value as {models?:unknown})?.models;
  if(!Array.isArray(records)||records.length>2000)throw new Error("Invalid native Copilot model list");
  const seen=new Set<string>();
  return records.map(record=>{
    if(!record||typeof record.id!=="string"||!record.id||record.id.length>240||seen.has(record.id))throw new Error("Invalid native Copilot model identity");
    seen.add(record.id);
    const levels=record.capabilities?.supports?.reasoningEffort===true?reportedReasoningLevels(record.supportedReasoningEfforts):undefined;
    return {id:record.id,...(typeof record.name==="string"?{displayName:record.name}:{}),available:!record.policy||record.policy.state==="enabled",
      ...(levels?{reasoningLevels:levels}:{})};
  });
}

export async function discoverCopilotNativeModels(options:{bin:string;signal?:AbortSignal;env?:NodeJS.ProcessEnv;cwd?:string;onRuntime?:NonNullable<ConstructorParameters<typeof DiscoveryRPC>[2]>["onRuntime"]}):Promise<ModelInfo[]>{
  const channel=new DiscoveryRPC(options.bin,["--headless","--stdio","--no-auto-update","--no-remote","--log-level","none"],{...options,framing:"content-length"});
  try{
    await channel.request({method:"ping",params:{message:"phonon-metadata"}});
    return parseCopilotNativeModels(await channel.request({method:"models.list",params:{}}));
  }finally{await channel.close();}
}
