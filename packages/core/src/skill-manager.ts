import { mkdir, rm, readdir, lstat, realpath,open } from "node:fs/promises";
import { existsSync,constants } from "node:fs";
import { join, resolve, sep,dirname,basename,relative,isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PhononError } from "./rpc.js";
import { prepareSkillArchive, type PreparedSkillArchive } from "./skill-archive.js";
import { canonicalWorkspacePath,workspacePathKey } from "./workspace-paths.js";
import {NativeFileBroker,packagedNativeFileBroker,type NativeFileReceipt} from "./native-file-broker.js";
import {SkillSelection,SkillUnpublishResult,SkillDescriptor,type SkillPublishParams,type SkillUnpublishParams} from "@agent-phonon/protocol";
import {nativeTreeHash} from "./native-tree.js";
import {publishImmutableSkill,projectSkillTargetKey} from "./immutable-skills.js";
import {requestFingerprint} from "./idempotency.js";
import {SkillExecutionReceipt,FrozenSkillSet,SKILL_EXECUTION_LIMITS,skillVersion,skillText,formatSkillContext,type LoadedSkillSet} from "./skill-execution.js";
import type { AdapterRegistry } from "./session-engine.js";

/**
 * Skill 管理（design D24 + 安全边界规则）。
 *
 * 安装位置规则：
 *  - project scope → 装到 <project>/.agent/skills/<name>/ —— **runtime 无关**，谁用这个 project 都看得到
 *  - global scope  → **依赖 runtime**，装到对应 runtime 的全局 skill 目录
 *      （adapter.globalSkillDir(agentId) 提供；OpenClaw = 该 sub-agent workspace/skills）
 *
 * phonon 自己管一套安装逻辑；global 位置交给各 adapter（只有它知道自己 runtime skill 目录）。
 */

export interface SkillRecord {
  name: string;
  agent: string;
  scope: "global" | "project";
  projectId?: string;
  version?: string;
  hash?: string;
  installedPath: string;
  installedAt: string;
  revision?:string;
  publication?:{kind:"immutable";versionId:string;treeHash:string};
}

export interface SkillInstallHooks {
  beforeMutation:(resourceKey:string)=>string;
  commit:(record:SkillRecord,executionJson?:string)=>SkillRecord;
}
export interface SkillDirectoryRecord {name:string;scope:"global"|"project";agent?:string;projectId?:string;rootPath:string;path:string;exists:boolean;active?:boolean;publication?:SkillRecord["publication"]}
function mutationTargetKey(path:string):string{
  return createHash("sha256").update(workspacePathKey(canonicalWorkspacePath(path)).normalize("NFC").toLowerCase()).digest("hex");
}

type SkillSource =
  | { kind: "inline"; files: Record<string, string> }
  | { kind: "archive"; format: "tar.gz"; contentBase64: string; sha256?: string; sizeBytes?: number }
  | { kind: "localPath"; path: string }
  | { kind: "url"; url: string; sha256?: string };

export class SkillManager {
  private skills: SkillRecord[] = [];
  private registry: AdapterRegistry;
  /** projectId → 项目目录解析（core 注入）。 */
  private resolveProjectPath: (projectId: string) => string | undefined;
  private store?: import("./store.js").PhononStore;
  private readonly executionReceipts=new Map<string,SkillExecutionReceipt>();
  private readonly broker:NativeFileBroker;

  constructor(
    registry: AdapterRegistry,
    resolveProjectPath: (projectId: string) => string | undefined,
    store?: import("./store.js").PhononStore,
    private readonly options: {tenantId?:string;assertAgentAllowed?:(agent:string)=>void;assertActive?:()=>void;nativeFileBroker?:NativeFileBroker} = {},
  ) {
    this.registry = registry;
    this.resolveProjectPath = resolveProjectPath;
    this.store = store;
    this.broker=options.nativeFileBroker??packagedNativeFileBroker();
    if (this.store) for (const s of this.store.loadSkills(this.options.tenantId)) this.skills.push(s);
  }

