import test from "node:test";
import assert from "node:assert/strict";
import { NativeStopProof,WorkflowEvent,SessionMeta } from "../index.js";

test("native stop evidence survives event/status parsing and cannot invent target confirmation",()=>{
  const at=new Date().toISOString(),target={version:1,sessionId:"retained",turnId:"original",nodeId:"reply",state:"confirmed",observedAt:at,confirmation:"process_tree_exit"};
  const proof={version:1,state:"confirmed",targets:[target],observedAt:at};
  assert.deepEqual(NativeStopProof.parse(proof),proof);
  assert.deepEqual(WorkflowEvent.parse({workflowId:"wf",seq:1,type:"workflow.status",status:"cancelled",timestamp:at,nativeStop:proof}).nativeStop,proof);
  assert.deepEqual(SessionMeta.parse({sessionId:"retained",project:"owned",agent:"codex",model:"m",status:"paused",verbosity:"tools",createdAt:at,nativeStop:target}).nativeStop,target);
  assert.throws(()=>NativeStopProof.parse({...proof,targets:[{...target,state:"unknown",confirmation:undefined}]}));
  assert.throws(()=>NativeStopProof.parse({...proof,targets:[{...target,confirmation:undefined}]}));
});
