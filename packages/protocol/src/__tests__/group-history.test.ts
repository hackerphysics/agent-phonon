import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {AgentMessageInput,ConversationMessageParams,ConversationMessageResult} from "../schemas/conversation-message.js";

test("group history remains strict, bounded and controller scoped",()=>{
  const lineage={nativeRunId:randomUUID(),workflowId:"workflow",sessionId:"session",turnId:"turn"};
  for(const input of [{operation:"history",throughOrder:"100",beforeOrder:"80",limit:40},{operation:"read",messageID:randomUUID(),offset:6000}]){
    assert.ok(AgentMessageInput.safeParse(input).success);assert.ok(ConversationMessageParams.safeParse({...input,...lineage}).success);
    for(const field of ["conversationID","ownerID","senderID","projectID",...Object.keys(lineage)])assert.equal(AgentMessageInput.safeParse({...input,[field]:randomUUID()}).success,false);
  }
  for(const invalid of [{limit:41},{limit:0},{beforeOrder:"-1"},{throughOrder:"9223372036854775808"},{throughOrder:"1;DROP TABLE x"}])assert.equal(AgentMessageInput.safeParse({operation:"history",...invalid}).success,false);
  for(const offset of [-1,0.5,2147483647])assert.equal(AgentMessageInput.safeParse({operation:"read",messageID:randomUUID(),offset}).success,false);
  const message={id:randomUUID(),historyOrder:"1",author:"assistant",senderID:randomUUID(),senderName:"DE",createdAt:new Date().toISOString(),text:"Background",textLength:10,isExcerpt:false,mentionIDs:[],attachmentIDs:[]};
  const result={status:"history",conversationID:randomUUID(),projectID:randomUUID(),throughOrder:"1",messages:[message]};
  assert.ok(ConversationMessageResult.safeParse(result).success);
  assert.ok(ConversationMessageResult.safeParse({status:"message",conversationID:result.conversationID,projectID:result.projectID,message,offset:0}).success);
  assert.equal(ConversationMessageResult.safeParse({...result,messages:Array.from({length:41},()=>message)}).success,false);
  assert.equal(ConversationMessageResult.safeParse({...result,messages:[{...message,origin:{token:"must not appear"}}]}).success,false);
});
