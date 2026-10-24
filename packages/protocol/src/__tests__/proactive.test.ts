import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {StreamEvent,SessionMeta} from "../index.js";

test("native proactive provenance and settled stream position survive protocol parsing",()=>{
  const event={type:"message",sessionId:"retained",turnId:"u-native",seq:8,at:new Date().toISOString(),origin:"unsolicited",source:"cron",sourceEventId:"native",role:"assistant",text:"Observed native update",delta:false,
    nativeProactive:{anchorRunId:randomUUID(),employeeId:randomUUID(),employeeRevision:2,upstreamId:"native",project:"project",agent:"openclaw:base",model:"m1"}};
  const parsed=StreamEvent.parse(event);assert.deepEqual(parsed.nativeProactive,event.nativeProactive);assert.equal(parsed.nativeRunId,undefined);assert.equal(parsed.workflowId,undefined);
  const meta=SessionMeta.parse({sessionId:"retained",project:"project",agent:"openclaw:base",model:"m1",status:"idle",verbosity:"tools",queuedCount:0,createdAt:event.at,lastActiveAt:event.at,streamNextSeq:9,proactive:{supported:true,ready:true}});
  assert.equal(meta.streamNextSeq,9);assert.deepEqual(meta.proactive,{supported:true,ready:true});
});
