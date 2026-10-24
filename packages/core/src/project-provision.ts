import {existsSync,lstatSync,realpathSync} from "node:fs";
import {basename,join,resolve,relative,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {ProjectProvisionParams,ProjectProvisionStatusParams,ProjectProvisionStatusResult} from "@agent-phonon/protocol";
import {ProjectProvisionLedger,type ProvisionRecord} from "./project-provision-ledger.js";
import {NativeFileBroker,NativeFileBrokerError,packagedNativeFileBroker,type NativeFileReceipt} from "./native-file-broker.js";
import {PhononError} from "./rpc.js";
import {requestFingerprint} from "./idempotency.js";
import type {ProjectManager} from "./project-manager.js";
import type {PolicyEnforcer} from "./policy.js";
import {workspacePathKey} from "./workspace-paths.js";

function nodeIdentity(path:string){
  const st=lstatSync(path,{bigint:true});
  if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(path)!==resolve(path))throw new PhononError("errProjectProvisionChanged","workspace path is not the original directory");
  return `${st.dev.toString(16)}:${st.ino.toString(16)}`;
}
function receipt(raw:Awaited<ReturnType<NativeFileBroker["call"]>>):NativeFileReceipt{
  if(!("data" in raw)||raw.kind!=="directory")throw new PhononError("errProjectProvisionUnconfirmed");return raw;
}
export class ProjectProvisioner{
  private ledger?:ProjectProvisionLedger;private closed=false;private tasks=new Set<Promise<ProjectProvisionStatusResult>>();
  constructor(private tenant:string,private path:string|undefined,private policy:PolicyEnforcer,private projects:ProjectManager,private broker=packagedNativeFileBroker()){}
  private data(){
    if(this.closed)throw new PhononError("errProjectProvisionUnconfirmed","workspace controller closed");
    if(!this.path)throw new PhononError("errCapabilityUnsupported","workspace provisioning requires persistent storage");
    if(process.platform==="win32")throw new PhononError("errCapabilityUnsupported","workspace provisioning ledger ACL handling is not yet qualified on Windows");
    return this.ledger??=new ProjectProvisionLedger(this.path);
  }
  private current(method:"project.provision"|"project.provision.status"){
    if(this.closed)throw new PhononError("errProjectProvisionUnconfirmed","workspace controller closed");
    this.policy.assertProjectProvision();this.policy.assertMethodAllowed(method);this.policy.assertProjectPath(this.policy.workspaceRoot);
  }
  async capability(){
    if(this.closed||!this.path||process.platform==="win32"||!this.policy.policy.allowProjectProvision)return undefined;
    try{
      this.current("project.provision");const probe=await this.broker.call({operation:"probe",extendedProbe:true});
      if(!("extensions" in probe)||!probe.extensions?.includes("exclusive_mkdir_v1"))return undefined;
      this.current("project.provision");this.policy.assertMethodAllowed("project.provision.status");
      return this.data().receiver(this.tenant);
    }catch{return undefined;}
  }
  assertProject(id:string,path:string){
    const part=relative(this.policy.workspaceRoot,path).split(sep)[0]??"";
    const reserved=/^managed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(part);
    if(!this.path||!this.ledger&&!existsSync(this.path)){
      if(id.startsWith("managed-")||reserved)throw new PhononError("errProjectProvisionChanged","prepared workspace ledger unavailable");return;
    }
    const row=this.data().project(this.tenant,id)??this.data().overlapping(workspacePathKey(path));
    if(!row){if(id.startsWith("managed-")||reserved)throw new PhononError("errProjectProvisionChanged","prepared workspace record unavailable");return;}
    if(row.tenant!==this.tenant||row.project_id!==id||!["observed","confirmed"].includes(row.state)||row.path!==path||nodeIdentity(row.root)!==row.root_node_identity||nodeIdentity(path)!==row.node_identity)
      throw new PhononError("errProjectProvisionChanged","prepared workspace identity changed");
  }
  provision(raw:unknown){
    const task=this.perform(raw);this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;
  }
  private async verify(row:ProvisionRecord){
    this.current("project.provision.status");this.assertProject(row.project_id,row.path);
    if(row.root!==this.policy.workspaceRoot)throw new PhononError("errProjectProvisionChanged","configured workspace root differs from original preparation");
    const root=receipt(await this.broker.call({operation:"root",root:row.root}));
    if(root.identity!==row.root_identity)throw new PhononError("errProjectProvisionChanged","workspace root identity changed");
    const actual=receipt(await this.broker.call({operation:"stat",root:row.root,path:basename(row.path),expectedRootIdentity:row.root_identity}));
    if(actual.identity!==row.workspace_identity)throw new PhononError("errProjectProvisionChanged","prepared native workspace changed");
    this.current("project.provision.status");this.assertProject(row.project_id,row.path);
  }
  private async register(row:ProvisionRecord){
    await this.verify(row);
    if(row.state==="observed"){
      this.projects.registerPrepared({projectId:row.project_id,name:row.name,path:row.path,namespace:this.tenant,git:false,createdAt:row.created_at});
      this.data().confirm(row);row=this.data().get(this.tenant,row.request_id)!;
    }
    const project=this.projects.get(row.project_id);
    return ProjectProvisionStatusResult.parse({clientRequestId:row.request_id,receiverID:row.receiver_id,found:true,state:"confirmed",outcomeKnown:true,dispatchClaimed:true,project,rootIdentity:row.root_identity,workspaceIdentity:row.workspace_identity!});
  }
  private view(row:ProvisionRecord):ProjectProvisionStatusResult{
    const base={clientRequestId:row.request_id,receiverID:row.receiver_id,found:true as const};
    if(row.state==="failed")return {...base,state:"failed",outcomeKnown:true,dispatchClaimed:true,reasonCode:"creation_refused"};
    if(row.state==="prepared")return {...base,state:"prepared",outcomeKnown:false,dispatchClaimed:false};
    return {...base,state:row.state==="unknown"||row.state==="dispatched"?"unknown":"dispatched",outcomeKnown:false,dispatchClaimed:true};
  }
  private async perform(raw:unknown):Promise<ProjectProvisionStatusResult>{
    this.current("project.provision");this.policy.assertMethodAllowed("project.provision.status");const input=ProjectProvisionParams.parse(raw),db=this.data();
    if(db.receiver(this.tenant)!==input.expectedReceiverID)throw new PhononError("errProjectProvisionChanged","receiver identity changed");
    const fingerprint=requestFingerprint(input);let row=db.get(this.tenant,input.clientRequestId);
    if(row){
      if(row.request_hash!==fingerprint)throw new PhononError("errInvalidParams","workspace provision retry differs");
      if(row.state==="confirmed"||row.state==="observed")return this.register(row);
      if(row.state!=="prepared")return this.view(row);
    }
    if(!await this.capability())throw new PhononError("errCapabilityUnsupported","exclusive workspace helper unavailable");
    if(!row){
    const root=this.policy.workspaceRoot,rootNode=nodeIdentity(root),observed=receipt(await this.broker.call({operation:"root",root})),id="managed-"+randomUUID(),path=join(root,id);
    if(nodeIdentity(root)!==rootNode)throw new PhononError("errProjectProvisionChanged");
    this.projects.assertPreparedPathAvailable(path);this.current("project.provision");
    row=db.prepare({tenant:this.tenant,request_id:input.clientRequestId,request_hash:fingerprint,receiver_id:input.expectedReceiverID,name:input.name,project_id:id,
      root,root_identity:observed.identity,root_node_identity:rootNode,path,path_key:workspacePathKey(path),created_at:new Date().toISOString()});
    if(row.request_hash!==fingerprint)throw new PhononError("errInvalidParams");
    }
    if(row.root!==this.policy.workspaceRoot)throw new PhononError("errProjectProvisionChanged","configured workspace root differs from original preparation");
    const claim=randomUUID();if(!db.claim(row,claim))return this.view(db.get(this.tenant,row.request_id)!);
    row=db.get(this.tenant,row.request_id)!;
    try{
      this.current("project.provision");this.projects.reservePreparedPath(row.path);
      if(nodeIdentity(row.root)!==row.root_node_identity)throw new PhononError("errProjectProvisionChanged");
      const made=receipt(await this.broker.call({operation:"mkdir_new",root:row.root,path:basename(row.path),expectedRootIdentity:row.root_identity}));
      if(!made.mutated)throw new PhononError("errProjectProvisionUnconfirmed");
      const node=nodeIdentity(row.path),check=receipt(await this.broker.call({operation:"stat",root:row.root,path:basename(row.path),expectedRootIdentity:row.root_identity}));
      if(check.identity!==made.identity||nodeIdentity(row.path)!==node||nodeIdentity(row.root)!==row.root_node_identity)throw new PhononError("errProjectProvisionChanged");
      this.current("project.provision");db.observe(row,claim,made.identity,node);return this.register(db.get(this.tenant,row.request_id)!);
    }catch(error){
      db.settle(row,error instanceof NativeFileBrokerError&&!error.mutated&&["exists","path_denied","not_found","path_changed","unsupported","invalid_request"].includes(error.code)?"failed":"unknown");
      throw error;
    }
  }
  status(raw:unknown):Promise<ProjectProvisionStatusResult>{
    const task=this.readStatus(raw);this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task;
  }
  private async readStatus(raw:unknown):Promise<ProjectProvisionStatusResult>{
    this.current("project.provision.status");const input=ProjectProvisionStatusParams.parse(raw),db=this.data(),receiverID=db.receiver(this.tenant);
    if(receiverID!==input.expectedReceiverID)throw new PhononError("errProjectProvisionChanged");
    const row=db.get(this.tenant,input.clientRequestId);if(!row)return {clientRequestId:input.clientRequestId,receiverID,state:"not_found",found:false,outcomeKnown:false};
    return row.state==="confirmed"||row.state==="observed"?this.register(row):this.view(row);
  }
  async dispose(){this.closed=true;await Promise.allSettled([...this.tasks]);this.ledger?.close();}
}
