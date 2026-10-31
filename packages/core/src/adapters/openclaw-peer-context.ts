import { z } from "zod";
import { nativeVersionAtLeast } from "@agent-phonon/protocol";

export const OpenClawPeerCapabilities=z.object({version:z.literal(1),available:z.literal(true),nativeVersion:z.string().refine(value=>nativeVersionAtLeast(value,"2026.9.3")),
  selectedRuntime:z.literal("openclaw"),runtimes:z.tuple([z.literal("openclaw")]),boundary:z.literal("after_tools"),visibility:z.literal("collapsed"),evidence:z.literal("context_hook"),budget:z.literal("native_estimate"),
  currentTurnInput:z.literal("native_context_v1").optional()}).strict();
export const OpenClawInputCapabilities=OpenClawPeerCapabilities.extend({selectedRuntime:z.null(),nativeVersion:z.string().refine(value=>nativeVersionAtLeast(value,"2026.10.7")),currentTurnInput:z.literal("native_context_v1")});

/** Strip only this run's explicitly attributed peer carrier, never arbitrary tool text. */
export function projectOpenClawToolResult(result:unknown,scope:{projectionId:string;runId:string;sessionId:string}|undefined):unknown {
  if(!scope||!result||typeof result!=="object"||!Array.isArray((result as {content?:unknown}).content))return result;
  const record=result as {content:unknown[]},content=record.content.filter(block=>{
    if(!block||typeof block!=="object"||(block as {type?:unknown}).type!=="text")return true;
    const tag=z.object({version:z.literal(1),projectionId:z.literal(scope.projectionId),runId:z.literal(scope.runId),
      sessionId:z.literal(scope.sessionId),boundaryId:z.string().uuid()}).strict().safeParse((block as {agentPhononPeerContext?:unknown}).agentPhononPeerContext);
    return !tag.success;
  });
  return content.length===record.content.length?result:{...record,content};
}
