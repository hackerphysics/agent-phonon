import {createHash,randomUUID} from "node:crypto";
import {join} from "node:path";
import type {SkillPublishParams} from "@agent-phonon/protocol";
import {prepareSkillArchive} from "./skill-archive.js";
import {nativeTreeManifest,nativeTreeHash,type NativeTreeEntry} from "./native-tree.js";
import {SkillExecutionReceipt,skillText,skillVersion} from "./skill-execution.js";
import {canonicalWorkspacePath,workspacePathKey} from "./workspace-paths.js";
import {PhononError} from "./rpc.js";
import type {NativeFileBroker,NativeFileReceipt} from "./native-file-broker.js";
import type {PhononStore} from "./store.js";
import type {SkillInstallHooks,SkillRecord} from "./skill-manager.js";

export function projectSkillTargetKey(root:string,name:string):string{return createHash("sha256").update(workspacePathKey(join(root,".agent","skills",name)).normalize("NFC").toLowerCase()).digest("hex");}
interface Context{tenant:string;store:PhononStore;broker:NativeFileBroker;hooks:SkillInstallHooks;resolveProject:(id:string)=>string|undefined;assertCurrent:()=>void}
function receipt(value:Awaited<ReturnType<NativeFileBroker["call"]>>):NativeFileReceipt{
  if(!("data" in value)||value.kind!=="directory"||value.truncated)throw new PhononError("errSkillInstallUnconfirmed","native tree acknowledgement is invalid");return value;
}
export async function publishImmutableSkill(input:SkillPublishParams,context:Context):Promise<SkillRecord>{
  const {tenant,store,broker,hooks}=context;
  const currentRoot=()=>{context.assertCurrent();const path=context.resolveProject(input.projectId);if(!path)throw new PhononError("errProjectNotFound");return canonicalWorkspacePath(path);};
  const root=currentRoot();
  if(store.skillSelectionRevision(tenant,input.name,"project",input.projectId)!==input.baseRevision)throw new PhononError("errSkillRevisionChanged","skill selection changed before preparation");
  const archive=input.source.kind==="archive"?await prepareSkillArchive(input.source):undefined;
  const data=new Map<string,Buffer>(),entries:unknown[]=[],directories=new Set<string>();
  if(archive){
    for(const directory of archive.directories)if(directory)directories.add(directory);
    for(const file of archive.files){data.set(file.path,file.data);entries.push({path:file.path,kind:"file",size:file.data.length,sha256:createHash("sha256").update(file.data).digest("hex"),executable:!!file.executable});}
  }else if(input.source.kind==="inline"){
    for(const [path,text]of Object.entries(input.source.files)){
      const bytes=Buffer.from(text);if(bytes.toString("utf8")!==text)throw new PhononError("errSkillInstallFailed","skill text contains invalid Unicode");
      data.set(path,bytes);entries.push({path,kind:"file",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),executable:false});
      const parts=path.split("/");parts.pop();while(parts.length){directories.add(parts.join("/"));parts.pop();}
    }
  }
  for(const path of directories)entries.push({path,kind:"directory",size:0});
  let manifest:NativeTreeEntry[];
  try{manifest=nativeTreeManifest(entries);}catch{throw new PhononError("errSkillInstallFailed","immutable skill plan is invalid or exceeds its bounds");}
  const entry=data.get("SKILL.md");if(!entry)throw new PhononError("errSkillInstallFailed","immutable skill requires an exact SKILL.md");skillText(entry);
  if(currentRoot()!==root)throw new PhononError("errSkillScopeInvalid","skill Project changed during preparation");
  const observed=receipt(await broker.call({operation:"root",root}));
  if(currentRoot()!==root)throw new PhononError("errSkillScopeInvalid","skill Project changed during root observation");
  store.pinSkillProjectRoot(tenant,input.projectId,root,observed.rootIdentity);
  if(store.skillSelectionRevision(tenant,input.name,"project",input.projectId)!==input.baseRevision)throw new PhononError("errSkillRevisionChanged","skill selection changed before publication");
  const owner=hooks.beforeMutation(projectSkillTargetKey(root,input.name));store.assertSkillTargetWritable(projectSkillTargetKey(root,input.name),owner);
  const versionId=randomUUID(),parent=".agent/skill-versions/"+input.name,path=parent+"/"+versionId,hash=nativeTreeHash(manifest);
  const published=receipt(await broker.call({operation:"publish_tree",root,path:parent,expectedRootIdentity:observed.rootIdentity,destinationName:versionId,createParents:true,tree:manifest,treeData:data}));
  if(!published.mutated||published.rootIdentity!==observed.rootIdentity)throw new PhononError("errSkillInstallUnconfirmed","immutable publication was not confirmed");
  if(currentRoot()!==root)throw new PhononError("errSkillScopeInvalid","skill Project changed before activation");store.assertSkillProjectRoot(tenant,input.projectId,root,observed.rootIdentity);
  const execution=SkillExecutionReceipt.parse({schema:2,installationId:versionId,rootIdentity:observed.rootIdentity,entryHash:createHash("sha256").update(entry).digest("hex"),
    tree:{path,identity:published.identity,hash,entries:manifest}});
  const version=skillVersion(entry),record:SkillRecord={agent:input.agent,name:input.name,scope:"project",projectId:input.projectId,installedPath:join(root,...path.split("/")),installedAt:new Date().toISOString(),
    hash:archive?.hash??hash,...(version?{version}:{}),publication:{kind:"immutable",versionId,treeHash:hash}};
  return hooks.commit(record,JSON.stringify(execution));
}
