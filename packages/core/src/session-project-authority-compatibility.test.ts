import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {withPeerFixture} from "./testing/peer-fixture.js";

test("selected existing session lifecycle, recovery and compression stay green",()=>withPeerFixture("session-compatibility",async scope=>{
  const pattern="session:|session\\.|whenBusy|disposing a connection|dispose during|Codex recovery|interrupted native turns|missing, corrupt|recovery checks|unstarted native|teardown fences|a resumed CLI|unconfirmed compression|legacy and malformed|late model/context|compression |background compression|noop compression|unverified or failed|a reopened receipt|custom compression";
  const env:NodeJS.ProcessEnv={...process.env,TMPDIR:scope.root,TMP:scope.root,TEMP:scope.root};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[...process.execArgv.filter(arg=>!arg.startsWith("--inspect")),"--test","--test-concurrency=1","--test-name-pattern="+pattern,
    "packages/test-server/src/fn-session.test.ts","packages/test-server/src/fn-session-compression.test.ts",
    "packages/test-server/src/fn-session-recovery.test.ts","packages/test-server/src/fn-connection-lifecycle.test.ts"],
    {env,stdio:["ignore","pipe","pipe"]});
  scope.watch(child);
  const exited=once(child,"exit");let output="";
  for(const stream of [child.stdout,child.stderr])stream!.on("data",data=>{if(output.length<16000)output+=String(data);});
  scope.defer(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGTERM");await exited;}});
  const [code,signal]=await exited;
  assert.equal(signal,null,output);assert.equal(code,0,output);
  assert.match(output,/(?:pass 31|# pass 31)/,output);
}));
