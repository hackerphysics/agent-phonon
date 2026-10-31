import { z } from "zod";
import { AgentId } from "./common.js";

export const EmployeeSelection=z.object({id:z.string().uuid(),revision:z.number().int().positive()}).strict();
export const EmployeeProfileApplyParams=z.object({
  employeeId:z.string().uuid(),revision:z.number().int().positive(),agent:AgentId,model:z.string().min(1).max(240),
  profileId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  profileBinding:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("harness")}).strict(),
    z.object({kind:z.literal("employee"),employeeId:z.string().uuid()}).strict(),
  ]).optional(),
  name:z.string().min(1).max(120),responsibility:z.string().max(4000),
  documents:z.object({soul:z.string().max(100000),agents:z.string().max(100000),user:z.string().max(100000),tools:z.string().max(100000)}).strict(),
}).strict();
export type EmployeeProfileApplyParams=z.infer<typeof EmployeeProfileApplyParams>;
export const EmployeeProfileStatusParams=z.object({employeeId:z.string().uuid()});
export const EmployeeProfileStatusResult=z.object({
  employeeId:z.string().uuid(),revision:z.number().int().positive(),requestHash:z.string().regex(/^[a-f0-9]{64}$/),
  state:z.enum(["provisioning","ready","failed"]),agent:AgentId,profileId:z.string(),provider:z.string(),
  runtimeProfile:z.string(),privateWorkspace:z.object({projectId:z.string().min(1),path:z.string(),name:z.string(),employeeId:z.string().uuid()}).optional(),
  documentHashes:z.record(z.string()).optional(),memoryBytes:z.number().int().nonnegative().optional(),errorCode:z.string().optional(),
});
export type EmployeeProfileStatusResult=z.infer<typeof EmployeeProfileStatusResult>;