  /** 计算安装目标目录（核心边界规则）。 */
  private targetDir(params: { agent: string; name: string; scope: "global" | "project"; projectId?: string }): string {
    // 防路径穿越（bug-bash#2 B8）：skill name 限定安全字符
    if (!/^[a-zA-Z0-9._-]+$/.test(params.name) || params.name === "." || params.name === "..") {
      throw new PhononError("errSkillScopeInvalid", `invalid skill name: ${params.name}`);
    }
    if (params.scope === "project") {
      if (!params.projectId) throw new PhononError("errSkillScopeInvalid", "project scope requires projectId");
      const projPath = this.resolveProjectPath(params.projectId);
      if (!projPath) throw new PhononError("errProjectNotFound", `project ${params.projectId} not found`);
      // project scope → <project>/.agent/skills/<name>，runtime 无关
      return join(projPath, ".agent", "skills", params.name);
    }
    // global scope → adapter 提供的 runtime skill 目录
    const adapter = this.registry.resolve(params.agent);
    if (!adapter) throw new PhononError("errAgentUnavailable", `agent ${params.agent} not found`);
    if (!adapter.globalSkillDir) throw new PhononError("errCapabilityUnsupported", `runtime does not support global skills`);
    const dir = adapter.globalSkillDir(params.agent);
    if (!dir) throw new PhononError("errCapabilityUnsupported", `no global skill dir for ${params.agent}`);
    return join(dir, params.name);
  }

