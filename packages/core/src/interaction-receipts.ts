import { createHash } from "node:crypto";
import { InteractionRequestParams, InteractionRequestResult, interactionRequestIdentity, type InteractionStatusResult } from "@agent-phonon/protocol";
import type { PhononStore } from "./store.js";
import { PhononError } from "./rpc.js";

export function interactionHash(value: unknown): string {
  const normalize=(item:unknown):unknown=>Array.isArray(item)?item.map(normalize):item&&typeof item==="object"
    ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,normalize(child)])):item;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export class InteractionReceipts {
  private active=new Map<string,Promise<InteractionRequestResult>>();
  constructor(private store:PhononStore,private tenant:string){}

  status(requestId:string):InteractionStatusResult {
    const row=this.store.interactionReceipt(this.tenant,requestId);
    if(!row)throw new PhononError("errInvalidParams","interaction not found");
    const params=JSON.parse(String(row.request_json));
    const workflow=params.workflowId?this.store.getWorkflow(params.workflowId,this.tenant):undefined;
    const state=row.state==="pending"&&!this.active.has(requestId)&&(!workflow||["paused","completed","failed","cancelled","timeout"].includes(String(workflow.status)))?"unknown":row.state;
    return {requestId,requestHash:String(row.request_hash),state:state as InteractionStatusResult["state"],
      ...(params.nativeRunId?{nativeRunId:params.nativeRunId}:{}),...(params.workflowId?{workflowId:params.workflowId}:{}),
      ...(params.devRunId?{devRunId:params.devRunId}:{}),
      ...(params.sessionId?{sessionId:params.sessionId}:{}),...(params.turnId?{turnId:params.turnId}:{}),
      ...(row.decision_hash?{decisionHash:String(row.decision_hash)}:{}),updatedAt:String(row.updated_at)};
  }

  async request(raw:unknown,send:(params:InteractionRequestParams)=>Promise<unknown>,cancel:(requestId:string,response:InteractionRequestResult)=>void,signal?:AbortSignal):Promise<InteractionRequestResult>{
    const params=InteractionRequestParams.parse(raw),id=params.requestId,hash=interactionHash(interactionRequestIdentity(params));
    if(Buffer.byteLength(JSON.stringify(params))>65536||params.form.fields.length>16)throw new PhononError("errInvalidParams","interaction form too large");
    if(!params.nativeRunId&&!params.devRunId)throw new PhononError("errInvalidParams","native interaction requires a run identity");
    if(signal?.aborted)throw new PhononError("errSessionBusy","interaction turn ended");
    this.store.beginInteraction(this.tenant,id,hash,JSON.stringify(params));
    const row=this.store.interactionReceipt(this.tenant,id)!;
    if(row.request_hash!==hash)throw new PhononError("errInvalidParams","interaction identity changed");
    if(row.response_json)return InteractionRequestResult.parse(JSON.parse(String(row.response_json)));
    const existing=this.active.get(id);if(existing)return existing;
    if(["cancelled","timeout","failed"].includes(String(row.state)))throw new PhononError("errInvalidParams","interaction already ended");
    this.store.updateInteraction(this.tenant,id,"pending");
    const work=(async()=>{
      const abort=()=>cancel(id,{requestId:id,action:"cancel"});
      let timer:ReturnType<typeof setTimeout>|undefined;
      signal?.addEventListener("abort",abort,{once:true});
      try{
        const response=send(params);
        if(params.timeoutSeconds)timer=setTimeout(()=>cancel(id,{requestId:id,action:"timeout"}),params.timeoutSeconds*1000);
        const received=InteractionRequestResult.parse(await response);
        if(received.requestId!==id)throw new PhononError("errInvalidParams","interaction response identity changed");
        const result:InteractionRequestResult=signal?.aborted?{requestId:id,action:"cancel"}:received;
        this.store.updateInteraction(this.tenant,id,result.action==="submit"?"delivered":result.action==="cancel"?"cancelled":"timeout",JSON.stringify(result),interactionHash(result));
        return result;
      }catch(error){this.store.updateInteraction(this.tenant,id,"unknown");throw error;}
      finally{if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);this.active.delete(id);}
    })();
    this.active.set(id,work);return work;
  }

  applied(requestId:string,decisionHash:string):void {
    const row=this.store.interactionReceipt(this.tenant,requestId);
    if(!row||row.decision_hash!==decisionHash||!["delivered","applied"].includes(String(row.state)))throw new PhononError("errInvalidParams","interaction application proof mismatch");
    this.store.updateInteraction(this.tenant,requestId,"applied");
  }
}
