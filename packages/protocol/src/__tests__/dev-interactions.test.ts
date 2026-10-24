import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {InteractionRequestParams,InteractionStatusResult,interactionRequestIdentity} from '../schemas/interaction.js';

test('Dev interaction identity survives parsing and excludes delivery timestamps',()=>{
  const request=InteractionRequestParams.parse({requestId:'dev-form',devRunId:randomUUID(),workflowId:'wf',sessionId:'session',turnId:'turn',form:{title:'Human decision',fields:[]},at:new Date().toISOString()});
  assert.ok(request.devRunId);assert.equal(request.nativeRunId,undefined);
  assert.equal('at' in interactionRequestIdentity(request),false);
  assert.equal(interactionRequestIdentity(request).devRunId,request.devRunId);
  assert.equal(InteractionStatusResult.parse({requestId:request.requestId,devRunId:request.devRunId,requestHash:'a'.repeat(64),state:'applied',updatedAt:request.at}).devRunId,request.devRunId);
});
test('requests and receipts reject mixed execution domains',()=>{
  const source={nativeRunId:randomUUID(),devRunId:randomUUID()};
  assert.equal(InteractionRequestParams.safeParse({requestId:'mixed',...source,form:{title:'No approval',fields:[]},at:new Date().toISOString()}).success,false);
  assert.equal(InteractionStatusResult.safeParse({requestId:'mixed',...source,requestHash:'a'.repeat(64),state:'pending',updatedAt:new Date().toISOString()}).success,false);
});
