import test from "node:test";
import assert from "node:assert/strict";
import {METHODS,SkillPublishParams,SkillUnpublishParams} from "../index.js";
const input={clientRequestId:"original-publication",agent:"mock:default",name:"selected",projectId:"owned",baseRevision:null,source:{kind:"inline",files:{"SKILL.md":"Exact source"}}};
test("immutable publication has its own closed method and explicit nullable base, never a silently ignored legacy install flag",()=>{
  assert.equal(METHODS["skill.publish"].direction,"s2p");assert.equal(METHODS["skill.unpublish"].direction,"s2p");assert.equal(SkillPublishParams.parse(input).scope,"project");
  for(const changed of [{scope:"global"},{rootIdentity:"p:1:2"},{path:"/foreign"},{ownerID:"forged"},{permissions:{}},{baseRevision:undefined},{clientRequestId:undefined},{source:{kind:"localPath",path:"/foreign"}},{source:{kind:"url",url:"https://invalid"}}])
    assert.equal(SkillPublishParams.safeParse({...input,...changed}).success,false);
});
test("immutable deactivation is nonce/scope/revision bound and never accepts file deletion, approval or permission controls",()=>{
  const value={clientRequestId:"deactivate",agent:input.agent,name:input.name,projectId:input.projectId,baseRevision:"a".repeat(64)};assert.equal(SkillUnpublishParams.parse(value).scope,"project");
  for(const changed of [{baseRevision:null},{deleteFiles:true},{approve:true},{ownerID:"forged"},{resetAuthorization:true},{scope:"global"}])assert.equal(SkillUnpublishParams.safeParse({...value,...changed}).success,false);
});
