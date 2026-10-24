import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {PeerContextJournal} from "./peer-context.js";
import {PeerContextReporter} from "./peer-context-reporter.js";
import {withPeerFixture} from "./testing/peer-fixture.js";

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
test("runtime evidence survives restart and syncs an observation newer than an in-flight offered receipt",()=>withPeerFixture("peer-reports",async scope=>{
  const path=join(scope.root,"journal.sqlite"),tenant="owner",authority="https://owned.example",deliveryId=randomUUID();
  const row={tenantId:tenant,sessionId:"s",runId:randomUUID(),turnId:"t",participantId:randomUUID(),messageId:randomUUID(),
    boundaryId:randomUUID(),nativeSessionId:"private-native",hash:"a".repeat(64),deliveryId,reportAuthority:authority};
  let journal=new PeerContextJournal(path);scope.defer(()=>journal.close());journal.claim([row]);journal.close();journal=new PeerContextJournal(path);
  assert.deepEqual(journal.pendingReports(tenant,"https://other.example"),[]);assert.deepEqual(journal.pendingReports("other",authority),[]);
  const calls:any[]=[];let release:()=>void=()=>{};
  const gate=new Promise<void>(done=>release=done);
  const reporter=new PeerContextReporter(journal,tenant,authority,async params=>{
    calls.push(params);if(calls.length===1)await gate;
    return {version:1,receipts:params.reports.map(report=>({deliveryId:report.deliveryId,status:"recorded",state:report.state}))};
  });scope.defer(()=>reporter.close());
  try{
    while(!calls.length)await tick();
    journal.observe(row,{boundaryId:row.boundaryId,nativeSessionId:row.nativeSessionId,messageIds:[row.messageId],evidence:"provider_payload"});
    reporter.kick();release();
    for(let n=0;n<100&&journal.pendingReports(tenant,authority).length;n++)await tick();
    assert.deepEqual(calls.map(call=>call.reports[0].state),["offered","provider_payload"]);
    assert.deepEqual(journal.pendingReports(tenant,authority),[]);
    assert.equal(JSON.stringify(calls).includes(row.nativeSessionId),false);
  }finally{release();reporter.close();}
}));

test("unknown receipts never remove reports and explicit rejection retires only metadata",async()=>{
  const journal=new PeerContextJournal(":memory:");
  const row={tenantId:"owner",sessionId:"s",runId:randomUUID(),turnId:"t",participantId:randomUUID(),messageId:randomUUID(),
    boundaryId:randomUUID(),nativeSessionId:"private",hash:"a".repeat(64),deliveryId:randomUUID(),reportAuthority:"server"};
  journal.claim([row]);let calls=0;
  const bad=new PeerContextReporter(journal,"owner","server",async()=>{calls++;return {version:1,receipts:[{deliveryId:randomUUID(),status:"recorded",state:"offered"}]};});
  try{for(let n=0;n<100&&!calls;n++)await tick();await tick();assert.equal(journal.pendingReports("owner","server").length,1);}finally{bad.close();}
  const denied=new PeerContextReporter(journal,"owner","server",async params=>({version:1,receipts:params.reports.map(report=>({deliveryId:report.deliveryId,status:"rejected",reason:"unavailable"}))}));
  try{for(let n=0;n<100&&journal.pendingReports("owner","server").length;n++)await tick();assert.deepEqual(journal.pendingReports("owner","server"),[]);assert.equal(journal.has("owner",row.participantId,row.messageId),true);}
  finally{denied.close();journal.close();}
});

test("a closed/replaced connection cannot acknowledge an in-flight report",async()=>{
  const journal=new PeerContextJournal(":memory:"),row={tenantId:"owner",sessionId:"s",runId:randomUUID(),turnId:"t",participantId:randomUUID(),messageId:randomUUID(),
    boundaryId:randomUUID(),nativeSessionId:"private",hash:"a".repeat(64),deliveryId:randomUUID(),reportAuthority:"server"};
  journal.claim([row]);let entered=false,release:()=>void=()=>{};const gate=new Promise<void>(done=>release=done);
  const reporter=new PeerContextReporter(journal,"owner","server",async params=>{entered=true;await gate;return {version:1,receipts:params.reports.map(report=>({deliveryId:report.deliveryId,status:"recorded",state:report.state}))};});
  try{for(let n=0;n<100&&!entered;n++)await tick();assert.ok(entered);reporter.close();release();await tick();assert.equal(journal.pendingReports("owner","server").length,1);}
  finally{release();reporter.close();await tick();journal.close();}
});
