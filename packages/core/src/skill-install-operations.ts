import {randomUUID} from "node:crypto";
import {SkillInstallResult,SkillInstallStatusResult,type SkillInstallParams,type SkillInstallStatusParams,type SkillPublishParams} from "@agent-phonon/protocol";
import {PhononError} from "./rpc.js";
import {requestFingerprint} from "./idempotency.js";
import type {PhononStore,StoredSkillInstall} from "./store.js";
import type {SkillManager,SkillInstallHooks} from "./skill-manager.js";

/** Durable dispatch evidence, not an atomic filesystem publisher or a grant. */
export class SkillInstallOperations {
  private disposed=false;
  private tasks=new Set<Promise<SkillInstallResult>>();
  private owned=new Map<string,string>();
  constructor(private tenant:string,private store:PhononStore,private manager:SkillManager,private assertScope:(input:SkillInstallParams,method:"skill.install"|"skill.publish")=>void){}
  private activeKey(request:string,owner:string){return JSON.stringify([this.tenant,request,owner]);}
  private current(input:SkillInstallParams&{expectedReceiverID?:string},method:"skill.install"|"skill.publish"="skill.install"){
    if(this.disposed)throw new PhononError("errSkillInstallUnconfirmed","skill controller is no longer active");
    this.assertScope(input,method);
    if(input.expectedReceiverID!==undefined&&input.expectedReceiverID!==this.store.skillReceiverIdentity(this.tenant,false))
      throw new PhononError("errSkillInstallUnconfirmed","the current skill receiver differs from the prepared receiver");
  }
  private result(row:StoredSkillInstall):SkillInstallResult{
    try{
      const result=SkillInstallResult.parse(JSON.parse(row.result_json??"null")),skill=result.skill;
      if(skill.agent===row.agent_id&&skill.name===row.name&&skill.scope===row.scope&&(skill.projectId??null)===row.project_id)return result;
    }catch{}
    throw new PhononError("errSkillInstallUnconfirmed","the recorded installation result is unconfirmed");
  }
  install(input:SkillInstallParams):Promise<SkillInstallResult>{
    const task=this.perform(input);this.tasks.add(task);
    void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;
  }
  publish(input:SkillPublishParams):Promise<SkillInstallResult>{
    const task=this.perform(input,input);this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;
  }
  private async perform(input:SkillInstallParams,publication?:SkillPublishParams):Promise<SkillInstallResult>{
    const method=publication?"skill.publish":"skill.install";
    this.current(input,method);
    const request=input.clientRequestId;
    if(!request)return SkillInstallResult.parse({skill:await this.manager.install({...input,allowUrl:true})});
    this.store.assertSkillInstallUnfenced(this.tenant,request);
    const fingerprint=requestFingerprint(publication?{method,...publication}:input),row=this.store.prepareSkillInstall({tenant:this.tenant,requestId:request,requestHash:fingerprint,
      agent:input.agent,name:input.name,scope:input.scope,projectId:input.projectId});
    if(row.request_hash!==fingerprint)throw new PhononError("errInvalidParams","skill installation retry payload does not match its original identity");
    if(row.state==="confirmed")return this.result(row);
    if(row.state==="failed")throw new PhononError("errSkillInstallFailed","the original preparation failed without dispatch; inspect its status before a new request");
    if(row.state!=="prepared")throw new PhononError("errSkillInstallUnconfirmed","the original installation has been dispatched; do not replay it");
    const owner=randomUUID();
    try{
      const hooks:SkillInstallHooks={
        beforeMutation:resourceKey=>{
          this.current(input,method);
          let claimed=false;
          try{claimed=this.store.claimSkillInstall(this.tenant,request,fingerprint,resourceKey,owner);}catch{}
          if(!claimed)throw new PhononError("errSkillInstallUnconfirmed","skill installation dispatch was not claimed; another write may be active or unconfirmed");
          this.owned.set(request,owner);this.store.activeSkillInstalls.add(this.activeKey(request,owner));return owner;
        },
        commit:(record,executionJson)=>{
          this.current(input,method);SkillInstallResult.parse({skill:record});return this.store.confirmSkillInstall(this.tenant,request,owner,record,executionJson,publication?.baseRevision);
        },
      };
      const skill=publication?await this.manager.publish(publication,hooks):await this.manager.install({...input,allowUrl:true,hooks});
      return SkillInstallResult.parse({skill});
    }catch(error){
      const current=this.store.skillInstallOperation(this.tenant,request);
      if(current?.state==="confirmed")return this.result(current);
      if(this.owned.get(request)===owner)this.store.unconfirmSkillInstall(this.tenant,request,owner);
      else this.store.failSkillInstallPreparation(this.tenant,request,fingerprint);
      throw error;
    }finally{
      if(this.owned.get(request)===owner)this.owned.delete(request);
      this.store.activeSkillInstalls.delete(this.activeKey(request,owner));
    }
  }
  status(input:SkillInstallStatusParams):SkillInstallStatusResult{
    const row=this.store.skillInstallOperation(this.tenant,input.clientRequestId);
    if(!row||row.agent_id!==input.agent||row.name!==input.name||row.scope!==input.scope||row.project_id!==(input.projectId??null))
      return {clientRequestId:input.clientRequestId,state:"not_found",found:false,outcomeKnown:false};
    const receiverID=input.includeReceiverIdentity&&row.receiver_id&&row.receiver_id===this.store.skillReceiverIdentity(this.tenant,false)?row.receiver_id:undefined;
    const recovery=input.includeRecoveryContext?this.store.skillRecoveryContext(this.tenant,row):undefined;
    const identity={clientRequestId:row.request_id,createdAt:row.created_at,updatedAt:row.updated_at,found:true as const,...(receiverID?{receiverID}:{}),...(recovery?{recovery}:{})};
    if(row.state==="confirmed")return {...identity,state:"confirmed",outcomeKnown:true,dispatchClaimed:true,result:this.result(row)};
    if(row.state==="prepared")return {...identity,state:"prepared",outcomeKnown:false,dispatchClaimed:false};
    if(row.state==="failed")return {...identity,state:"failed",outcomeKnown:true,dispatchClaimed:false,reasonCode:"preparation_failed"};
    if(row.state==="dispatched"&&row.owner_id&&this.store.activeSkillInstalls.has(this.activeKey(row.request_id,row.owner_id)))
      return {...identity,state:"dispatched",outcomeKnown:false,dispatchClaimed:true};
    return {...identity,state:"unknown",outcomeKnown:false,dispatchClaimed:true,reasonCode:row.state==="unknown"?"write_outcome_unconfirmed":"controller_not_observed"};
  }
  async dispose():Promise<void>{
    this.disposed=true;
    for(const [request,owner] of this.owned){
      try{this.store.unconfirmSkillInstall(this.tenant,request,owner);}catch{}
      this.store.activeSkillInstalls.delete(this.activeKey(request,owner));
    }
    await Promise.allSettled([...this.tasks]);
  }
}
