import { z } from "zod";
import { SessionId,Timestamp } from "./common.js";

export const NativeStopTarget = z.object({
  version:z.literal(1),sessionId:SessionId,turnId:z.string().optional(),nodeId:z.string().optional(),
  state:z.enum(["pending","confirmed","unknown"]),observedAt:Timestamp,
  confirmation:z.enum(["not_started","process_tree_exit","native_terminal"]).optional(),
  reasonCode:z.string().max(128).optional(),
}).strict().refine(value=>value.state!=="confirmed"||value.confirmation!==undefined);
export type NativeStopTarget=z.infer<typeof NativeStopTarget>;
export const NativeStopProof=z.object({
  version:z.literal(1),state:z.enum(["pending","confirmed","unknown"]),
  targets:z.array(NativeStopTarget).max(256),observedAt:Timestamp,
  reasonCode:z.string().max(128).optional(),
}).strict().refine(value=>value.state!=="confirmed"||value.targets.every(target=>target.state==="confirmed"));
export type NativeStopProof=z.infer<typeof NativeStopProof>;
