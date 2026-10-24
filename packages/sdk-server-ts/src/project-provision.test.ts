import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {PhononDevice} from "./server.js";
import {parseParams} from "@agent-phonon/protocol";

const receiver=randomUUID(),input={clientRequestId:randomUUID(),name:"Managed workspace",expectedReceiverID:receiver};
function fixture(info:unknown={capabilities:["project_provision_v1"],projectProvisionReceiverID:receiver}){
  const calls:Array<{method:string;params:any}>=[];
  const device=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params});return method==="device.info"?info:{state:"unknown"};}} as never);
  return {device,calls};
}
test("TypeScript controlled provisioning preserves exact receiver and retry identity after capability preflight",async()=>{
  const f=fixture();await f.device.project.provision(input);
  assert.deepEqual(f.calls.map(value=>value.method),["device.info","project.provision"]);assert.deepEqual(parseParams("project.provision",f.calls[1]!.params),input);
  await f.device.project.provisionStatus({clientRequestId:input.clientRequestId,expectedReceiverID:receiver});
  assert.deepEqual(f.calls[2],{method:"project.provision.status",params:{clientRequestId:input.clientRequestId,expectedReceiverID:receiver}});
});
for(const info of[null,{},false,{capabilities:"project_provision_v1",projectProvisionReceiverID:receiver},{capabilities:[],projectProvisionReceiverID:receiver},
  {capabilities:["project_provision_v1"],projectProvisionReceiverID:randomUUID()}])test(`TypeScript refuses unsupported/mismatched provisioning before mutation ${JSON.stringify(info)}`,async()=>{
  const f=fixture(info);await assert.rejects(f.device.project.provision(input),/project_provision_device_update_required/);assert.deepEqual(f.calls.map(value=>value.method),["device.info"]);
});
test("TypeScript controlled provision packet is snapshotted before async reads and legacy creation is untouched",async()=>{
  const calls:Array<{method:string;params:any}>=[];let release!:(value:unknown)=>void;
  const device=new PhononDevice("device","owner",{request:async(method:string,params:unknown)=>{calls.push({method,params});return method==="device.info"?new Promise(done=>release=done):{};}} as never);
  const selected={...input},work=device.project.provision(selected);selected.name="Changed during preparation";selected.expectedReceiverID=randomUUID();
  release({capabilities:["project_provision_v1"],projectProvisionReceiverID:receiver});await work;assert.deepEqual(calls[1]!.params,input);
  await device.project.create({name:"Legacy",git:false});assert.deepEqual(calls[2],{method:"project.create",params:{name:"Legacy",git:false}});
});