  async install(params: {
    agent: string;
    name: string;
    scope: "global" | "project";
    projectId?: string;
    source: SkillSource;
    allowUrl?: boolean;
    hooks?:SkillInstallHooks;
  }): Promise<SkillRecord> {
    this.options.assertAgentAllowed?.(params.agent);
    let target = this.targetDir(params);
    const projectRoot=params.scope==="project"?await realpath(this.resolveProjectPath(params.projectId!)!):undefined;
    if(projectRoot){target=join(projectRoot,".agent","skills",params.name);await this.assertTarget(projectRoot,target,true);}
    if(params.scope==="global")await this.assertOwnedGlobalTarget(params,target,false);
    const brokerAvailable=await this.broker.available();
    let rootReceipt:NativeFileReceipt|undefined;
    if(brokerAvailable&&projectRoot)rootReceipt=await this.observeRoot(projectRoot);
    const archive=params.source.kind==="archive"?await prepareSkillArchive(params.source):undefined;
    if(archive){
      this.options.assertAgentAllowed?.(params.agent);
      if(canonicalWorkspacePath(this.targetDir(params))!==canonicalWorkspacePath(target)||projectRoot&&await realpath(this.resolveProjectPath(params.projectId!)!)!==projectRoot)
        throw new PhononError("errPolicyDenied","skill Project identity changed during archive preparation");
      if(projectRoot)await this.assertTarget(projectRoot,target,true);
      if(params.scope==="global")await this.assertOwnedGlobalTarget(params,target,false);
      await this.preflightArchive(archive,target,projectRoot??target);
    }
    if(params.source.kind==="inline")for(const rel of Object.keys(params.source.files)){
      const full=resolve(target,rel);
      if(full!==target&&!full.startsWith(target+sep))throw new PhononError("errSkillInstallFailed","inline file path escapes skill dir");
      await this.assertTarget(projectRoot??target,full,false);
    }
    this.options.assertActive?.();
    const resourceKey=mutationTargetKey(target),owner=params.hooks?.beforeMutation(resourceKey);
    this.store?.assertSkillTargetWritable(resourceKey,owner);
    await mkdir(target, { recursive: true });
    // realpath 归一化：与 skill.dirs 的 listDirs 保持一致（后者也 realpath）。
    // 不归一则 macOS 上 installedPath=/var/...、dirs.path=/private/var/...不一致。
    const dest = await realpath(target);
    if(brokerAvailable&&!rootReceipt)rootReceipt=await this.observeRoot(dest);

    let hash: string | undefined;
    const hasher = createHash("sha256");
    const entry:{data?:Buffer}={};

    if (params.source.kind === "inline") {
      // Validate every inline destination before writing any of the files.
      for(const rel of Object.keys(params.source.files)){
        const full=resolve(dest,rel);
        if(full!==dest&&!full.startsWith(dest+sep))throw new PhononError("errSkillInstallFailed","inline file path escapes skill dir");
        await this.assertTarget(projectRoot??dest,full,false);
      }
      for (const [rel, content] of Object.entries(params.source.files)) {
        const full = resolve(dest, rel);
        // 防路径穿越：写入目标必须在 dest 内（bug-bash#2 B8）
        if (full !== dest && !full.startsWith(dest + sep)) {
          throw new PhononError("errSkillInstallFailed", `inline file path escapes skill dir: ${rel}`);
        }
        await this.assertTarget(projectRoot??dest,full,false);
        await mkdir(join(full, ".."), { recursive: true });
        await this.writeSkillFile(projectRoot??dest,full,content);
        if(full===join(dest,"SKILL.md"))entry.data=Buffer.from(content);
        hasher.update(rel).update(content);
      }
      hash = hasher.digest("hex");
    } else if (archive) {
      await this.preflightArchive(archive,dest,projectRoot??dest);
      for(const path of archive.directories)await mkdir(join(dest,path),{recursive:true,mode:0o700});
      for(const file of archive.files)await this.writeSkillFile(projectRoot??dest,join(dest,file.path),file.data);
      entry.data=archive.files.find(file=>file.path==="SKILL.md")?.data;
      hash=archive.hash;
    } else if (params.source.kind === "localPath") {
      // 复制本地目录（用 cp -r 的等价：递归读写）
      await this.copyDir(params.source.path, dest, hasher,projectRoot??dest,entry);
      hash = hasher.digest("hex");
    } else {
      // url：受 policy 控制（P0-1 allowUrlSkillInstall），v0 默认拒
      if (!params.allowUrl)
        throw new PhononError("errPolicyDenied", "url skill install disabled by policy (allowUrlSkillInstall)");
      throw new PhononError("errSkillInstallFailed", "url install not implemented in v0");
    }

    let execution:SkillExecutionReceipt|undefined,version:string|undefined;
    if(rootReceipt&&entry.data){
      const root=projectRoot??dest,path=relative(root,join(dest,"SKILL.md")).split(sep).join("/");
      const actual=await this.readEntry(root,path,rootReceipt.rootIdentity);
      if(!actual.data.equals(entry.data))throw new PhononError("errSkillInstallFailed","skill entry was not confirmed against the supplied source");
      this.options.assertAgentAllowed?.(params.agent);
      if(projectRoot&&canonicalWorkspacePath(this.resolveProjectPath(params.projectId!)??"")!==projectRoot)throw new PhononError("errProjectNotFound","skill Project changed during installation");
      execution={schema:1,installationId:randomUUID(),rootIdentity:rootReceipt.rootIdentity,entryHash:createHash("sha256").update(actual.data).digest("hex")};
      version=skillVersion(actual.data);
    }
    let rec: SkillRecord = {
      name: params.name,
      agent: params.agent,
      scope: params.scope,
      projectId: params.scope==="project"?params.projectId:undefined,
      hash,
      ...(version?{version}:{}),
      installedPath: dest,
      installedAt: new Date().toISOString(),
    };
    // 去重：同 agent+scope+name(+project) 覆盖
    this.options.assertActive?.();
    if(params.hooks)rec=params.hooks.commit(rec,execution?JSON.stringify(execution):undefined);
    else {this.store?.upsertSkill({...rec,tenantId:this.options.tenantId,...(execution?{executionJson:JSON.stringify(execution)}:{})});if(this.store&&this.options.tenantId)rec.revision=this.store.skillSelectionRevision(this.options.tenantId,rec.name,rec.scope,rec.projectId)!;}
    this.skills = this.skills.filter(
      (s) => !(s.agent === rec.agent && s.scope === rec.scope && s.name === rec.name && s.projectId === rec.projectId),
    );
    this.skills.push(rec);
    if(execution)this.executionReceipts.set(this.executionKey(rec),execution);else this.executionReceipts.delete(this.executionKey(rec));
    return rec;
  }

