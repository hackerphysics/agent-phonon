import {realpathSync} from "node:fs";
import {resolve,dirname,basename,sep} from "node:path";
import {PhononError} from "./rpc.js";

export interface NamespacePath {path:string;namespace?:string;key?:string}

/** Resolve existing ancestors without discarding a not-yet-created suffix. */
export function canonicalWorkspacePath(path:string):string{
  let current=resolve(path);const suffix:string[]=[];
  for(;;){
    try{return resolve(realpathSync(current),...suffix);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      const parent=dirname(current);if(parent===current)throw error;suffix.unshift(basename(current));current=parent;}
  }
}

export function workspacePathKey(path:string):string{
  let key=resolve(path);
  // Conservatively protect case/normalization aliases on common desktop volumes.
  if(process.platform==="win32"||process.platform==="darwin")key=key.normalize("NFC").toLowerCase();
  return key;
}
export function workspacePathsOverlap(left:string,right:string):boolean{
  const prefix=(value:string)=>value.endsWith(sep)?value:value+sep;
  return left===right||left.startsWith(prefix(right))||right.startsWith(prefix(left));
}
export function assertNamespacePathAvailable(path:string,namespace:string,records:Iterable<NamespacePath>):void{
  const key=workspacePathKey(path);
  for(const record of records){
    if(record.namespace===namespace)continue;
    let other:string;
    try{other=record.key??workspacePathKey(canonicalWorkspacePath(record.path));}
    catch{throw new PhononError("errPolicyDenied","workspace path ownership could not be verified");}
    if(workspacePathsOverlap(key,other))throw new PhononError("errPolicyDenied","workspace path has a different or unresolved namespace owner");
  }
}
export function assertNamespaceBrowsePath(path:string,namespace:string,records:Iterable<NamespacePath>):void{
  const key=workspacePathKey(path);
  for(const record of records){
    if(record.namespace===namespace)continue;
    const other=record.key??workspacePathKey(canonicalWorkspacePath(record.path)),prefix=other.endsWith(sep)?other:other+sep;
    if(key===other||key.startsWith(prefix))throw new PhononError("errPolicyDenied","directory has a different or unresolved namespace owner");
  }
}

// Embedded managers also need isolation when no shared SQLite store was supplied.
const processOwners=new Map<string,NamespacePath>();
export function assertProcessPathAvailable(path:string,namespace:string):void{assertNamespacePathAvailable(path,namespace,processOwners.values());}
export function assertProcessBrowsePath(path:string,namespace:string):void{assertNamespaceBrowsePath(path,namespace,processOwners.values());}
export function rememberProcessPath(path:string,namespace:string):void{processOwners.set(workspacePathKey(path),{path,namespace,key:workspacePathKey(path)});}
