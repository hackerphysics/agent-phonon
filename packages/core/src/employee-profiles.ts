import { createHash,randomUUID } from "node:crypto";
import { mkdir,lstat,open,realpath,readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join,relative,sep,isAbsolute } from "node:path";
import { EmployeeProfileApplyParams,type EmployeeProfileStatusResult } from "@agent-phonon/protocol";
import type { AdapterRegistry } from "./session-engine.js";
import type { EmployeeRuntimeBinding,EmployeeProfileTarget } from "./adapter.js";
import type { PhononStore } from "./store.js";
import type { PolicyEnforcer } from "./policy.js";
import type { ProjectManager } from "./project-manager.js";
import { PhononError } from "./rpc.js";
import { NativeFileBroker,NativeFileBrokerError,type NativeFileRequest } from "./native-file-broker.js";
import { workspacePathKey } from "./workspace-paths.js";

const shared=new WeakMap<PhononStore,{uses:Map<string,number>;writes:Map<string,Promise<EmployeeProfileStatusResult>>}>();
export const employeeHash=(value:unknown)=>{
  const normalize=(item:unknown):unknown=>Array.isArray(item)?item.map(normalize):item&&typeof item==="object"?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,normalize(value)])):item;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
};
export function employeeDocuments(input:EmployeeProfileApplyParams):Record<string,string>{
  return {"SOUL.md":`# ${input.name}\n\n${input.responsibility}\n\n${input.documents.soul}`,
    "AGENTS.md":input.documents.agents,"USER.md":input.documents.user,"TOOLS.md":input.documents.tools};
}
export class EmployeeProfiles {
  private shared:NonNullable<ReturnType<typeof shared.get>>;
  private closed=false;
  private nativeFiles?:NativeFileBroker;
  constructor(private tenant:string,private store:PhononStore,private registry:AdapterRegistry,private policy:PolicyEnforcer,private projects:ProjectManager,profileFileBrokerRoot?:string){
    if(process.platform==="win32"&&profileFileBrokerRoot)this.nativeFiles=new NativeFileBroker(profileFileBrokerRoot);
    let state=shared.get(store);if(!state){state={uses:new Map(),writes:new Map()};shared.set(store,state);}this.shared=state;
  }
  private key(id:string){return this.tenant+"\0"+id;}
  private profileKey(input:EmployeeProfileApplyParams){
    const binding=input.profileBinding;
    return this.key(binding?.kind==="employee"?binding.employeeId:binding?.kind==="harness"?"harness:"+input.agent:input.employeeId);
  }
  use(id:string):()=>void{
    const record=this.store.employeeProfile(this.tenant,id);
    if(!record)throw new PhononError("errInvalidParams","employee profile not found");
    const keys=[...new Set([this.key(id),this.profileKey(record.input)])];
    if(keys.some(key=>this.shared.writes.has(key)))throw new PhononError("errSessionBusy","employee profile is being applied");
    for(const key of keys)this.shared.uses.set(key,(this.shared.uses.get(key)??0)+1);let released=false;
    return ()=>{if(released)return;released=true;for(const key of keys){const count=(this.shared.uses.get(key)??1)-1;if(count)this.shared.uses.set(key,count);else this.shared.uses.delete(key);}};
  }
  async apply(raw:unknown):Promise<EmployeeProfileStatusResult>{
    this.policy.assertEmployeeProfiles();const input=EmployeeProfileApplyParams.parse(raw);
    if(input.profileBinding&&(input.documents.agents||input.documents.user||input.documents.tools))throw new PhononError("errInvalidParams","shared profile configuration is read-only");
    if(Buffer.byteLength(JSON.stringify(input))>512*1024)throw new PhononError("errInvalidParams","employee profile is too large");
    this.policy.assertAgentAllowed(input.agent);
    const available=(await this.registry.inventory.list()).some(item=>item.agentId===input.agent&&item.available&&item.models.some(model=>model.id===input.model&&model.available!==false));
    if(this.closed)throw new PhononError("errSessionBusy","employee runtime is closing");
    if(!available)throw new PhononError("errAgentUnavailable","employee base harness/model is unavailable");
    const key=this.key(input.employeeId),hash=employeeHash(input),previous=this.store.employeeProfile(this.tenant,input.employeeId);
    if(previous&&(previous.input.agent!==input.agent||previous.input.profileId!==input.profileId||employeeHash(previous.input.profileBinding??null)!==employeeHash(input.profileBinding??null)))throw new PhononError("errInvalidParams","employee runtime binding is immutable");
    if(previous&&(input.revision<previous.input.revision||input.revision===previous.input.revision&&hash!==previous.requestHash))throw new PhononError("errInvalidParams","employee profile revision conflict");
    const inFlight=this.shared.writes.get(key);if(inFlight){if(previous?.requestHash!==hash)throw new PhononError("errSessionBusy","another employee revision is being applied");return inFlight;}
    if(previous?.state==="ready"&&previous.requestHash===hash)return this.status(input.employeeId);
    if(this.shared.uses.has(key)||this.store.employeeBusy(this.tenant,input.employeeId))throw new PhononError("errSessionBusy","employee has an active or unrecovered Session");
    const adapter=this.registry.resolve(input.agent);if(!adapter?.provisionEmployee||!adapter.inspectEmployee)throw new PhononError("errCapabilityUnsupported","selected harness cannot provision employee profiles");
    const profileKey=this.profileKey(input);
    if(profileKey!==key&&this.shared.writes.has(profileKey))throw new PhononError("errSessionBusy","shared employee profile is being applied");
    if(input.profileBinding?.kind==="employee")this.profileSource(input);
    if(input.profileBinding?.kind==="harness"&&(!adapter.inspectHarnessProfile||input.agent.split(":")[1]?.startsWith("phn-")))throw new PhononError("errCapabilityUnsupported","managed profiles require an owned employee reference");
    // Reserve the shared profile during binding, so a concurrent owner update cannot race readback.
    const work=this.applyProfile(input,hash,previous).finally(()=>{this.shared.writes.delete(key);if(profileKey!==key)this.shared.writes.delete(profileKey);});
    this.shared.writes.set(key,work);if(profileKey!==key)this.shared.writes.set(profileKey,work);return work;
  }
  private profileSource(input:EmployeeProfileApplyParams){
    const binding=input.profileBinding;
    const source=binding?.kind==="employee"?this.store.employeeProfile(this.tenant,binding.employeeId):undefined;
    if(!source||binding?.kind!=="employee"||binding.employeeId===input.employeeId||source.input.profileBinding||source.input.agent!==input.agent||source.input.profileId!==input.profileId||source.state!=="ready")throw new PhononError("employee_profile_source_unavailable","shared profile must be an owned, ready profile on the same harness");
    return source;
  }
  private async inspectShared(input:EmployeeProfileApplyParams){
    if(input.profileBinding?.kind==="employee"){
      const source=this.profileSource(input),status=await this.status(source.input.employeeId);
      if(status.state!=="ready")throw new PhononError("employee_profile_source_unavailable");
      return {...await this.registry.resolve(input.agent)!.inspectEmployee!(this.target(source)),runtimeProfile:source.runtimeProfile};
    }
    return this.registry.resolve(input.agent)!.inspectHarnessProfile!(input.agent);
  }
  private async applyProfile(input:EmployeeProfileApplyParams,hash:string,previous?:Record<string,any>):Promise<EmployeeProfileStatusResult>{
    const adapter=this.registry.resolve(input.agent)!;
    const runtimeProfile=previous?.runtimeProfile??"phn-"+employeeHash([this.tenant,input.employeeId]).slice(0,40);
    let record=previous??{nonce:randomUUID(),workspace:{path:join(this.policy.workspaceRoot,".phonon-employees",employeeHash(this.tenant).slice(0,24),input.employeeId),name:input.name,employeeId:input.employeeId}};
    record={...record,runtimeProfile};
    record={...record,input,requestHash:hash,state:"provisioning",errorCode:undefined};this.store.saveEmployeeProfile(this.tenant,input.employeeId,record);
    try{
      if(!record.workspace.projectId){
        const path=record.workspace.path;this.policy.assertProjectPath(path);
        if(process.platform==="win32")await this.prepareWindowsWorkspace(record);
        else{
        await mkdir(join(path,".."),{recursive:true,mode:0o700});
        let created=false;try{await mkdir(path,{mode:0o700});created=true;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
        const recoveringEmpty=!!previous&&!created&&(await lstat(path)).isDirectory()&&!(await lstat(path)).isSymbolicLink()&&!(await readdir(path)).length;
        if(created||recoveringEmpty){
          const marker=await open(join(path,".phonon-employee"),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
          try{await marker.writeFile(record.nonce);await marker.sync();}finally{await marker.close();}
        }
        }
        await this.checkWorkspace(record,false);
        const project=this.store.loadProjects().find(item=>item.namespace===this.tenant&&item.employeeId===input.employeeId)
          ??await this.projects.create({name:input.name,path,git:false,employeeId:input.employeeId});
        if(process.platform==="win32"?workspacePathKey(project.path)!==workspacePathKey(path):project.path!==path)throw new PhononError("employee_profile_identity_changed");
        record.workspace.projectId=project.projectId;this.store.saveEmployeeProfile(this.tenant,input.employeeId,record);
      }
      await this.checkWorkspace(record);
      const sharedObservation=input.profileBinding?await this.inspectShared(input):undefined;
      const observed=sharedObservation??await adapter.provisionEmployee!(this.target(record));
      if(sharedObservation)record.runtimeProfile=sharedObservation.runtimeProfile;
      else for(const[file,content]of Object.entries(employeeDocuments(input)))if(observed.documentHashes[file]!==createHash("sha256").update(content).digest("hex"))throw new PhononError("employee_profile_verification_failed","native profile readback differs from the requested documents");
      record={...record,state:"ready",observation:observed};this.store.saveEmployeeProfile(this.tenant,input.employeeId,record);
      return await this.status(input.employeeId);
    }catch(error){
      record={...record,state:"failed",errorCode:(error as {appCode?:string}).appCode??"employee_profile_apply_failed"};
      this.store.saveEmployeeProfile(this.tenant,input.employeeId,record);return this.view(record);
    }
  }
  private target(record:Record<string,any>):EmployeeProfileTarget{return {input:record.input,runtimeProfile:record.runtimeProfile,workspace:record.workspace.path,nonce:record.nonce,previousHashes:record.observation?.documentHashes,workspaceIdentity:record.workspaceIdentity,previousNativeIdentity:record.observation?.nativeIdentity};}
  private async nativeFile(request:NativeFileRequest){
    if(!this.nativeFiles)throw new PhononError("employee_profile_platform_unsupported","Windows employee workspaces require prepared native file assets");
    try{const value=await this.nativeFiles.call(request);if(!("data" in value))throw new PhononError("employee_profile_native_failure");return value;}
    catch(error){if(error instanceof NativeFileBrokerError){if(error.code==="not_found")throw error;throw new PhononError(error.code==="path_changed"?"employee_profile_identity_changed":["path_denied","exists"].includes(error.code)?"employee_profile_owner_conflict":"employee_profile_native_failure");}throw error;}
  }
  private async prepareWindowsWorkspace(record:Record<string,any>){
    const root=await this.nativeFile({operation:"root",root:this.policy.workspaceRoot});
    if(record.workspaceRootIdentity&&root.identity!==record.workspaceRootIdentity)throw new PhononError("employee_profile_identity_changed");
    const path=relative(this.policy.workspaceRoot,record.workspace.path);
    if(!path||isAbsolute(path)||path.split(sep).includes(".."))throw new PhononError("errPolicyDenied","employee workspace is outside the configured root");
    record.workspaceRootIdentity=root.identity;this.store.saveEmployeeProfile(this.tenant,record.input.employeeId,record);
    const made=await this.nativeFile({operation:"mkdir",root:this.policy.workspaceRoot,path:path.split(sep).join("/"),expectedRootIdentity:root.identity,createParents:true});
    if(record.workspaceIdentity&&made.identity!==record.workspaceIdentity)throw new PhononError("employee_profile_identity_changed");
    const known=record.workspaceIdentity===made.identity;record.workspaceIdentity=made.identity;
    this.store.saveEmployeeProfile(this.tenant,record.input.employeeId,record);
    try{
      const marker=await this.nativeFile({operation:"read",root:record.workspace.path,path:".phonon-employee",expectedRootIdentity:made.identity,maxBytes:257});
      if(marker.truncated||marker.data.length>256||marker.data.toString("utf8")!==record.nonce)throw new PhononError("employee_profile_owner_conflict");
    }catch(error){
      const missing=(error as {code?:string}).code==="not_found";
      if(!missing||!made.mutated&&!known)throw error;
      await this.nativeFile({operation:"write",root:record.workspace.path,path:".phonon-employee",expectedRootIdentity:made.identity,data:Buffer.from(record.nonce),overwrite:false});
    }
  }
  private async checkWorkspace(record:Record<string,any>,registered=true){
    this.policy.assertProjectPath(record.workspace.path);
    if(process.platform==="win32"){
      if(registered){const project=this.projects.get(record.workspace.projectId);if(project.employeeId!==record.input.employeeId||workspacePathKey(project.path)!==workspacePathKey(record.workspace.path))throw new PhononError("errPolicyDenied","employee project identity changed");}
      const root=await this.nativeFile({operation:"root",root:this.policy.workspaceRoot}),workspace=await this.nativeFile({operation:"root",root:record.workspace.path});
      if(record.workspaceRootIdentity&&root.identity!==record.workspaceRootIdentity||record.workspaceIdentity&&workspace.identity!==record.workspaceIdentity)throw new PhononError("employee_profile_identity_changed");
      const marker=await this.nativeFile({operation:"read",root:record.workspace.path,path:".phonon-employee",expectedRootIdentity:workspace.identity,maxBytes:257});
      if(marker.truncated||marker.data.length>256||marker.data.toString("utf8")!==record.nonce)throw new PhononError("employee_profile_owner_conflict");
      if(!record.workspaceRootIdentity||!record.workspaceIdentity){record.workspaceRootIdentity=root.identity;record.workspaceIdentity=workspace.identity;this.store.saveEmployeeProfile(this.tenant,record.input.employeeId,record);}
      return;
    }
    const metadata=await lstat(record.workspace.path);if(!metadata.isDirectory()||metadata.isSymbolicLink()||await realpath(record.workspace.path)!==record.workspace.path)throw new PhononError("errPolicyDenied","employee workspace identity changed");
    const marker=await open(join(record.workspace.path,".phonon-employee"),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await marker.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>256||await marker.readFile("utf8")!==record.nonce)throw new PhononError("errPolicyDenied","employee workspace ownership changed");}finally{await marker.close();}
    if(!registered)return;
    const project=this.projects.get(record.workspace.projectId);
    if(project.employeeId!==record.input.employeeId||project.path!==record.workspace.path)throw new PhononError("errPolicyDenied","employee project identity changed");
  }
  async status(id:string):Promise<EmployeeProfileStatusResult>{
    const record=this.store.employeeProfile(this.tenant,id);if(!record)throw new PhononError("errInvalidParams","employee profile not found");
    if(record.state!=="ready")return this.view(record);
    try{
      await this.checkWorkspace(record);const adapter=this.registry.resolve(record.input.agent);
      if(!adapter?.inspectEmployee)throw new Error("unsupported");
      const sharedObservation=record.input.profileBinding?await this.inspectShared(record.input):undefined;
      const observed=sharedObservation??await adapter.inspectEmployee(this.target(record));
      if(observed.home!==record.observation.home||sharedObservation&&sharedObservation.runtimeProfile!==record.runtimeProfile||!record.input.profileBinding&&JSON.stringify(observed.documentHashes)!==JSON.stringify(record.observation.documentHashes))throw new PhononError("employee_profile_local_changes","employee profile files changed outside the editor");
      if(record.observation.nativeIdentity&&observed.nativeIdentity!==record.observation.nativeIdentity)throw new PhononError("employee_profile_identity_changed","native employee profile directory changed");
      if(!record.observation.nativeIdentity&&observed.nativeIdentity)this.store.saveEmployeeProfile(this.tenant,id,{...record,observation:observed});
      return this.view({...record,observation:observed});
    }catch(error){return this.view({...record,state:"failed",errorCode:(error as {appCode?:string}).appCode??"employee_profile_unavailable"});}
  }
  private view(record:Record<string,any>):EmployeeProfileStatusResult{
    return {employeeId:record.input.employeeId,revision:record.input.revision,requestHash:record.requestHash,state:record.state,
      agent:record.input.agent,profileId:record.input.profileId,provider:this.registry.resolve(record.input.agent)?.name??"unknown",runtimeProfile:record.runtimeProfile,
      ...(record.workspace.projectId?{privateWorkspace:record.workspace}:{}),...(record.observation?{documentHashes:record.observation.documentHashes,memoryBytes:record.observation.memoryBytes}:{}),...(record.errorCode?{errorCode:record.errorCode}:{})};
  }
  async resolve(id:string,revision:number|undefined,agent:string):Promise<EmployeeRuntimeBinding>{
    const status=await this.status(id),record=this.store.employeeProfile(this.tenant,id)!;
    if(status.state!=="ready"||revision!==undefined&&status.revision!==revision||status.agent!==agent)throw new PhononError("errInvalidParams","employee profile is not ready at the selected revision");
    revision=status.revision;
    const documents=record.input.profileBinding?{"SOUL.md":employeeDocuments(record.input)["SOUL.md"]}:employeeDocuments(record.input);
    return {employeeId:id,revision,runtimeProfile:status.runtimeProfile,provider:status.provider,home:record.observation.home,
      context:[{role:"system",content:`Current employee identity revision ${revision}. This supersedes earlier identity configuration for this employee only. ${record.input.profileBinding?"Native profile settings and long-term memory are shared; do not overwrite them with this per-employee identity. ":""}Native long-term memory remains in ${record.observation.home}.\n\n`+Object.entries(documents).map(([file,body])=>`[${file}]\n${body}`).join("\n\n")} ]};
  }
  async dispose(){this.closed=true;await Promise.allSettled([...this.shared.writes].filter(([key])=>key.startsWith(this.tenant+"\0")).map(([,promise])=>promise));}
}
