import {createHash} from "node:crypto";
import {z} from "zod";

export const NATIVE_TREE_LIMITS=Object.freeze({entries:4096,fileBytes:16*1024*1024,totalBytes:64*1024*1024,pathBytes:2048,depth:64});
const path=z.string().min(1).refine(value=>Buffer.byteLength(value)<=2048&&Buffer.from(value).toString("utf8")===value
  &&!/[\p{Cc}\ufffd<>:"\\|?*]/u.test(value)&&value.split("/").length<=64&&value.split("/").every(part=>!!part&&Buffer.byteLength(part)<=255
    &&part!=="."&&part!==".."&&!/[. ]$/.test(part)&&!/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i.test(part.split(".")[0]!.trimEnd())));
export const NativeTreeEntry=z.discriminatedUnion("kind",[
  z.object({path,kind:z.literal("directory"),size:z.literal(0)}).strict(),
  z.object({path,kind:z.literal("file"),size:z.number().int().min(0).max(NATIVE_TREE_LIMITS.fileBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/),executable:z.boolean().default(false)}).strict(),
]);
export type NativeTreeEntry=z.infer<typeof NativeTreeEntry>;
export function nativeTreeManifest(input:unknown):NativeTreeEntry[]{
  const entries=z.array(NativeTreeEntry).min(1).max(NATIVE_TREE_LIMITS.entries).parse(input),seen=new Map<string,NativeTreeEntry>();let total=0;
  for(const entry of entries){
    const key=entry.path.normalize("NFC").toLowerCase();if(seen.has(key))throw Error("duplicate or aliased native tree entry");seen.set(key,entry);
    if((total+=entry.size)>NATIVE_TREE_LIMITS.totalBytes)throw Error("native tree byte limit");
  }
  for(const entry of entries){const parts=entry.path.split("/");parts.pop();if(parts.length){const parent=parts.join("/"),record=seen.get(parent.normalize("NFC").toLowerCase());
    if(!record||record.path!==parent||record.kind!=="directory")throw Error("native tree parent is missing or aliased");}}
  return entries.sort((a,b)=>a.path.split("/").length-b.path.split("/").length||Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
}
export function nativeTreeHash(entries:NativeTreeEntry[]):string{return createHash("sha256").update(JSON.stringify(nativeTreeManifest(entries))).digest("hex");}
const uint=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);return bytes;};
const field=(value:string)=>{const data=Buffer.from(value);return Buffer.concat([uint(data.length),data]);};
export function encodeNativeTree(entries:NativeTreeEntry[],data:Map<string,Buffer>|undefined,expectedTreeIdentity:string|undefined,destinationName:string|undefined):Buffer{
  const plan=nativeTreeManifest(entries),indices=new Map<string,number>(),chunks:Buffer[]=[field(expectedTreeIdentity??""),field(destinationName??""),uint(plan.length)];
  for(const [index,entry]of plan.entries()){
    const parts=entry.path.split("/"),name=parts.pop()!,parent=parts.join("/");
    const ancestor=parent?indices.get(parent):0xffffffff;if(ancestor===undefined)throw Error("native tree parent ordering");
    chunks.push(uint(ancestor),Buffer.from([entry.kind==="file"?1:0,entry.kind==="file"&&entry.executable?1:0]),field(name),uint(entry.size),entry.kind==="file"?Buffer.from(entry.sha256,"hex"):Buffer.alloc(32));
    if(data&&entry.kind==="file"){
      const bytes=data.get(entry.path);if(!bytes||bytes.length!==entry.size||createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw Error("native tree source bytes do not match manifest");chunks.push(bytes);
    }
    indices.set(entry.path,index);
  }
  if(data&&(data.size!==plan.filter(entry=>entry.kind==="file").length||[...data.keys()].some(key=>!indices.has(key))))throw Error("unlisted native tree data");
  return Buffer.concat(chunks);
}
