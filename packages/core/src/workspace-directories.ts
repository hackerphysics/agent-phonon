import {readdir,realpath,lstat} from "node:fs/promises";
import {posix,win32,sep} from "node:path";
import {homedir} from "node:os";
import {directoryIdentity} from "./directory-identity.js";
import {PhononError} from "./rpc.js";
import type {PolicyEnforcer} from "./policy.js";
import type {ProjectManager} from "./project-manager.js";

export function directoryInputParts(input:string,root:string,home:string,style:"posix"|"windows"){
  if(input.length>4096||/[\x00-\x1f\x7f]/.test(input))throw new PhononError("errInvalidParams","invalid directory input");
  const path=style==="windows"?win32:posix;
  let value=input;
  if(!value)value=root+path.sep;
  else if(value==="~")value=home+path.sep;
  else if(/^~[\/\\]/.test(value))value=path.join(home,value.slice(2))+(value.endsWith("/")||value.endsWith("\\")?path.sep:"");
  if(!path.isAbsolute(value))throw new PhononError("errInvalidParams","directory input must be absolute");
  const trailing=style==="windows"?/[\\/]$/.test(value):value.endsWith("/");
  return {parent:trailing?path.resolve(value):path.dirname(value),prefix:trailing?"":path.basename(value),current:path.resolve(value)};
}

export async function workspaceDirectorySuggestions(input:string,limit:number,policy:PolicyEnforcer,projects:ProjectManager,current:()=>void){
  const style=process.platform==="win32"?"windows":"posix",parts=directoryInputParts(input,policy.workspaceRoot,homedir(),style);
  const access=(path:string)=>{current();policy.assertProjectDirectoryNavigation(path);return projects.directoryAccess(path);};
  const parent=await realpath(parts.parent);access(parent);const parentIdentity=directoryIdentity(parent);
  const observation=async(path:string)=>{
    const actual=await realpath(path),allowed=access(actual),identity=directoryIdentity(actual);
    return {path:actual,identity,selectable:allowed.selectable};
  };
  let match:Awaited<ReturnType<typeof observation>>|undefined;
  try{match=await observation(parts.current);}catch(error){
    if(!(error instanceof PhononError&&error.appCode==="errPolicyDenied")&&!["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))throw error;
  }
  const fold=(value:string)=>process.platform==="linux"?value:value.toLowerCase();
  const raw=(await readdir(parent,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&(!entry.name.startsWith(".")||parts.prefix.startsWith("."))&&fold(entry.name).startsWith(fold(parts.prefix)))
    .sort((a,b)=>a.name.localeCompare(b.name));
  const entries:Array<{name:string;path:string;realPath:string;kind:"directory";directoryIdentity:string;selectable:boolean}>=[];
  const checked=raw.slice(0,1000);
  for(const entry of checked){
    current();
    try{
      const candidate=await observation(parent+(parent.endsWith(sep)?"":sep)+entry.name);
      entries.push({name:entry.name,path:candidate.path,realPath:candidate.path,kind:"directory",directoryIdentity:candidate.identity,selectable:candidate.selectable});
      if(entries.length>limit)break;
    }catch(error){if(!(error instanceof PhononError&&error.appCode==="errPolicyDenied")&&!["ENOENT","ENOTDIR","EACCES","EPERM"].includes((error as NodeJS.ErrnoException).code??""))throw error;}
  }
  // Revalidate the traversed directory after asynchronous enumeration.
  access(parent);current();
  if(!(await lstat(parent)).isDirectory()||directoryIdentity(parent)!==parentIdentity)throw new PhononError("errPolicyDenied","directory changed during listing");
  const verified=entries.filter(entry=>{try{const latest=access(entry.realPath);entry.selectable=latest.selectable;return directoryIdentity(entry.realPath)===entry.directoryIdentity;}catch(error){if(error instanceof PhononError&&error.appCode==="errPolicyDenied"||["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))return false;throw error;}});
  if(match)try{if(directoryIdentity(match.path)!==match.identity)match=undefined;else match.selectable=access(match.path).selectable;}catch(error){if(error instanceof PhononError&&error.appCode==="errPolicyDenied"||["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))match=undefined;else throw error;}
  current();
  return {root:style==="windows"?win32.parse(parent).root:"/",rootPath:style==="windows"?win32.parse(parent).root:"/",path:parent,realPath:parent,
    input,pathStyle:style,entries:verified.slice(0,limit),truncated:entries.length>limit||raw.length>checked.length,...(match?{directoryMatch:{path:match.path,directoryIdentity:match.identity,selectable:match.selectable}}:{})};
}
