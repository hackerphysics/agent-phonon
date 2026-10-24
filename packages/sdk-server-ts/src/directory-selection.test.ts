import test from "node:test";
import assert from "node:assert/strict";
import {PhononDevice} from "./server.js";

test("directory SDK operations require new native support and preserve the exact input and identity",async()=>{
  const calls:Array<{method:string;params:any}>=[],input={name:"Code",path:"/work/code",git:false,existingDirectoryIdentity:"dir:1:2",clientRequestId:"same-request"};
  const device=new PhononDevice("device","owner",{request:async(method:string,params:any)=>{calls.push({method,params});return method==="device.info"?{capabilities:["workspace_directory_picker_v1"]}:method==="project.create"?{project:{projectId:"dir-reference",path:input.path,directoryIdentity:input.existingDirectoryIdentity}}:{input:params.directoryInput};}} as never);
  await device.fsList({projectCandidates:true,directoryInput:"/work/co",limit:100});await device.project.create(input);
  assert.deepEqual(calls.map(row=>row.method),["device.info","device.fs.list","device.info","project.create"]);
  assert.deepEqual(calls[1]?.params,{projectCandidates:true,directoryInput:"/work/co",limit:100});assert.deepEqual(calls[3]?.params,input);
});
test("an old native directory implementation cannot acquire a strict registration effect",async()=>{
  const calls:string[]=[],device=new PhononDevice("device","owner",{request:async(method:string)=>{calls.push(method);return {};}} as never);
  await assert.rejects(device.project.create({name:"Code",path:"/work",git:false,existingDirectoryIdentity:"dir:1:2"}));
  await assert.rejects(device.fsList({projectCandidates:true,directoryInput:"/work/"}));assert.deepEqual(calls,["device.info","device.info"]);
});
