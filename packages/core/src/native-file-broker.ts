import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {lstat,readFile,realpath} from "node:fs/promises";
import {join,resolve,relative,isAbsolute,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import {encodeNativeTree,type NativeTreeEntry} from "./native-tree.js";

const MAX_BYTES=20*1024*1024,MAX_REPLY=MAX_BYTES+4096;
export type NativeFileOperation="probe"|"read"|"write"|"mkdir"|"publish_new"|"stat"|"root"|"publish_tree"|"verify_tree"|"mkdir_new";
const operations:NativeFileOperation[]=["probe","read","write","mkdir","publish_new","stat","root","publish_tree","verify_tree","mkdir_new"];
const codes=["invalid_request","not_found","path_denied","path_changed","busy","exists","unsupported","io_error","transport_unconfirmed"] as const;
export class NativeFileBrokerError extends Error{
  constructor(public readonly code:typeof codes[number],public readonly mutated:boolean){super("native file operation "+code);this.name="NativeFileBrokerError";}
}
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema=z.object({schema:z.union([z.literal(1),z.literal(2)]),sourceSha256:hash,treeSha256:hash.optional(),cryptoSha256:hash.optional(),toolchain:z.object({zig:z.literal("0.13.0"),zigPackage:z.literal("@ryoppippi/zig-darwin-arm64@0.13.0")}).strict(),
  targets:z.record(z.object({file:z.string().min(1).max(128),sha256:hash,size:z.number().int().positive().max(4*1024*1024)}).strict())}).strict().refine(value=>value.schema===1||!!value.treeSha256&&!!value.cryptoSha256);
const identity=z.string().regex(/^[pw]:[a-f0-9]+:[a-f0-9]+$/).max(80);
const receiptSchema=z.object({ok:z.literal(true),kind:z.enum(["file","directory","symlink","other"]),rootIdentity:identity,identity,
  sizeBytes:z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/),dataBytes:z.number().int().min(0).max(MAX_BYTES),truncated:z.boolean(),mutated:z.boolean()}).strict();
const errorSchema=z.object({ok:z.literal(false),code:z.enum(codes),mutated:z.boolean()}).strict();
const probeSchema=z.object({ok:z.literal(true),version:z.literal(2),platform:z.enum(["darwin","linux","win32"]),operations:z.array(z.enum(["read","write","mkdir","publish_new","stat","root"])).length(6).refine(values=>new Set(values).size===6),extensions:z.array(z.enum(["publish_tree_v1","verify_tree_v1","exclusive_mkdir_v1"])).max(3).refine(values=>new Set(values).size===values.length).optional()}).strict();
export type NativeFileReceipt=z.infer<typeof receiptSchema>&{data:Buffer};
export interface NativeFileRequest {operation:NativeFileOperation;root?:string;path?:string;expectedRootIdentity?:string;data?:Buffer;maxBytes?:number;destinationName?:string;overwrite?:boolean;createParents?:boolean;extendedProbe?:boolean;
  tree?:NativeTreeEntry[];treeData?:Map<string,Buffer>;expectedTreeIdentity?:string}
const mutating=(operation:NativeFileOperation)=>["write","mkdir","mkdir_new","publish_new","publish_tree"].includes(operation);
function uint(value:number){const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);return bytes;}
function field(value:string,limit:number){const bytes=Buffer.from(value);if(bytes.length>limit||value.includes("\0"))throw new NativeFileBrokerError("invalid_request",false);return Buffer.concat([uint(bytes.length),bytes]);}

/** Private host IPC, not a Phonon/MCP method or caller-selected executable. */
export function encodeNativeFileRequest(request:NativeFileRequest):Buffer{
  const op=operations.indexOf(request.operation);if(op<0)throw new NativeFileBrokerError("invalid_request",false);
  let argument=0,flags=(request.overwrite?1:0)|(request.createParents?2:0);
  if(request.extendedProbe!==undefined&&request.operation!=="probe"||request.operation==="mkdir_new"&&(request.overwrite||request.createParents||request.data!==undefined||request.destinationName!==undefined))
    throw new NativeFileBrokerError("invalid_request",false);
  if(request.operation==="probe"&&request.extendedProbe)argument=1;
  let tail:Buffer=Buffer.alloc(0);
  if(request.operation==="read")argument=request.maxBytes??MAX_BYTES;
  if(request.operation==="write"){tail=request.data??Buffer.alloc(0);argument=tail.length;}
  if(request.operation==="publish_new"){tail=Buffer.from(request.destinationName??"");argument=tail.length;}
  if(request.operation==="publish_tree"||request.operation==="verify_tree"){
    if(request.overwrite||(request.operation==="publish_tree"?!request.treeData||!request.destinationName||request.expectedTreeIdentity!==undefined:!!request.treeData||!!request.destinationName||request.createParents||!identity.safeParse(request.expectedTreeIdentity).success))throw new NativeFileBrokerError("invalid_request",false);
    try{tail=encodeNativeTree(request.tree??[],request.treeData,request.expectedTreeIdentity,request.destinationName);}catch{throw new NativeFileBrokerError("invalid_request",false);}argument=tail.length;
  }
  if(!Number.isSafeInteger(argument)||argument<0||argument>(request.operation==="publish_tree"||request.operation==="verify_tree"?66*1024*1024:MAX_BYTES))throw new NativeFileBrokerError("invalid_request",false);
  const binding:Buffer[]=[];
  if(request.operation!=="probe"&&request.operation!=="root"){
    if(!identity.safeParse(request.expectedRootIdentity).success)throw new NativeFileBrokerError("invalid_request",false);
    flags|=4;binding.push(field(request.expectedRootIdentity!,80));
  }
  if(request.operation==="probe"||request.operation==="root")flags=0;
  return Buffer.concat([Buffer.from([80,70,83,50,op,flags,0,0]),field(request.root??"",4096),field(request.path??"",2048),...binding,uint(argument),tail]);
}
export function decodeNativeFileReply(output:Buffer,operation:NativeFileOperation,exitCode:number|null):NativeFileReceipt|z.infer<typeof probeSchema>{
  const newline=output.indexOf(10);if(newline<0||newline>2048)throw new NativeFileBrokerError("transport_unconfirmed",mutating(operation));
  let header:unknown;try{header=JSON.parse(output.subarray(0,newline).toString("utf8"));}catch{throw new NativeFileBrokerError("transport_unconfirmed",mutating(operation));}
  const failure=errorSchema.safeParse(header);
  if(failure.success&&exitCode!==0&&newline===output.length-1)throw new NativeFileBrokerError(failure.data.code,failure.data.mutated);
  if(operation==="probe"){
    const parsed=probeSchema.safeParse(header);if(parsed.success&&parsed.data.platform===process.platform&&exitCode===0&&newline===output.length-1)return parsed.data;
  }else{
    const parsed=receiptSchema.safeParse(header),data=output.subarray(newline+1);
    if(parsed.success&&exitCode===0&&parsed.data.dataBytes===data.length&&(operation==="read"||data.length===0))return {...parsed.data,data};
  }
  throw new NativeFileBrokerError("transport_unconfirmed",mutating(operation));
}

