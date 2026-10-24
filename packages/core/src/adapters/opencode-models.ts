import type { ModelInfo, ReasoningLevel } from "@agent-phonon/protocol";
import { canonicalReasoning } from "../reasoning.js";

export function parseOpenCodeNativeModels(text:string):{models:ModelInfo[];variants:Map<string,Map<ReasoningLevel,string>>}{
  const models:ModelInfo[]=[],variants=new Map<string,Map<ReasoningLevel,string>>();
  const lines=text.trim().split(/\r?\n/);
  for(let offset=0;offset<lines.length;){
    if(!lines[offset]?.trim()){offset++;continue;}
    const id=lines[offset++]!;
    if(!/^[^\s/]+\/[^\s]+$/.test(id)||id.length>240||lines[offset]!=="{")throw new Error("Invalid native OpenCode model record");
    const start=offset;
    while(offset<lines.length&&lines[offset]!=="}")offset++;
    if(offset===lines.length)throw new Error("Incomplete native OpenCode model record");
    const record=JSON.parse(lines.slice(start,++offset).join("\n"));
    if(id!==record.providerID+"/"+record.id||variants.has(id)||models.length>=2000)throw new Error("Invalid native OpenCode model identity");
    const mapping=new Map<ReasoningLevel,string>(),ambiguous=new Set<ReasoningLevel>();
    if(record.capabilities?.reasoning===true&&record.variants&&typeof record.variants==="object"&&!Array.isArray(record.variants)){
      for(const [name,options] of Object.entries(record.variants)){
        if(!name||name.length>240||!options||typeof options!=="object"||Array.isArray(options))continue;
        const variant=options as {reasoningEffort?:unknown;disabled?:unknown};
        if(variant.disabled===true)continue;
        const level=canonicalReasoning(variant.reasoningEffort);
        if(!level)continue;
        if(mapping.has(level)){mapping.delete(level);ambiguous.add(level);}
        else if(!ambiguous.has(level))mapping.set(level,name);
      }
    }
    variants.set(id,mapping);
    models.push({id,...(typeof record.name==="string"?{displayName:record.name}:{}),available:record.status!=="deprecated",
      reasoningLevels:[...mapping.keys()]});
  }
  return {models,variants};
}
