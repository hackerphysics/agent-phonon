import {lstatSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import {PhononError} from "./rpc.js";

export function directoryIdentity(path:string):string{
  const info=lstatSync(path,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink()||info.ino===0n||realpathSync(path)!==resolve(path))
    throw new PhononError("errPolicyDenied","directory identity could not be verified");
  return `dir:${info.dev.toString(16)}:${info.ino.toString(16)}`;
}
export function assertDirectoryIdentity(path:string,expected:string):void{
  if(directoryIdentity(path)!==expected)throw new PhononError("errPolicyDenied","directory identity changed");
}

/** Registered paths survive remounts and local replacement; operation-local pins stay strict. */
export function assertRegisteredDirectory(path:string):void{
  directoryIdentity(path);
}