  async immutableAvailable():Promise<boolean>{
    if(!this.store?.supportsDurableSkillInstalls||!this.options.tenantId||!await this.broker.available())return false;
    const probe=await this.broker.call({operation:"probe"});return "extensions" in probe&&!!probe.extensions?.includes("publish_tree_v1")&&probe.extensions.includes("verify_tree_v1");
  }
  async publish(input:SkillPublishParams,hooks:SkillInstallHooks):Promise<SkillRecord>{
    this.options.assertAgentAllowed?.(input.agent);
    if(!await this.immutableAvailable()||!this.store||!this.options.tenantId)throw new PhononError("errCapabilityUnsupported","immutable skill runtime assets and persistent storage are required");
    return publishImmutableSkill(input,{tenant:this.options.tenantId,store:this.store,broker:this.broker,hooks,resolveProject:this.resolveProjectPath,
      assertCurrent:()=>{this.options.assertActive?.();this.options.assertAgentAllowed?.(input.agent);}});
  }
  unpublish(input:SkillUnpublishParams){
    this.options.assertActive?.();this.options.assertAgentAllowed?.(input.agent);
    const root=this.resolveProjectPath(input.projectId);
    if(!root||!this.store||!this.options.tenantId)throw new PhononError("errProjectNotFound");
    if(!this.store.hasLiveManagedSkillVersions(this.options.tenantId,input.projectId,input.name))throw new PhononError("errSkillNotFound");
    return SkillUnpublishResult.parse(this.store.unpublishSkill(this.options.tenantId,input,projectSkillTargetKey(root,input.name),requestFingerprint(input)));
  }

  async uninstall(params: { agent: string; name: string; scope: "global" | "project"; projectId?: string }): Promise<void> {
    this.options.assertAgentAllowed?.(params.agent);
    if(params.scope==="project"&&params.projectId&&this.options.tenantId&&this.store?.hasLiveManagedSkillVersions(this.options.tenantId,params.projectId,params.name))
      throw new PhononError("errCapabilityUnsupported","immutable skills require explicit revision-checked unpublish; version files are preserved");
    let dest = this.targetDir(params);
    if(params.scope==="project"){
      const root=await realpath(this.resolveProjectPath(params.projectId!)!);dest=join(root,".agent","skills",params.name);
      await this.assertTarget(root,dest,true);
    }
    if(params.scope==="global")await this.assertOwnedGlobalTarget(params,dest,true);
    this.options.assertActive?.();this.store?.assertSkillTargetWritable(mutationTargetKey(dest));
    if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
    this.skills = this.skills.filter(
      (s) => !(s.agent === params.agent && s.scope === params.scope && s.name === params.name && s.projectId === (params.scope==="project"?params.projectId:undefined)),
    );
    this.store?.deleteSkill({...params,tenantId:this.options.tenantId});
    this.executionReceipts.delete(this.executionKey(params));
  }

  list(filter?: { agent?: string; scope?: "global" | "project"; projectId?: string }): SkillRecord[] {
    if(filter?.agent)this.options.assertAgentAllowed?.(filter.agent);
    if(this.options.tenantId!==undefined&&filter?.projectId&&!this.resolveProjectPath(filter.projectId))throw new PhononError("errProjectNotFound","skill project not found");
    const records=this.store?this.store.loadSkills(this.options.tenantId):this.skills;
    return records.filter((s) => {
      if(this.options.tenantId!==undefined&&s.scope==="project"&&(!s.projectId||!this.resolveProjectPath(s.projectId)))return false;
      try{this.options.assertAgentAllowed?.(s.agent);}catch(error){if(error instanceof PhononError&&error.appCode==="errPolicyDenied"){if(!(s.scope==="project"&&s.publication))return false;}else throw error;}
      if (filter?.agent && s.agent !== filter.agent) return false;
      if (filter?.scope && s.scope !== filter.scope) return false;
      if (filter?.projectId && s.projectId !== filter.projectId) return false;
      return true;
    });
  }

