import { createHash } from "node:crypto";
import { CompressionReceipt } from "@agent-phonon/protocol";

export function compressionRequestHash(sessionId:string,mode:"native"|"custom",strategy?:string,keepRecentToolCalls?:number):string{
  const request=mode==="native"?{mode,sessionId}:{keepRecentToolCalls:keepRecentToolCalls??3,mode,sessionId,strategy:strategy??"dropToolIO"};
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
export function observedCompression(raw:unknown,active:Set<string>,tenant:string):CompressionReceipt{
  const receipt=CompressionReceipt.parse(raw);
  return receipt.state==="running"&&!active.has(tenant+"\0"+receipt.operationId)
    ?{...receipt,state:"unknown",errorCode:"compression_outcome_unknown"}:receipt;
}