export class NativeFileBroker{
  constructor(private readonly artifactRoot:string){}
  async available():Promise<boolean>{
    try{await lstat(resolve(this.artifactRoot));}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
    await this.call({operation:"probe"});return true;
  }
  /** Fixed internal bridges share the same integrity check; no RPC executable. */
  async verifiedExecutable():Promise<string>{await this.call({operation:"probe"});return this.binary();}
  private async binary():Promise<string>{
    const root=await realpath(resolve(this.artifactRoot)),manifest=manifestSchema.parse(JSON.parse(await readFile(join(root,"manifest.json"),"utf8")));
    const key=process.platform+"-"+process.arch,entry=manifest.targets[key],expected=key+"/phonon-fs-broker"+(process.platform==="win32"?".exe":"");
    if(!entry||entry.file!==expected)throw new NativeFileBrokerError("unsupported",false);
    const path=join(root,entry.file),rel=relative(root,path),value=await lstat(path);
    if(isAbsolute(rel)||rel.startsWith("..")||!value.isFile()||value.isSymbolicLink()||value.size!==entry.size||createHash("sha256").update(await readFile(path)).digest("hex")!==entry.sha256)
      throw new NativeFileBrokerError("unsupported",false);
    return path;
  }
  async call(request:NativeFileRequest):Promise<NativeFileReceipt|z.infer<typeof probeSchema>>{
    const input=encodeNativeFileRequest(request);
    if(request.operation==="mkdir_new"){
      let observation;
      try{observation=await this.call({operation:"probe",extendedProbe:true});}
      catch(error){if(error instanceof NativeFileBrokerError&&error.code==="invalid_request")throw new NativeFileBrokerError("unsupported",false);throw error;}
      if(!("extensions" in observation)||!observation.extensions?.includes("exclusive_mkdir_v1"))throw new NativeFileBrokerError("unsupported",false);
    }
    const binary=await this.binary();
    return new Promise((resolveResult,reject)=>{
      const child=spawn(binary,[],{cwd:process.platform==="win32"?resolve(this.artifactRoot):"/",env:process.platform==="win32"?{SystemRoot:process.env.SystemRoot??"C:\\Windows"}:{PATH:"/usr/bin:/bin",LANG:"C.UTF-8"},stdio:["pipe","pipe","pipe"]});
      const chunks:Buffer[]=[];let size=0,errors=0,failed=false;
      const fail=()=>{if(!failed){failed=true;child.kill();reject(new NativeFileBrokerError("transport_unconfirmed",mutating(request.operation)));}};
      const timer=setTimeout(fail,30000);child.once("error",fail);child.stdin.once("error",fail);
      child.stdout.on("data",(bytes:Buffer)=>{size+=bytes.length;if(size>MAX_REPLY)fail();else chunks.push(bytes);});
      child.stderr.on("data",(bytes:Buffer)=>{errors+=bytes.length;if(errors>8192)fail();});
      child.once("close",code=>{clearTimeout(timer);if(failed)return;try{
        const result=decodeNativeFileReply(Buffer.concat(chunks),request.operation,code);
        if("data" in result&&(request.operation==="read"&&result.data.length>(request.maxBytes??MAX_BYTES)
          ||["write","read"].includes(request.operation)&&result.kind!=="file"
          ||["mkdir","mkdir_new","publish_new","publish_tree","verify_tree"].includes(request.operation)&&result.kind!=="directory"
          ||request.operation==="mkdir_new"&&!result.mutated
          ||["publish_new","publish_tree"].includes(request.operation)&&!result.mutated
          ||request.operation==="verify_tree"&&(result.mutated||result.identity!==request.expectedTreeIdentity)
          ||request.expectedRootIdentity!==undefined&&result.rootIdentity!==request.expectedRootIdentity))throw new NativeFileBrokerError("transport_unconfirmed",mutating(request.operation));
        resolveResult(result);
      }catch(error){reject(error);}});
      child.stdin.end(input);
    });
  }
}

export function packagedNativeFileBroker():NativeFileBroker{
  return new NativeFileBroker(join(dirname(fileURLToPath(import.meta.url)),"native"));
}