  private executionKey(record:{agent:string;name:string;scope:string;projectId?:string}){return JSON.stringify([record.agent,record.scope,record.projectId??null,record.name]);}
  private executionReceipt(record:SkillRecord):SkillExecutionReceipt{
    const history=record.publication&&this.store&&this.options.tenantId?this.store.managedSkillVersion(this.options.tenantId,record.publication.versionId):undefined;
    if(record.publication&&(!history||history.revoked_at||history.project_id!==record.projectId||history.name!==record.name))throw new PhononError("errSkillScopeInvalid","immutable skill version is unavailable or revoked");
    const raw=history?.execution_json??(this.store&&this.options.tenantId?this.store.skillExecutionReceipt(this.options.tenantId,record):undefined);
    let value:unknown;try{value=raw?JSON.parse(raw):this.store?undefined:this.executionReceipts.get(this.executionKey(record));}catch{value=undefined;}
    const parsed=SkillExecutionReceipt.safeParse(value);
    if(!parsed.success)throw new PhononError("errSkillScopeInvalid","selected skill has no confirmed execution receipt; reinstall it with the current native file broker");
    if(parsed.data.schema===2&&(!record.publication||record.publication.versionId!==parsed.data.installationId||record.publication.treeHash!==parsed.data.tree.hash||nativeTreeHash(parsed.data.tree.entries)!==parsed.data.tree.hash))
      throw new PhononError("errSkillScopeInvalid","immutable skill manifest identity differs");
    return parsed.data;
  }
  private async observeRoot(root:string):Promise<NativeFileReceipt>{
    const result=await this.broker.call({operation:"root",root});
    if(!("data" in result)||result.kind!=="directory")throw new PhononError("errSkillScopeInvalid","skill root was not confirmed");
    return result;
  }
  private async readEntry(root:string,path:string,rootIdentity:string):Promise<NativeFileReceipt>{
    let result:Awaited<ReturnType<NativeFileBroker["call"]>>;
    try{result=await this.broker.call({operation:"read",root,path,expectedRootIdentity:rootIdentity,maxBytes:SKILL_EXECUTION_LIMITS.entryBytes});}
    catch{throw new PhononError("errSkillScopeInvalid","selected skill filesystem read was not confirmed");}
    if(!("data" in result)||result.kind!=="file"||result.truncated||BigInt(result.sizeBytes)!==BigInt(result.data.length))throw new PhononError("errSkillScopeInvalid","selected skill entry could not be read completely");
    skillText(result.data);return result;
  }
  prepareExecution(projectId:string,agent:string,selections:SkillSelection[]):FrozenSkillSet{
    this.options.assertAgentAllowed?.(agent);
    if(!this.options.tenantId||!this.resolveProjectPath(projectId))throw new PhononError("errProjectNotFound","skill execution Project not found");
    const requested=SkillSelection.array().min(1).max(SKILL_EXECUTION_LIMITS.selections).parse(selections),bindings:FrozenSkillSet["bindings"]=[];
    for(const item of requested){
      const choice:Exclude<SkillSelection,string>=typeof item==="string"?{name:item}:item;
      let candidates=choice.scope==="global"?[]:this.list({scope:"project",projectId}).filter(record=>record.name===choice.name);
      if(candidates.some(record=>record.publication)&&candidates.some(record=>!record.publication||record.publication.versionId!==candidates.find(item=>item.publication)!.publication!.versionId))
        throw new PhononError("errSkillScopeInvalid","Project skill has conflicting legacy and immutable selections");
      const exact=candidates.filter(record=>record.agent===agent);if(exact.length&&!candidates.some(record=>record.publication))candidates=exact;
      if(!candidates.length&&choice.scope!=="project")candidates=this.list({scope:"global",agent}).filter(record=>record.name===choice.name);
      if(!candidates.length)throw new PhononError("errSkillNotFound","selected skill is not installed in the current scope");
      candidates.sort((a,b)=>a.agent.localeCompare(b.agent));const record=candidates[0]!,receipt=this.executionReceipt(record);
      if(receipt.schema===1)this.store?.assertSkillTargetWritable(mutationTargetKey(record.installedPath));
      if(candidates.some(candidate=>candidate.hash!==record.hash||candidate.version!==record.version||candidate.installedPath!==record.installedPath
        ||this.executionReceipt(candidate).entryHash!==receipt.entryHash))throw new PhononError("errSkillScopeInvalid","selected Project skill has ambiguous runtime receipts");
      if(choice.version!==undefined&&choice.version!==record.version)throw new PhononError("errSkillNotFound","requested skill version is not installed");
      if(choice.revision!==undefined&&choice.revision!==record.revision||choice.installationId!==undefined&&choice.installationId!==receipt.installationId)
        throw new PhononError("errSkillRevisionChanged","selected skill differs from the requested installation");
      const frozen={name:record.name,scope:record.scope,installAgent:record.agent,projectId:record.projectId??null,version:record.version??null,
        sourceHash:record.hash!,installedAt:record.installedAt,installedPath:record.installedPath,installationId:receipt.installationId,rootIdentity:receipt.rootIdentity,entryHash:receipt.entryHash,force:choice.force!==false,
        ...(receipt.schema===2?{publication:{treeHash:receipt.tree.hash,treeIdentity:receipt.tree.identity,path:receipt.tree.path}}:{})};
      const binding=frozen;
      const prior=bindings.find(value=>value.name===binding.name&&value.scope===binding.scope);
      if(prior)prior.force||=binding.force;else bindings.push(binding);
    }
    return FrozenSkillSet.parse({schema:1,tenantId:this.options.tenantId,projectId,agent,bindings});
  }
  async loadExecution(projectId:string,agent:string,raw:FrozenSkillSet):Promise<LoadedSkillSet>{
    const selected=FrozenSkillSet.parse(raw);
    if(selected.tenantId!==this.options.tenantId||selected.projectId!==projectId||selected.agent!==agent)throw new PhononError("errSkillScopeInvalid","skill execution source differs from the admitted turn");
    const contents:Array<{path:string;baseDirectory:string;content:string}>=[];let total=0,treeBytes=0,treeEntries=0;
    const current=(binding:FrozenSkillSet["bindings"][number])=>{
      this.options.assertAgentAllowed?.(agent);
      if(!this.resolveProjectPath(projectId))throw new PhononError("errProjectNotFound","skill execution Project not found");
      let record:SkillRecord|undefined;
      if(binding.publication){
        const history=this.store?.managedSkillVersion(this.options.tenantId!,binding.installationId);
        if(!history||history.revoked_at||history.project_id!==projectId||history.name!==binding.name)throw new PhononError("errSkillScopeInvalid","admitted immutable skill version is unavailable");
        try{const parsed=SkillDescriptor.parse(JSON.parse(history.record_json));if(!parsed.installedPath||!parsed.installedAt)throw Error();record={...parsed,installedPath:parsed.installedPath,installedAt:parsed.installedAt};}catch{throw new PhononError("errSkillScopeInvalid","immutable skill record is invalid");}
      }else record=this.list({agent:binding.installAgent,scope:binding.scope,...(binding.scope==="project"?{projectId}:{})}).find(value=>value.name===binding.name);
      if(!record||record.agent!==binding.installAgent||record.name!==binding.name||record.scope!==binding.scope||(record.projectId??null)!==binding.projectId||record.hash!==binding.sourceHash||record.installedAt!==binding.installedAt||record.installedPath!==binding.installedPath||record.version!==(binding.version??undefined))throw new PhononError("errSkillScopeInvalid","selected skill installation changed after admission");
      const receipt=this.executionReceipt(record);
      if(receipt.schema===1)this.store?.assertSkillTargetWritable(mutationTargetKey(record.installedPath));
      if(receipt.installationId!==binding.installationId||receipt.entryHash!==binding.entryHash||receipt.rootIdentity!==binding.rootIdentity)throw new PhononError("errSkillScopeInvalid","selected skill receipt changed after admission");
      if(binding.publication&&(receipt.schema!==2||receipt.tree.hash!==binding.publication.treeHash||receipt.tree.identity!==binding.publication.treeIdentity||receipt.tree.path!==binding.publication.path))throw new PhononError("errSkillScopeInvalid","immutable tree binding changed");
      return record;
    };
    for(const binding of selected.bindings){
      const record=current(binding),receipt=this.executionReceipt(record);
      const target=receipt.schema===2?record.installedPath:canonicalWorkspacePath(this.targetDir(record));
      if(target!==record.installedPath)throw new PhononError("errSkillScopeInvalid","selected skill directory identity changed");
      if(record.scope==="global")await this.assertOwnedGlobalTarget(record,target,true);
      const root=record.scope==="project"?canonicalWorkspacePath(this.resolveProjectPath(projectId)!):target;
      if(receipt.schema===2){
        if(record.scope!=="project"||receipt.tree.path!==".agent/skill-versions/"+record.name+"/"+receipt.installationId||join(root,...receipt.tree.path.split("/"))!==target)throw new PhononError("errSkillScopeInvalid","immutable directory differs from its publication");
        this.store!.assertSkillProjectRoot(this.options.tenantId!,projectId,root,receipt.rootIdentity);
        treeBytes+=receipt.tree.entries.reduce((sum,item)=>sum+item.size,0);treeEntries+=receipt.tree.entries.length;
        if(treeBytes>128*1024*1024||treeEntries>8192)throw new PhononError("errSkillScopeInvalid","selected immutable tree verification exceeds its total budget");
        try{await this.broker.call({operation:"verify_tree",root,path:receipt.tree.path,expectedRootIdentity:receipt.rootIdentity,expectedTreeIdentity:receipt.tree.identity,tree:receipt.tree.entries});}
        catch{throw new PhononError("errSkillScopeInvalid","immutable skill tree verification failed");}current(binding);
      }
      const path=relative(root,join(target,"SKILL.md")).split(sep).join("/");
      const entry=await this.readEntry(root,path,binding.rootIdentity);current(binding);
      if(createHash("sha256").update(entry.data).digest("hex")!==binding.entryHash)throw new PhononError("errSkillScopeInvalid","selected skill content changed after confirmation");
      if((total+=entry.data.length)>SKILL_EXECUTION_LIMITS.totalBytes)throw new PhononError("errSkillScopeInvalid","selected skill context exceeds the total limit");
      contents.push({path:join(target,"SKILL.md"),baseDirectory:target,content:skillText(entry.data)});
    }
    for(const binding of selected.bindings){
      const record=current(binding),root=record.scope==="project"?canonicalWorkspacePath(this.resolveProjectPath(projectId)!):record.installedPath;
      if((await this.observeRoot(root)).rootIdentity!==binding.rootIdentity)throw new PhononError("errSkillScopeInvalid","selected skill root changed before dispatch");
    }
    for(const binding of selected.bindings)current(binding);
    return {names:[...new Set(selected.bindings.map(value=>value.name))],context:formatSkillContext(selected,contents),bindings:selected};
  }

