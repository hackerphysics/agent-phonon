import {createHash} from "node:crypto";
import {join} from "node:path";
import type {ServerConfig} from "./config.js";
import {McpConfigurationError} from "./managed-mcp-security.js";

const sourcePattern=/^[a-f0-9]{64}$/;
export function validManagedMcpSource(value:unknown):value is string{return typeof value==="string"&&sourcePattern.test(value);}

/** Identity selector, not a credential or a caller-provided account assertion. */
export function managedMcpSourceFingerprint(server:ServerConfig):string|undefined{
  if(typeof server.deviceKey!=="string"||!server.deviceKey)return undefined;
  let url:URL;try{url=new URL(server.url);}catch{return undefined;}
  if(url.username||url.password||url.search||url.hash)return undefined;
  if(!["https:","wss:"].includes(url.protocol)&&!(["http:","ws:"].includes(url.protocol)&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))return undefined;
  return createHash("sha256").update(JSON.stringify(["phonon-managed-mcp-source-v2",server.url,server.deviceKey,server.expectedTenantId??null])).digest("hex");
}

export function managedMcpServerForSource(servers:ServerConfig[],url:string,source?:string):ServerConfig|undefined{
  if(source!==undefined&&!validManagedMcpSource(source))throw new McpConfigurationError("mcp_source_invalid");
  const found=servers.filter(server=>server.url===url&&(source===undefined||managedMcpSourceFingerprint(server)===source));
  if(found.length>1)throw new McpConfigurationError("mcp_source_ambiguous");
  return found[0];
}

export function managedMcpSourceStatePath(directory:string,source:string):string{
  if(!validManagedMcpSource(source))throw new McpConfigurationError("mcp_source_invalid");
  return join(directory,"source-v2-"+source+".json");
}

export function managedMcpEntryName(binding:string,source?:string):string{
  if(source!==undefined&&!validManagedMcpSource(source))throw new McpConfigurationError("mcp_source_invalid");
  const identity=source===undefined?binding.replaceAll("-",""):createHash("sha256").update(JSON.stringify(["phonon-managed-mcp-entry-v2",source,binding])).digest("hex").slice(0,32);
  return "phonon_managed_"+identity;
}

export function managedMcpSourceAllowed(server:ServerConfig|undefined,source:string):boolean{
  return server?.managedMcp?.allow===true&&server.managedMcp.sourceFingerprint===source&&managedMcpSourceFingerprint(server)===source;
}
