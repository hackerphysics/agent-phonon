import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry, PhononStore } from '@agent-phonon/core';
import { WorkflowResultParams, WorkflowResultPage } from '@agent-phonon/protocol';
import { PhononDevice, type RpcPeer } from '@agent-phonon/server-sdk';
import { TestConn, MockAdapter } from './harness.js';

test('workflow.result pages original Unicode output, omits only exact versions and survives a store restart without execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phonon-workflow-result-'));
  let store = new PhononStore(join(root, 'state.db')), calls = 0;
  const text = 'x'.repeat(15999) + '\u{1f600}\u4e2d\u6587 END';
  const registry = new AdapterRegistry(); registry.register(new MockAdapter({ reply: () => { calls++; return text; } }));
  let conn = new TestConn({ registry, store, tenantId: 'result-owner', workspaceRoot: root });
  try {
    const project = await conn.call('project.create', { name: 'Owned result test' }) as { project: { projectId: string } };
    const accepted = await conn.call('workflow.run', { project: project.project.projectId, plan: { mode: 'dag', nodes: [{ nodeId: 'worker', agent: 'mock:default', model: 'm1' }], finalNodeId: 'worker' } }) as { workflowId: string };
    const run = { workflowId: accepted.workflowId };
    for (let i = 0; i < 200; i++) { const s = await conn.call('workflow.status', run) as { status: string }; if (s.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const before = JSON.stringify(store.getWorkflow(run.workflowId, 'result-owner'));
    const first = WorkflowResultPage.parse(await conn.call('workflow.result', run));
    assert.equal(first.end, 15999); assert.equal(first.text, 'x'.repeat(15999));
    const tail = WorkflowResultPage.parse(await conn.call('workflow.result', { ...run, offset: first.end, version: first.version }));
    assert.equal(first.text + tail.text, text); assert.equal(tail.end, text.length);
    const proof = WorkflowResultPage.parse(await conn.call('workflow.result', { ...run, knownVersion: first.version }));
    assert.equal(proof.omitted, true); assert.equal('text' in proof, false); assert.ok(JSON.stringify(proof).length < 512);
    const changedKnown = WorkflowResultPage.parse(await conn.call('workflow.result', { ...run, knownVersion: '0'.repeat(64) })); assert.equal(changedKnown.text, first.text);
    const node = WorkflowResultPage.parse(await conn.call('workflow.result', { ...run, nodeId: 'worker' })); assert.notEqual(node.version, first.version);
    for (const p of [{ offset: first.end }, { offset: 16000, version: first.version }, { offset: 0, version: '0'.repeat(64) }, { nodeId: 'foreign' }, { offset: -1 }, { offset: 1.5 }]) await assert.rejects(conn.call('workflow.result', { ...run, ...p }));
    assert.equal(JSON.stringify(store.getWorkflow(run.workflowId, 'result-owner')), before); assert.equal(calls, 1);
    await conn.conn.dispose(); store.close(); store = new PhononStore(join(root, 'state.db'));
    conn = new TestConn({ registry, store, tenantId: 'result-owner', workspaceRoot: root });
    assert.equal(WorkflowResultPage.parse(await conn.call('workflow.result', { ...run, knownVersion: first.version })).omitted, true); assert.equal(calls, 1);
    const foreign = new TestConn({ registry, store, tenantId: 'foreign-owner', workspaceRoot: root });
    try { await assert.rejects(foreign.call('workflow.result', run)); } finally { await foreign.conn.dispose(); }
    const denied = new TestConn({ registry, store, tenantId: 'result-owner', workspaceRoot: root, policy: { allowedMethods: ['workflow.status'] } });
    try { await assert.rejects(denied.call('workflow.result', run)); } finally { await denied.conn.dispose(); }
  } finally { await conn.conn.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('workflow result schemas refuse ambiguous omissions, invalid ranges and extra parameters', () => {
  const value = { workflowId: 'wf-original', status: 'completed', version: 'a'.repeat(64), offset: 0, end: 3, totalLength: 3, text: 'abc' };
  assert.equal(WorkflowResultPage.safeParse(value).success, true);
  for (const patch of [{ omitted: true }, { end: 2 }, { end: 4 }, { offset: 4 }, { version: 'not-a-hash' }, { text: undefined }, { omitted: false }]) assert.equal(WorkflowResultPage.safeParse({ ...value, ...patch }).success, false);
  assert.equal(WorkflowResultParams.safeParse({ workflowId: 'wf-original', path: '/foreign' }).success, false);
});

test('TypeScript workflow result wrapper preserves original identity, offset and version pins', async () => {
  const calls: unknown[][] = [];
  const device = new PhononDevice('device', 'tenant', { request: async (...args: unknown[]) => { calls.push(args); return { omitted: true }; } } as unknown as RpcPeer);
  const params = { workflowId: 'wf-original', nodeId: 'worker', offset: 15999, version: 'a'.repeat(64), knownVersion: 'a'.repeat(64) };
  await device.workflow.result(params); assert.deepEqual(calls, [['workflow.result', params]]);
});