  private async assertOwnedGlobalTarget(params:{agent:string;name:string},target:string,required:boolean){
    if(this.options.tenantId===undefined)return;
    const owned=this.list({agent:params.agent,scope:"global"}).find(record=>record.name===params.name);
    if(required&&!owned)throw new PhononError("errSkillNotFound","global skill is not recorded for this tenant");
    let current;try{current=await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(current&&(!owned||current.isSymbolicLink()||!current.isDirectory()))throw new PhononError("errPolicyDenied","global skill target is not owned by this tenant");
    if(owned){
      const actual=current?await realpath(target):join(await realpath(dirname(target)),basename(target));
      if(actual!==owned.installedPath)throw new PhononError("errPolicyDenied","global skill root identity changed");
    }
  }

  async dirs(filter?: { agent?: string; scope?: "global" | "project"; projectId?: string }): Promise<SkillDirectoryRecord[]> {
    if(filter?.agent)this.options.assertAgentAllowed?.(filter.agent);
    const rows:SkillDirectoryRecord[] = [];
    if (filter?.scope !== "project" && filter?.agent) {
      const adapter = this.registry.resolve(filter.agent);
      const root = adapter?.globalSkillDir?.(filter.agent);
      if (root) rows.push(...await this.listDirs(root, { scope: "global", agent: filter.agent },
        this.options.tenantId===undefined?undefined:new Map(this.list({agent:filter.agent,scope:"global"}).map(record=>[record.name,record.installedPath]))));
    }
    if (filter?.scope !== "global" && filter?.projectId) {
      const projPath = this.resolveProjectPath(filter.projectId);
      if (!projPath) throw new PhononError("errProjectNotFound", `project ${filter.projectId} not found`);
      const managed=this.list({scope:"project",projectId:filter.projectId}).filter(record=>record.publication),legacy=await this.listDirs(join(projPath, ".agent", "skills"), { scope: "project", projectId: filter.projectId });
      for(const row of legacy)if(managed.some(record=>record.name===row.name))row.active=false;
      rows.push(...legacy);
      for(const record of managed){
        const receipt=this.executionReceipt(record);if(receipt.schema!==2)throw new PhononError("errSkillScopeInvalid","immutable directory receipt is invalid");
        this.store!.assertSkillProjectRoot(this.options.tenantId!,filter.projectId,projPath,receipt.rootIdentity);
        let exists=true;try{const value=await this.broker.call({operation:"stat",root:projPath,path:receipt.tree.path,expectedRootIdentity:receipt.rootIdentity});if(!("data" in value)||value.kind!=="directory"||value.identity!==receipt.tree.identity)throw Error("tree identity changed");}
        catch(error){if((error as {code?:string}).code==="not_found")exists=false;else throw new PhononError("errSkillScopeInvalid","immutable skill directory is unconfirmed");}
        rows.push({name:record.name,scope:"project",projectId:filter.projectId,rootPath:join(projPath,".agent","skill-versions",record.name),path:record.installedPath,exists,active:true,publication:record.publication});
      }
    }
    return rows;
  }

  private async listDirs(root: string, base: { scope: "global" | "project"; agent?: string; projectId?: string },ownedPaths?:Map<string,string>): Promise<SkillDirectoryRecord[]> {
    const rootPath = existsSync(root) ? await realpath(root) : resolve(root);
    if (!existsSync(root)) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const rows:SkillDirectoryRecord[] = [];
    for (const e of entries) {
      if(ownedPaths&&!ownedPaths.has(e.name))continue;
      if (!e.isDirectory()) continue;
      const full = join(root, e.name);
      const path=await realpath(full);
      if(ownedPaths&&ownedPaths.get(e.name)!==path)throw new PhononError("errPolicyDenied","global skill root identity changed");
      rows.push({ name: e.name, ...base, rootPath, path, exists: true });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async preflightArchive(archive:PreparedSkillArchive,dest:string,boundary:string):Promise<void>{
    for(const path of archive.directories)await this.assertTarget(boundary,join(dest,path),true);
    for(const file of archive.files)await this.assertTarget(boundary,join(dest,file.path),false);
  }

  private async copyDir(src: string, dest: string, hasher: ReturnType<typeof createHash>,boundary:string,entry?:{data?:Buffer},prefix=""): Promise<void> {
    if (!existsSync(src)) throw new PhononError("errSkillNotFound", `source ${src} not found`);
    const entries = await readdir(src, { withFileTypes: true });
    for (const e of entries) {
      const s = join(src, e.name);
      const d = join(dest, e.name);
      const source=await lstat(s);
      if(source.isSymbolicLink()||!source.isDirectory()&&(!source.isFile()||source.nlink!==1))throw new PhononError("errSkillInstallFailed","skill source must contain ordinary files and directories");
      if (source.isDirectory()) {
        await this.assertTarget(boundary,d,true);
        await mkdir(d, { recursive: true });
        await this.copyDir(s, d, hasher,boundary,entry,join(prefix,e.name));
      } else {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(s);
        await this.writeSkillFile(boundary,d,content);
        if(entry&&join(prefix,e.name)==="SKILL.md")entry.data=content;
        hasher.update(e.name).update(content);
      }
    }
  }

  private async assertTarget(root:string,path:string,directory:boolean):Promise<void>{
    const rel=relative(root,path),parts=rel.split(sep).filter(Boolean);
    if(isAbsolute(rel)||rel===".."||rel.startsWith(".."+sep)||parts.some(part=>part.includes("\0")||part.includes(":")))throw new PhononError("errPolicyDenied","skill target escapes its root");
    let current=root;
    for(let n=0;n<parts.length;n++){
      current=join(current,parts[n]!);let value;
      try{value=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
      const folder=n<parts.length-1||directory;
      if(value.isSymbolicLink()||(folder?!value.isDirectory():!value.isFile()||value.nlink!==1))throw new PhononError("errPolicyDenied","skill target contains a link or special entry");
    }
  }

  private async writeSkillFile(root:string,path:string,data:string|Buffer):Promise<void>{
    this.options.assertActive?.();
    await this.assertTarget(root,path,false);
    const file=await open(path,constants.O_WRONLY|constants.O_CREAT|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0),0o600);
    try{
      const value=await file.stat();if(!value.isFile()||value.nlink!==1)throw new PhononError("errPolicyDenied","skill target is not an ordinary private file");
      this.options.assertActive?.();
      await file.truncate(0);await file.writeFile(data);
    }finally{await file.close();}
  }
}
