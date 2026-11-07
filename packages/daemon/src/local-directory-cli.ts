import {lstatSync,realpathSync} from "node:fs";
import {resolve,dirname,isAbsolute} from "node:path";
import {PhononStore,assertLocalOwnerPath,localDirectorySourceFingerprint} from "@agent-phonon/core";
import {DEFAULT_CONFIG_PATH,loadConfig} from "./config.js";

/** Local owner entry only. No imports, remote grants, config edits or bootstrap. */
export function runLocalDirectoryCommand(args:string[]):unknown{
  const option=(name:string)=>{const index=args.indexOf("--"+name);return index<0?undefined:args[index+1];};
  const action=args[0],configPath=resolve(option("config")??DEFAULT_CONFIG_PATH),selector=option("server");
  if(!["admit","revoke","list"].includes(action??"")||!selector)throw new Error("usage: agent-phonon directory admit|revoke|list [absolute-directory] --server <configured-url|index> [--config <path>]");
  assertLocalOwnerPath(configPath);
  const config=loadConfig(configPath);
  const matches=/^\d+$/.test(selector)?config.servers.filter((_,index)=>index===Number(selector)):config.servers.filter(server=>server.url===selector);
  if(matches.length!==1||!localDirectorySourceFingerprint(matches[0]!))throw new Error("select exactly one configured authenticated server with expectedTenantId on a protected transport");
  const source=matches[0]!;
  if(!config.dbPath||!isAbsolute(config.dbPath))throw new Error("absolute durable database path required");
  assertLocalOwnerPath(dirname(config.dbPath),true);
  const info=lstatSync(config.dbPath);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o022)!==0||realpathSync(config.dbPath)!==resolve(config.dbPath))throw new Error("existing database ownership is unconfirmed");
  const store=new PhononStore(config.dbPath);
  try{
    const admission=store.localDirectoryAdmissions();
    if(action==="list")return admission.list(source);
    const path=args[1];if(!path||path.startsWith("--")||resolve(path)!==path)throw new Error("select an exact canonical absolute directory");
    if(action==="admit"&&(configPath===path||configPath.startsWith(path+"/")))throw new Error("configuration storage cannot be admitted");
    if(action==="admit")return admission.admit(source,path,config.workspaceRoot,store);
    admission.revoke(source,path);return {path,revoked:true};
  }finally{store.close();}
}
