import test from "node:test";
import assert from "node:assert/strict";
import {METHODS,SkillInstallStatusParams,SkillInstallStatusResult,SkillInstallFenceParams,SkillInstallFenceResult,SkillPublishParams,DeviceInfoResult,TenantPolicy} from "../index.js";
import {randomUUID} from "node:crypto";

const input={clientRequestId:"exact-operation",agent:"mock:default",name:"selected",scope:"project",projectId:"owned"};
test("install receipt lookup is a bounded read-only identity, never a source/path/authority or retry command",()=>{
  assert.equal(METHODS["skill.install.status"].direction,"s2p");assert.deepEqual(SkillInstallStatusParams.parse(input),input);
  for(const changed of [{ownerID:"forged"},{path:"/foreign"},{source:{kind:"url",url:"https://invalid"}},{retry:true},{permission:"owner"},{clientRequestId:"x".repeat(513)},{projectId:undefined}])
    assert.equal(SkillInstallStatusParams.safeParse({...input,...changed}).success,false);
  assert.equal(SkillInstallStatusParams.safeParse({...input,scope:"global"}).success,false);
});
test("receipt states cannot manufacture success, dispatch or known absence from missing/uncertain evidence",()=>{
  assert.equal(SkillInstallStatusResult.safeParse({clientRequestId:input.clientRequestId,state:"not_found",found:false,outcomeKnown:false}).success,true);
  assert.equal(SkillInstallStatusResult.safeParse({clientRequestId:input.clientRequestId,state:"not_found",found:false,outcomeKnown:true}).success,false);
  const identity={clientRequestId:input.clientRequestId,createdAt:"2026-10-22T00:00:00.000Z",updatedAt:"2026-10-22T00:00:00.000Z",found:true};
  assert.equal(SkillInstallStatusResult.safeParse({...identity,state:"unknown",outcomeKnown:false,dispatchClaimed:true,reasonCode:"write_outcome_unconfirmed"}).success,true);
  const uncertain={...identity,state:"unknown",outcomeKnown:false,dispatchClaimed:true,reasonCode:"write_outcome_unconfirmed"};
  for(const changed of [{state:"confirmed"},{state:"unknown",outcomeKnown:true},{state:"failed",dispatchClaimed:true,reasonCode:"preparation_failed"}])
    assert.equal(SkillInstallStatusResult.safeParse({...uncertain,...changed}).success,false);
});

test("receiver proof is opt-in, bounded and separate from installation or human authority",()=>{
  const receiverID=randomUUID();
  assert.equal(SkillInstallStatusParams.parse({...input,includeReceiverIdentity:true}).includeReceiverIdentity,true);
  for(const value of [false,"true",1])assert.equal(SkillInstallStatusParams.safeParse({...input,includeReceiverIdentity:value}).success,false);
  const confirmed={clientRequestId:input.clientRequestId,createdAt:"2026-10-22T00:00:00.000Z",updatedAt:"2026-10-22T00:00:00.000Z",found:true,
    state:"confirmed",outcomeKnown:true,dispatchClaimed:true,result:{skill:{name:input.name,agent:input.agent,scope:"project",projectId:input.projectId}},receiverID};
  const parsed=SkillInstallStatusResult.parse(confirmed);assert.ok("receiverID" in parsed);assert.equal(parsed.receiverID,receiverID);
  assert.equal(SkillInstallStatusResult.safeParse({...confirmed,receiverID:"caller supplied host name"}).success,false);
  assert.equal(SkillInstallStatusResult.safeParse({clientRequestId:input.clientRequestId,state:"not_found",found:false,outcomeKnown:false,receiverID}).success,false);
  const publication={...input,baseRevision:null,expectedReceiverID:receiverID,source:{kind:"inline",files:{"SKILL.md":"Pinned task data"}}};
  assert.equal(SkillPublishParams.parse(publication).expectedReceiverID,receiverID);
  assert.equal(SkillPublishParams.safeParse({...publication,expectedReceiverID:"not-a-receiver"}).success,false);
  const info={at:"2026-10-22T00:00:00.000Z",hostname:"fixture",os:{platform:"linux",type:"Linux",release:"test",arch:"x64"},skillReceiverID:receiverID};
  assert.equal(DeviceInfoResult.parse(info).skillReceiverID,receiverID);
  assert.equal(DeviceInfoResult.safeParse({...info,skillReceiverID:"unbounded arbitrary ID"}).success,false);
});

test("the explicit recovery primitive cannot accept a path, actor, approval, file cleanup or a fabricated installation result",()=>{
  const receiverID=randomUUID(),query={...input,includeRecoveryContext:true};assert.equal(SkillInstallStatusParams.parse(query).includeRecoveryContext,true);
  assert.equal(TenantPolicy.parse({}).allowSkillRecovery,false);assert.equal(METHODS["skill.install.fence"].direction,"s2p");
  const request={...input,clientRequestId:"recovery-decision",originalRequestId:input.clientRequestId,expectedReceiverID:receiverID,baseRecoveryRevision:"a".repeat(64)};
  assert.deepEqual(SkillInstallFenceParams.parse(request),request);
  for(const extra of [{path:"/caller"},{ownerID:randomUUID()},{approved:true},{force:true},{deleteFiles:true},{scope:"global"},{source:{kind:"inline",files:{}}}])
    assert.equal(SkillInstallFenceParams.safeParse({...request,...extra}).success,false);
  const result={clientRequestId:request.clientRequestId,originalRequestId:input.clientRequestId,agent:input.agent,name:input.name,scope:"project",projectId:input.projectId,receiverID,originalReceiverID:null,
    fenceID:randomUUID(),disposition:"unconfirmed_metadata_fenced",outcomeKnown:false,targetLocked:true,filesDeleted:false,originalWritesMayContinue:true,recordedAt:"2026-10-22T00:00:00.000Z"};
  assert.equal(SkillInstallFenceResult.safeParse(result).success,true);
  for(const extra of [{outcomeKnown:true},{targetLocked:false},{filesDeleted:true},{installed:true},{originalWritesMayContinue:false}])assert.equal(SkillInstallFenceResult.safeParse({...result,...extra}).success,false);
});
