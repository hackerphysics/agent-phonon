import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { GatewayClient } from "../gateway-client.js";
import { PhononError } from "../rpc.js";

const text=z.string().min(1).max(512);
export const OpenClawNativeObservation=z.object({
  sessionKey:text,sessionId:z.string().uuid(),agent:text,cwd:z.string().min(1),model:text,
  createdAt:z.number().finite().positive(),messageCount:z.number().int().nonnegative(),leafId:text.nullable(),
}).strict();
export type OpenClawNativeObservation=z.infer<typeof OpenClawNativeObservation>;
export const OpenClawCheckpoint=z.object({
  version:z.literal(1),phononSessionId:text,gateway:text,model:text,native:OpenClawNativeObservation,
  pendingInject:z.array(z.string()).max(256),employeeId:z.string().optional(),
}).strict().refine(value=>value.native.messageCount>0&&value.native.leafId!==null);
export type OpenClawCheckpoint=z.infer<typeof OpenClawCheckpoint>;

export function recoveryGatewayIdentity(raw:string):string{
  const url=new URL(raw);
  if(!["ws:","wss:","http:","https:"].includes(url.protocol)||!["127.0.0.1","[::1]","localhost"].includes(url.hostname)
    ||url.username||url.password||url.search||url.hash)throw new PhononError("errCapabilityUnsupported","Native OpenClaw recovery requires a local Gateway");
  url.protocol=url.protocol.replace(/^http/,"ws");return url.href;
}

const historySchema=z.object({
  sessionKey:text,sessionId:z.string().uuid(),messages:z.array(z.unknown()).max(4),totalMessages:z.number().int().nonnegative(),
  pendingInputs:z.object({items:z.array(z.unknown()).max(0),total:z.literal(0)}),
  inFlightRun:z.undefined().optional(),
  sessionInfo:z.object({
    key:text,sessionId:z.string().uuid(),createdAt:z.number().finite().positive(),model:text,modelProvider:z.string().optional(),
    hasActiveRun:z.literal(false),activeRunIds:z.array(z.unknown()).max(0).optional(),hasActiveSubagentRun:z.literal(false).optional(),
    status:z.enum(["done","failed","killed","timeout","idle"]).optional(),endedAt:z.number().finite().positive().optional(),
    activeLeafEntryId:text.nullable(),archived:z.literal(false),restartRecoveryStatus:z.undefined().optional(),
    spawnedCwd:z.string().optional(),sessionRoot:z.string().optional(),execNode:z.undefined().optional(),
    placement:z.object({state:z.literal("local")}).optional(),placementMove:z.undefined().optional(),
  }),
});

export async function observeOpenClawSession(gw:GatewayClient,sessionKey:string,agent:string,cwd:string,model:string,allowEmpty=false):Promise<OpenClawNativeObservation>{
  try{
    if(!gw.supportsCapability("session-settings-cas-v1"))throw new Error("native identity admission is unavailable");
    const raw=await gw.rpc("chat.history",{sessionKey,agentId:agent,limit:4,offset:0,maxBytes:32768,maxChars:512},8000);
    if(Buffer.byteLength(JSON.stringify(raw))>262144)throw new Error("native observation exceeds its bound");
    const value=historySchema.parse(raw),row=value.sessionInfo;
    const path=row.spawnedCwd??row.sessionRoot;
    if(!path||!isAbsolute(path))throw new Error("native workspace is unreported");
    const nativeCwd=realpathSync(path);
    const nativeModel=row.modelProvider&&!row.model.startsWith(row.modelProvider+"/")?row.modelProvider+"/"+row.model:row.model;
    if(value.sessionKey!==sessionKey||row.key!==sessionKey||value.sessionId!==row.sessionId||nativeCwd!==realpathSync(cwd)||nativeModel!==model)throw new Error("native identity changed");
    if(value.totalMessages===0){if(!allowEmpty||row.activeLeafEntryId!==null||row.status!==undefined&&row.status!=="idle")throw new Error("native history missing");}
    else if(!row.activeLeafEntryId||!["done","failed","killed","timeout"].includes(row.status??"")||!row.endedAt)throw new Error("native work is not settled");
    return OpenClawNativeObservation.parse({sessionKey,sessionId:row.sessionId,agent,cwd:nativeCwd,model:nativeModel,createdAt:row.createdAt,messageCount:value.totalMessages,leafId:row.activeLeafEntryId});
  }catch{throw new PhononError("errSessionBusy","OpenClaw native Session identity or idle history could not be verified");}
}

export function sameOpenClawSession(saved:OpenClawNativeObservation,current:OpenClawNativeObservation,allowCompaction=false):boolean{
  return saved.sessionKey===current.sessionKey&&saved.sessionId===current.sessionId&&saved.agent===current.agent
    &&saved.cwd===current.cwd&&saved.model===current.model&&saved.createdAt===current.createdAt
    &&(allowCompaction||current.messageCount>=saved.messageCount);
}
