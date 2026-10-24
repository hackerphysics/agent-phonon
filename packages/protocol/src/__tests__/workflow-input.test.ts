import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {METHODS} from '../schemas/methods.js';
import {WorkflowInputParams,WorkflowInputReceipt,WorkflowInputStatusResult} from '../schemas/workflow.js';
describe('workflow input binding and receipt contract',()=>{
  const input={workflowId:'workflow',nodeId:'worker',sessionId:'session',turnId:'original-turn',inputId:'original-message',input:'Exact input'};
  it('requires the original complete active binding and never accepts implicit queue or control options',()=>{
    assert.deepEqual(WorkflowInputParams.parse(input),input);assert.equal(METHODS['workflow.input'].direction,'s2p');
    for(const change of [{turnId:''},{inputId:''},{input:' '},{input:'x'.repeat(16001)},{fallback:'queue'},{reasoning:{level:'high'}},{approved:true}])assert.equal(WorkflowInputParams.safeParse({...input,...change}).success,false);
    for(const key of ['workflowId','nodeId','sessionId','turnId','inputId']){const value={...input} as Record<string,unknown>;delete value[key];assert.equal(WorkflowInputParams.safeParse(value).success,false);}
  });
  it('keeps accepted insertion distinct from execution completion and supports read-only missing receipts',()=>{
    const {input:_text,...binding}=input,receipt={...binding,contentHash:'a'.repeat(64),state:'unknown',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    assert.deepEqual(WorkflowInputReceipt.parse(receipt),receipt);assert.equal(WorkflowInputStatusResult.safeParse({found:true,receipt}).success,true);
    assert.equal(WorkflowInputStatusResult.safeParse({found:false,workflowId:input.workflowId,inputId:input.inputId}).success,true);
    assert.equal(WorkflowInputReceipt.safeParse({...receipt,state:'completed'}).success,false);
  });
});
