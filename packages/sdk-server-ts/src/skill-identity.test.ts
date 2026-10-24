import test from "node:test";
import assert from "node:assert/strict";
import {PhononDevice} from "./server.js";
import {parseParams} from "@agent-phonon/protocol";
import {randomUUID} from "node:crypto";

test("TypeScript skill helpers retain the exact optional request identity on both mutations",async()=>{
  const calls:Array<{method:string;params:unknown}>=[];
  const peer={request:async(method:string,params:unknown)=>{calls.push({method,params:parseParams(method as "skill.install"|"skill.uninstall"|"skill.install.status",params)});return {confirmed:true};}};
  const device=new PhononDevice("device","owner",peer as never),clientRequestId="original\u0000identity";
  const input={agent:"mock:default",name:"fixed",scope:"project" as const,projectId:"owned",source:{kind:"inline",files:{"SKILL.md":"Exact bytes"}},clientRequestId};
  await device.skill.install(input);
  const {source:ignored,...remove}=input;await device.skill.uninstall(remove);
  await device.skill.installStatus(remove);
  assert.deepEqual(calls,[{method:"skill.install",params:input},{method:"skill.uninstall",params:remove},{method:"skill.install.status",params:remove}]);
});

test("TypeScript immutable publication and deactivation use separate non-downgrading methods and preserve exact CAS input",async()=>{
  const calls:Array<{method:string;params:unknown}>=[],peer={request:async(method:string,params:unknown)=>{calls.push({method,params:parseParams(method as "skill.publish"|"skill.unpublish",params)});return {};}};
  const device=new PhononDevice("device","owner",peer as never),input={clientRequestId:"original-publish",agent:"mock:default",name:"selected",projectId:"owned",baseRevision:null,source:{kind:"inline",files:{"SKILL.md":"Original bytes"}}};
  await device.skill.publish(input);await device.skill.unpublish({clientRequestId:"original-unpublish",agent:input.agent,name:input.name,projectId:input.projectId,baseRevision:"a".repeat(64)});
  assert.deepEqual(calls,[{method:"skill.publish",params:{...input,scope:"project"}},{method:"skill.unpublish",params:{clientRequestId:"original-unpublish",agent:input.agent,name:input.name,projectId:input.projectId,baseRevision:"a".repeat(64),scope:"project"}}]);
});

test("TypeScript receiver-pinned publication and opted-in status forward proof without changing the returned receipt",async()=>{
  const calls:Array<{method:string;params:unknown}>=[],receiverID=randomUUID(),receipt={receiverID,state:"confirmed"};
  const peer={request:async(method:string,params:unknown)=>{calls.push({method,params:parseParams(method as "skill.publish"|"skill.install.status",params)});return receipt;}};
  const device=new PhononDevice("device","owner",peer as never),input={clientRequestId:"pinned-publication",agent:"mock:default",name:"selected",projectId:"owned",scope:"project" as const,
    baseRevision:null,expectedReceiverID:receiverID,source:{kind:"inline",files:{"SKILL.md":"Original bytes"}}};
  assert.deepEqual(await device.skill.publish(input),receipt);
  const query={clientRequestId:input.clientRequestId,agent:input.agent,name:input.name,projectId:input.projectId,scope:input.scope,includeReceiverIdentity:true as const};
  assert.deepEqual(await device.skill.installStatus(query),receipt);
  assert.deepEqual(calls,[{method:"skill.publish",params:input},{method:"skill.install.status",params:query}]);
});

test("TypeScript recovery context and metadata fence preserve exact native identity without becoming another publication",async()=>{
  const calls:Array<{method:string;params:unknown}>=[],receiverID=randomUUID(),receipt={outcomeKnown:false,targetLocked:true};
  const peer={request:async(method:string,params:unknown)=>{calls.push({method,params:parseParams(method as "skill.install.status"|"skill.install.fence",params)});return receipt;}};
  const device=new PhononDevice("device","owner",peer as never),scope={clientRequestId:"original",agent:"mock:default",name:"fixed",scope:"project" as const,projectId:"owned",includeRecoveryContext:true as const};
  assert.deepEqual(await device.skill.installStatus(scope),receipt);
  const input={clientRequestId:"human-fence",originalRequestId:scope.clientRequestId,agent:scope.agent,name:scope.name,scope:scope.scope,projectId:scope.projectId,expectedReceiverID:receiverID,baseRecoveryRevision:"a".repeat(64)};
  assert.deepEqual(await device.skill.fence(input),receipt);assert.deepEqual(calls,[{method:"skill.install.status",params:scope},{method:"skill.install.fence",params:input}]);
});
