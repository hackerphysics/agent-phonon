import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentCoordinationInput,ProjectCoordinationParams,ProjectCoordinationResult} from '../index.js';

test('Coordination workspace negotiation is controller-only and legacy results remain valid',()=>{
  const input={sourceKind:'native',runId:randomUUID(),workflowId:'workflow',sessionId:'session',turnId:'turn',action:{operation:'peers'}};
  assert.equal(ProjectCoordinationParams.parse({...input,workspaceVersion:1}).workspaceVersion,1);
  assert.throws(()=>ProjectCoordinationParams.parse({...input,workspaceVersion:2}));
  assert.throws(()=>AgentCoordinationInput.parse({operation:'peers',workspaceVersion:1}));
  assert.throws(()=>AgentCoordinationInput.parse({operation:'activity',requestId:randomUUID(),baseRevision:0,
    activity:{summary:'A claim',phase:'working',impact:[],workspace:{path:'/forged'}}}));
  const self={id:randomUUID(),position:'1',projectId:randomUUID(),ownerId:'owner',deviceId:randomUUID(),agentId:'codex',agentKind:'agent',
    sourceKind:'native',sessionId:'session',label:'Worker',activity:{summary:'',phase:'working',impact:[],dependencies:''},activityRevision:0,lastSeenAt:null,presence:'active'};
  assert.equal(ProjectCoordinationResult.parse({self}).self?.workspace,undefined);
  const workspace={state:'current',deviceId:self.deviceId,runtimeWorkspaceId:'project',path:'/work/side',repositoryRoot:'/work/side',
    branch:'side',isWorktree:true,worktreeId:'side',detached:false,observedAt:new Date().toISOString(),checkedAt:new Date().toISOString()};
  assert.deepEqual(ProjectCoordinationResult.parse({self:{...self,workspace},workspaceVersion:1}).self?.workspace,workspace);
  for(const change of [{path:'/work\nforged'},{branch:''},{changedFileCount:0},{reasonCode:'unsafe/private'}])
    assert.throws(()=>ProjectCoordinationResult.parse({self:{...self,workspace:{...workspace,...change}},workspaceVersion:1}));
});
