import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import type { ChildProcess } from "node:child_process";
import { AdapterRegistry, CopilotAdapter, PhononStore, SessionEngine, spawnSupervisedAgent, type ProcessSupervisor } from "@agent-phonon/core";
import type { AdapterSession } from "@agent-phonon/core";
import { PeerContextBridge } from "../../core/dist/peer-context-bridge.js";
import { withPeerFixture, closePeerServer, type PeerFixture } from "../../core/dist/testing/peer-fixture.js";
import { TestConn } from "./harness.js";

async function grantFixtureExtension(scope: PeerFixture, cwd: string, environment: Record<string, string>, approveCoordination=false) {
  const sdk = process.env.PHONON_TEST_COPILOT_SDK_ROOT;
  assert.ok(sdk && existsSync(join(sdk, "index.js")), "Select the installed CLI's existing bundled SDK");
  const runner = join(scope.root, "native-fixture-consent.mjs"), sessionId = randomUUID();
  // Synthetic fixture consent only. Production never calls this grant API.
  writeFileSync(runner, `
import{CopilotClient,RuntimeConnection}from${JSON.stringify(pathToFileURL(join(sdk, "index.js")).href)};
const client=new CopilotClient({connection:RuntimeConnection.forStdio({path:${JSON.stringify(process.env.PHONON_TEST_COPILOT_BIN)},args:["--no-auto-update","--no-remote","--no-remote-export","--disable-builtin-mcps"]}),workingDirectory:process.cwd(),env:{...process.env},useLoggedInUser:false});
let session;
try{
 session=await client.createSession({sessionId:${JSON.stringify(sessionId)},workingDirectory:process.cwd(),enableConfigDiscovery:true,onPermissionRequest:()=>({kind:"reject"})});
 if((await client.getStatus()).version!=="1.0.82")throw new Error("Unqualified native fixture version");
 const location=await session.rpc.permissions.locations.resolve({workingDirectory:process.cwd()});
 if(location.locationKey!==process.cwd())throw new Error("Fixture consent escaped its directory");
 const result=await session.rpc.permissions.locations.addToolApproval({locationKey:location.locationKey,approval:{kind:"extension-permission-access",extensionName:"plugin:agent-phonon:peer-context"}});
 if(result.success!==true)throw new Error("Native fixture consent was not persisted");
 ${approveCoordination?'if((await session.rpc.permissions.locations.addToolApproval({locationKey:location.locationKey,approval:{kind:"custom-tool",toolName:"phonon_project_coordination"}})).success!==true)throw new Error("Native fixture tool consent unavailable");':''}
 await session.disconnect();session=undefined;await client.deleteSession(${JSON.stringify(sessionId)});
}catch(error){process.stderr.write(String(error)+"\\n");process.exitCode=1;}
finally{if(session)await session.disconnect();const errors=await client.stop();if(errors.length)process.exitCode=1;}
`, { mode: 0o600 });
  const native = spawnSupervisedAgent(process.execPath, [runner], { cwd, env: environment });
  scope.watch(native.child, true); scope.defer(() => native.terminate());
  let stderr = ""; native.child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); }); native.child.stdout.resume();
  const timer = setTimeout(() => { void native.terminate(); }, 10000); scope.defer(() => clearTimeout(timer));
  const code = await new Promise<number | null>((resolve, reject) => { native.child.once("close", resolve); native.child.once("error", reject); });
  clearTimeout(timer); assert.equal(code, 0, stderr);
}

for (const mode of ["initial", "inflight", "child", "denied", "disabled", "disabled-extension", "send", "send-denied", "child-send", "unknown-budget", "headroom"] as const) test(`installed Copilot SessionEngine ${mode}: native admission, original run and quiet delivery`, {
  skip: !process.env.PHONON_TEST_COPILOT_BIN || mode !== "denied" && !process.env.PHONON_TEST_COPILOT_SDK_ROOT, timeout: 40000,
}, () => withPeerFixture("copilot-engine-peer", async scope => {
  const bin = process.env.PHONON_TEST_COPILOT_BIN!, cache = process.env.PHONON_TEST_COPILOT_CACHE_HOME;
  assert.ok(cache && existsSync(join(cache, "pkg")), "Reuse an existing native runtime cache");
  const home = join(scope.root, "home"), copilotHome = join(home, ".copilot"); mkdirSync(copilotHome, { recursive: true });
  const store = new PhononStore(join(scope.root, "phonon.sqlite")); scope.defer(() => store.close());
  const adapter = new CopilotAdapter({ env: { binPath: bin, defaultModel: "gpt-4.1", peerContext: true } });
  const create = adapter.createSession.bind(adapter); let session: AdapterSession | undefined;const bindings:unknown[]=[],nativeEvents:string[]=[];
  adapter.createSession = async params => {
    session = await create(params); const send = session.send.bind(session);
    session.send = async (input, options) => { const pending = send(input, options);
      let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});const deadline=Date.now()+5000;
      while(!(session as unknown as {current?:ProcessSupervisor}).current&&!settled&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
      scope.watch((session as unknown as { current?: { child: ChildProcess } }).current?.child, true);
      const asset=(session as unknown as {peer?:{path:string}}).peer;
      if(asset){const capsule=JSON.parse(readFileSync(join(asset.path,"extensions","peer-context","channel.json"),"utf8"));bindings.push({hasCallback:!!options.projectCoordination,hasNativeChannel:!!capsule.coordination,runnerHasTool:readFileSync(join(asset.path,"extensions","peer-context","bridge.mjs"),"utf8").includes("parameters:coordinationSchema")});}
      let buffer="";const child=(session as unknown as {current?:{child:ChildProcess}}).current?.child;
      child?.stdout?.on("data",chunk=>{buffer+=String(chunk);let nl:number;while((nl=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);try{const event=JSON.parse(line);if(!event.type?.startsWith("model.")&&nativeEvents.length<256)nativeEvents.push(event.type);}catch{}}});
      await pending; };
    return session;
  };
  const registry = new AdapterRegistry(); registry.register(adapter);
  const tc = new TestConn({ registry, store, workspaceRoot: scope.root, tenantId: "owner",archiveAuthority:"https://copilot.fixture" }); scope.defer(() => tc.conn.dispose());
  const project = (await tc.call("project.create", { name: "copilot-native", git: false }) as any).project;
  const inputPath = join(project.path, "input.txt"), fileText = "ACTUAL_COPILOT_FILE_" + randomUUID(); writeFileSync(inputPath, fileText);
  const nativeOptions = { model: "gpt-4.1", experimental: mode !== "disabled", ...(mode === "disabled-extension" ? { extensions: { mode: "disabled" } } : {}) };
  writeFileSync(join(copilotHome, "settings.json"), JSON.stringify(nativeOptions));
  writeFileSync(join(copilotHome, "config.json"), JSON.stringify({ ...nativeOptions, trustedFolders: [project.path] }));
  const unavailable = ["denied", "disabled", "disabled-extension"].includes(mode);
  const marker = "COPILOT_ENGINE_PEER_" + randomUUID(); let pending = mode === "initial" || unavailable || mode==="unknown-budget" || mode==="headroom";
  const self = { id: randomUUID(), position: "1", projectId: randomUUID(), ownerId: "owner", deviceId: randomUUID(), agentId: "copilot", agentKind: "agent", sourceKind: "native",
    sessionId: "unbound", label: "Copilot", activity: { summary: "", phase: "working", impact: [], dependencies: "" }, activityRevision: 0, lastSeenAt: null, presence: "active" };
  const message = { id: randomUUID(), position: "2", senderId: randomUUID(), recipientId: self.id, kind: "notice", text: marker, references: [], inReplyTo: null,
    depth: 0, createdAt: null, expiresAt: null, state: "stored", receivedAt: null };
  const outgoing={operation:"send",requestId:randomUUID(),recipientId:randomUUID(),kind:"notice",text:"SYNTHETIC_IMPACT_"+randomUUID()};
  const evidenceReports:any[]=[];
  tc.setRequestResponder("project.coordination.evidence",raw=>{const input=raw as any;evidenceReports.push(input);return {version:1,receipts:input.reports.map((report:any)=>({deliveryId:report.deliveryId,status:"recorded",state:report.state}))};});
  const calls: string[] = [],receiveReports:any[]=[]; tc.setRequestResponder("project.coordination", raw => {
    const request = raw as any; calls.push(request.action.operation); self.sessionId = request.sessionId;
    if(request.receive)receiveReports.push(request.receive);
    if(request.action.operation==="send"){
      assert.deepEqual(request.action,{...outgoing,references:[]});
      return {self,status:"recorded",requestId:outgoing.requestId,message:{...message,id:randomUUID(),senderId:self.id,recipientId:outgoing.recipientId,text:outgoing.text}};
    }
    return request.action.operation === "peers" ? { self, participants: [], next: null }
      : { self, messages: pending ? [message] : [], next: null,...(request.receive?{receiveReporting:1,evidenceVersion:1}:{}),
        ...(request.evidenceVersion&&pending?{deliveryOffers:[{messageId:message.id,deliveryId:message.id}]}:{}) };
  });
  const requests: any[] = [], errors: unknown[] = [], readiness: unknown[] = [];
  const provider = createServer((req, res) => { void (async () => {
    if (req.method !== "POST") { req.resume(); res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}'); return; }
    let body = ""; for await (const chunk of req) body += String(chunk); const payload = JSON.parse(body); requests.push(payload);
    readiness.push(session?.peerContextCapability?.());
    assert.ok(requests.length <= 5, "Controlled native test must not loop");
    const useTool = ["initial", "inflight", "child", "send", "send-denied", "child-send", "unknown-budget", "headroom"].includes(mode) && requests.length === 1 || ["child","child-send"].includes(mode) && requests.length === 2;
    const tool = ["child","child-send"].includes(mode) && requests.length === 1 ? "task" : ["send","send-denied","child-send"].includes(mode)?"phonon_project_coordination":"view";
    const args = tool === "task" ? { name: "fixture-reader", agent_type: "general-purpose", model: "gpt-4.1", description: "Read fixture", prompt: "Read the input fixture and report its bytes" } : tool==="view"?{ path: inputPath }:outgoing;
    if (useTool) { assert.ok(payload.tools.some((item: any) => item.function?.name === tool),JSON.stringify(payload.tools.map((item:any)=>item.function?.name))); if(["child","inflight"].includes(mode))pending = true; }
    if(requests.length===2&&mode==="send")assert.ok(JSON.stringify(payload).includes(outgoing.requestId),"Native confirmed send receipt must reach the original continuation");
    const message = useTool ? { role: "assistant", content: null, tool_calls: [{ id: tool === "task" ? "owned-task" : "owned-read", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "Original Copilot assigned work complete" };
    const finish = useTool ? "tool_calls" : "stop";
    if (payload.stream !== true) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "controlled", object: "chat.completion", model: payload.model,
      choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: any, finish_reason: string | null) => res.write("data: " + JSON.stringify({ id: "controlled", object: "chat.completion.chunk", model: payload.model,
      choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
    send(useTool ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : message, null); send({}, finish); res.end("data: [DONE]\n\n");
  })().catch(error => { errors.push(error); res.destroy(); }); });
  scope.defer(() => closePeerServer(provider)); await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const environment: Record<string, string> = { PATH: process.env.PATH!, HOME: home, USERPROFILE: home, COPILOT_HOME: copilotHome, COPILOT_CACHE_HOME: cache,
    TMPDIR: scope.root, TMP: scope.root, TEMP: scope.root, COPILOT_OFFLINE: "true", COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_WIRE_API: "completions",
    COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, COPILOT_PROVIDER_API_KEY: "controlled-local-key", COPILOT_MODEL: "gpt-4.1",
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:mode==="unknown-budget"?"":mode==="headroom"?"55000":"4096",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" };
  if (mode !== "denied") await grantFixtureExtension(scope, project.path, environment,["send","child-send"].includes(mode));
  assert.equal(requests.length, 0, "Fixture native consent must not execute inference");
  // This worker's isolated environment is restored even when workflow assertions fail.
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, environment);
  scope.defer(() => tc.conn.dispose());
  const run = await tc.call("workflow.run", { project: project.projectId, metadata: { native_chat: true, native_run_id: randomUUID() }, plan: { mode: "dag",
    nodes: [{ nodeId: "reply", agent: "copilot", model: "gpt-4.1", input: "Complete the original assigned task" }], finalNodeId: "reply" } }) as any;
  let terminal: any,waitingSince=0;
  for (let n = 0; n < 800; n++) {
    terminal = await tc.call("workflow.status", { workflowId: run.workflowId });
    if (["completed", "failed"].includes(terminal.status)) break;
    if(mode==="send-denied"&&nativeEvents.includes("tool.execution_start")){
      waitingSince ||= Date.now();if(Date.now()-waitingSince>=300)break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const records = store.peerContextJournal().records("owner", self.sessionId);
  const logs = existsSync(join(copilotHome, "logs")) ? readdirSync(join(copilotHome, "logs"), { recursive: true }).filter(name => String(name).endsWith(".log"))
    .flatMap(name => readFileSync(join(copilotHome, "logs", String(name)), "utf8").split("\n").filter(line => /extension.*(denied|failed|error)/i.test(line)).map(line => line.slice(0, 700))).slice(-4) : [];
  const diagnostic = JSON.stringify({ terminal, errors: errors.map(String), calls,bindings,nativeEvents, readiness, logs, requests: requests.map(payload => ({ hasPeer: JSON.stringify(payload).includes(marker) })), records });
  if(mode==="send-denied"){
    assert.deepEqual(errors,[],diagnostic);assert.ok(nativeEvents.includes("tool.execution_start"),diagnostic);
    // Native CLI does not forward a permission.requested event for this pending extension call.
    // The isolated fixture has no custom-tool approval; do not invent a prompt or a decision.
    assert.equal(nativeEvents.includes("tool.execution_complete"),false,diagnostic);
    assert.equal(terminal?.status,"running",diagnostic);assert.equal(requests.length,1,diagnostic);
    assert.equal(calls.includes("send"),false,diagnostic);assert.deepEqual(records,[],diagnostic);
    await tc.conn.dispose();assert.equal(calls.includes("send"),false);return;
  }
  assert.deepEqual(errors, [], diagnostic); assert.equal(terminal?.status, "completed", diagnostic);
  assert.ok(readiness.every(value => (value as { readiness?: string })?.readiness === (unavailable ? "pending" : "ready")), diagnostic);
  assert.equal(receiveReports[0]?.mode,"runtime_pending",diagnostic);
  assert.equal(receiveReports.at(-1)?.mode,unavailable?"runtime_pending":"runtime_checkpoint",diagnostic);
  assert.ok(receiveReports.every(report=>["runtime_pending","runtime_checkpoint"].includes(report.mode)&&report.evidence==="context_hook"),diagnostic);
  assert.ok(tc.streamEvents.some(event => (event as any).type === "result" && (event as any).text === "Original Copilot assigned work complete"), diagnostic);
  assert.equal(JSON.stringify(tc.streamEvents.filter(event => ["message", "result", "error"].includes((event as any).type))).includes(marker), false, diagnostic);
  if (mode === "initial" || mode === "inflight" || mode === "child") {
    assert.deepEqual(requests.map(payload => JSON.stringify(payload).includes(marker)), mode === "child" ? [false, false, false, true] : [false, true], diagnostic);
    assert.equal(records.length, 1, diagnostic); assert.equal(records[0]!.state, "context_hook", diagnostic);
    assert.equal(records[0]!.nativeSessionId, (session as unknown as { nativeSessionId: string }).nativeSessionId, diagnostic);
    for(let n=0;n<100&&!evidenceReports.some(call=>call.reports.some((report:any)=>report.state==="context_hook"));n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(evidenceReports.some(call=>call.reports.some((report:any)=>report.state==="context_hook")),diagnostic);
    assert.equal(JSON.stringify(requests).includes('"deliveryId"'),false,diagnostic);
    if (mode === "inflight") assert.ok(JSON.stringify(requests.at(-1)).includes(fileText), diagnostic);
  } else if(mode==="unknown-budget"||mode==="headroom"){
    assert.equal(requests.length,2,diagnostic);assert.ok(requests.every(payload=>!JSON.stringify(payload).includes(marker)),diagnostic);
    assert.deepEqual(records,[],diagnostic);assert.deepEqual(evidenceReports,[],diagnostic);
    assert.ok(JSON.stringify(requests.at(-1)).includes(fileText),diagnostic);
  } else if(["send","send-denied","child-send"].includes(mode)){
    assert.equal(calls.filter(operation=>operation==="send").length,mode==="send"?1:0,diagnostic);
    assert.equal(requests.length,mode==="child-send"?4:2,diagnostic);assert.deepEqual(records,[],diagnostic);
    assert.equal(JSON.stringify(tc.streamEvents.filter(event=>["message","result"].includes(String(event.type)))).includes(outgoing.text),false,diagnostic);
  } else {
    assert.equal(requests.length, 1, diagnostic); assert.equal(JSON.stringify(requests[0]).includes(marker),false,diagnostic);
    assert.deepEqual(records, [], diagnostic);
  }
  assert.equal(readFileSync(inputPath, "utf8"), fileText);
}));

for(const phase of ["insert","engine","revoked","closed","child","resume","denied","headroom","unknown-budget","stop"] as const)
  test(`installed Copilot current-turn ${phase} preserves the original native task`,{
    skip:!process.env.PHONON_TEST_COPILOT_BIN||!process.env.PHONON_TEST_COPILOT_SDK_ROOT,timeout:45000,
  },()=>withPeerFixture("copilot-steering",async scope=>{
    const cache=process.env.PHONON_TEST_COPILOT_CACHE_HOME;assert.ok(cache&&existsSync(join(cache,"pkg")));
    const home=join(scope.root,"home"),copilotHome=join(home,".copilot");mkdirSync(copilotHome,{recursive:true});
    const nativeSettings={model:"gpt-4.1",experimental:true,trustedFolders:[scope.root]};
    writeFileSync(join(copilotHome,"config.json"),JSON.stringify(nativeSettings));
    writeFileSync(join(copilotHome,"settings.json"),JSON.stringify(nativeSettings));
    writeFileSync(join(scope.root,"input.txt"),"Original Copilot native file bytes\n");
    const marker="CURRENT_COPILOT_"+randomUUID(),payloads:any[]=[],auxiliaries:any[]=[],errors:unknown[]=[],events:any[]=[],abort=new AbortController();
    let session:AdapterSession|undefined,engine:SessionEngine|undefined,engineId:string|undefined,insertion:Promise<unknown>|undefined,ack:any,accepted=false,authorityChecks=0,raw="";
    const provider=createServer((req,res)=>{void(async()=>{
      if(req.method!=="POST"){req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end('{"data":[]}');return;}
      let body="";for await(const chunk of req)body+=String(chunk);const payload=JSON.parse(body);
      if(!payload.tools?.some((tool:any)=>tool.function?.name==="view")){
        auxiliaries.push({model:payload.model,stream:payload.stream});assert.ok(auxiliaries.length<=4,"native auxiliary requests remain bounded");
        if(!payload.stream){res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({id:"helper",object:"chat.completion",model:payload.model,
          choices:[{index:0,message:{role:"assistant",content:"Controlled native helper"},finish_reason:"stop"}]}));return;}
        res.writeHead(200,{"Content-Type":"text/event-stream"});
        for(const[delta,finish_reason]of [[{role:"assistant",content:"Controlled native helper"},null],[{},"stop"]])res.write("data: "+JSON.stringify({id:"helper",object:"chat.completion.chunk",model:payload.model,choices:[{index:0,delta,finish_reason}]})+"\n\n");
        res.end("data: [DONE]\n\n");return;
      }
      const index=payloads.push(payload);
      assert.ok(index<=(phase==="child"?4:phase==="resume"?3:2),"insertion must not schedule another native task");
      const receives=["insert","engine","child","resume"].includes(phase)&&index===(phase==="child"?4:2);
      assert.equal(body.includes(marker),receives||phase==="resume"&&index===3,"only the original root continuation may receive input");
      if(index===1){
        assert.ok(session);
        insertion=engine?engine.send("owner",engineId!,marker,{turnId:"original",expectedActiveTurnId:"original",whenBusy:"inject"}).then(value=>{ack=value;}):
          session.insertAtToolGap!(marker,{turnId:"original",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]),
            ...(phase==="revoked"?{beforeApply(){if(++authorityChecks>1)throw new Error("Original source withdrawn before native application");}}:{})});
        void insertion.then(()=>{accepted=true;},()=>{});
        if(phase==="stop"){void session.interrupt!();return;}
      }
      const useTool=phase!=="closed"&&(index===1||phase==="child"&&index===2),tool=phase==="child"&&index===1?"task":"view";
      const args=tool==="task"?{name:"fixture-reader",agent_type:"general-purpose",model:"gpt-4.1",description:"Read fixture",prompt:"Read input.txt once and finish"}:{path:join(scope.root,"input.txt")};
      if(useTool)assert.ok(payload.tools.some((item:any)=>item.function?.name===tool));
      const message=useTool?{role:"assistant",content:null,tool_calls:[{id:"read_"+index,type:"function",function:{name:tool,arguments:JSON.stringify(args)}}]}:
        {role:"assistant",content:"Original Copilot task complete"};
      if(!payload.stream){
        if(receives){await insertion;assert.equal(accepted,true);assert.equal(events.some(event=>event.final),false);}
        res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({id:"controlled_"+index,object:"chat.completion",model:payload.model,
          choices:[{index:0,message,finish_reason:useTool?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}));return;
      }
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const send=(delta:any,finish_reason:string|null)=>res.write("data: "+JSON.stringify({id:"controlled_"+index,object:"chat.completion.chunk",model:payload.model,
        choices:[{index:0,delta,finish_reason}]})+"\n\n");
      send(useTool?{role:"assistant",tool_calls:[{index:0,...message.tool_calls![0]}]}:message,null);
      if(receives){await insertion;assert.equal(accepted,true);assert.equal(events.some(event=>event.final),false,"input must be accepted before original execution completes");}
      send({},useTool?"tool_calls":"stop");res.end("data: [DONE]\n\n");
    })().catch(error=>{errors.push(error);abort.abort();res.destroy();});});
    scope.defer(()=>closePeerServer(provider));scope.defer(()=>abort.abort());await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
    const environment:Record<string,string>={PATH:process.env.PATH!,HOME:home,USERPROFILE:home,COPILOT_HOME:copilotHome,COPILOT_CACHE_HOME:cache,
      TMPDIR:scope.root,TMP:scope.root,TEMP:scope.root,COPILOT_OFFLINE:"true",COPILOT_PROVIDER_TYPE:"openai",COPILOT_PROVIDER_WIRE_API:"completions",
      COPILOT_PROVIDER_BASE_URL:`http://127.0.0.1:${(provider.address()as{port:number}).port}/v1`,COPILOT_PROVIDER_API_KEY:"controlled-local-key",COPILOT_MODEL:"gpt-4.1",
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS:"64000",COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:phase==="unknown-budget"?"":phase==="headroom"?"55000":"4096",
      HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""};
    const previous=new Map(Object.keys(environment).map(key=>[key,process.env[key]]));
    scope.defer(()=>{for(const[key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}});Object.assign(process.env,environment);
    if(phase!=="denied")await grantFixtureExtension(scope,scope.root,environment);
    const adapter=new CopilotAdapter({env:{binPath:process.env.PHONON_TEST_COPILOT_BIN,defaultModel:"gpt-4.1",peerContext:true}});
    const discovered=await adapter.discoverAgents();assert.equal(discovered[0]!.capabilities.injectMidTurn,true);assert.equal(payloads.length,0,"discovery and fixture consent must not infer");
    // The native CLI owns its startup settings migration; insertion must preserve the settled settings.
    const settingsBefore=readFileSync(join(copilotHome,"settings.json"),"utf8");
    const watch=async()=>{
      const end=Date.now()+10000,finals=events.filter(event=>event.final).length;let runtime:ProcessSupervisor|undefined;
      while(!(runtime=(session as unknown as{current?:ProcessSupervisor})?.current)&&events.filter(event=>event.final).length===finals&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));
      if(!runtime)return;
      const owned=runtime;scope.watch(owned.child,true);scope.defer(async()=>{
        await owned.terminate();const deadline=Date.now()+5000;while(!owned.hasStopped()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
        assert.ok(owned.hasStopped(),"owned Copilot process group must settle before fixture removal");
      });owned.child.stdout.on("data",chunk=>{raw=(raw+String(chunk)).slice(-128000);});
    };
    let run:Promise<unknown>;
    if(phase==="engine"){
      const create=adapter.createSession.bind(adapter);adapter.createSession=async params=>session=await create(params);
      const registry=new AdapterRegistry();registry.register(adapter);let ended!:()=>void;const terminal=new Promise<void>(resolve=>{ended=resolve;});
      engine=new SessionEngine(registry,event=>{events.push(event);if("final"in event&&event.final)ended();});scope.defer(()=>engine?.dispose());
      const owned=await engine.create({tenantId:"owner",project:"native-project",agent:"copilot",model:"gpt-4.1",cwd:scope.root,verbosity:"tools"});engineId=owned.sessionId;
      await assert.rejects(engine.send("foreign",engineId,"unowned",{whenBusy:"inject"}));
      await engine.send("owner",engineId,"Read input.txt once and finish.",{turnId:"original",environment});
      run=(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{
        await Promise.race([terminal,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Original Copilot execution did not settle")),30000);})]);
        await engine!.settleTurn("owner",engineId!,"original");
      }finally{clearTimeout(timer);}})();
    }else{
      session=await adapter.createSession({sessionId:"owned",agentId:"copilot",model:"gpt-4.1",cwd:scope.root});scope.defer(()=>session?.terminate());
      await session.preparePeerContext?.(environment);assert.equal(session.peerContextCapability?.()?.readiness,"pending");
      run=session.send("Read input.txt once and finish.",{turnId:"original",verbosity:"tools",environment,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]),emit:event=>events.push(event)});
    }
    void run.catch(()=>{});await watch();await run;
    assert.deepEqual(errors,[],JSON.stringify({events:events.slice(-5),requests:payloads.map(payload=>({model:payload.model,stream:payload.stream,hasInput:JSON.stringify(payload).includes(marker)})),auxiliaries}));
    assert.equal(events.at(-1)?.status,phase==="stop"?"interrupted":"completed",JSON.stringify(events.at(-1)));
    assert.ok(insertion);
    if(["revoked","closed","denied","headroom","unknown-budget","stop"].includes(phase))await assert.rejects(insertion);else await insertion;
    if(phase==="revoked")assert.equal(authorityChecks,2,"source withdrawal must happen at native authorization, not only admission");
    if(phase==="engine")assert.deepEqual(ack,{turnId:"original",disposition:"injected"});
    if(phase==="resume"){
      await session!.preparePeerContext?.(environment);
      const continued=session!.send("Continue the same native session.",{turnId:"next",verbosity:"tools",environment,signal:AbortSignal.timeout(30000),emit:event=>events.push(event)});
      await watch();await continued;assert.equal(events.at(-1)?.status,"completed");
    }
    const nativeEvents=raw.split("\n").flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
    const results=nativeEvents.filter(event=>event.type==="result");
    if(phase==="stop")assert.ok(results.length<=1);else assert.equal(results.length,phase==="resume"?2:1,"one native result per explicit original input");
    if(phase==="resume")assert.equal(new Set(results.map(event=>event.sessionId)).size,1,"continuation must retain its observed native session");
    assert.equal(nativeEvents.filter(event=>event.type==="user.message").some(event=>event.data?.content?.includes(marker)),false,"insertion is not an extra user prompt");
    assert.equal(readFileSync(join(copilotHome,"settings.json"),"utf8"),settingsBefore);
    assert.equal(readFileSync(join(scope.root,"input.txt"),"utf8"),"Original Copilot native file bytes\n");
  }));

test("installed Copilot resumes the exact native session with a fresh private receive binding", {
  skip: !process.env.PHONON_TEST_COPILOT_BIN || !process.env.PHONON_TEST_COPILOT_SDK_ROOT, timeout: 30000,
}, () => withPeerFixture("copilot-peer-resume", async scope => {
  const cache = process.env.PHONON_TEST_COPILOT_CACHE_HOME; assert.ok(cache && existsSync(join(cache, "pkg")));
  const home = join(scope.root, "home"), copilotHome = join(home, ".copilot"); mkdirSync(copilotHome, { recursive: true });
  writeFileSync(join(copilotHome, "settings.json"), JSON.stringify({ model: "gpt-4.1", experimental: true }));
  writeFileSync(join(copilotHome, "config.json"), JSON.stringify({ model: "gpt-4.1", experimental: true, trustedFolders: [scope.root] }));
  const markers = ["FIRST_PEER_" + randomUUID(), "SECOND_PEER_" + randomUUID()], requests: any[] = [], errors: unknown[] = [];
  const provider = createServer((req, res) => { void (async () => {
    if (req.method !== "POST") { req.resume(); res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}'); return; }
    let body = ""; for await (const chunk of req) body += String(chunk); const payload = JSON.parse(body); requests.push(payload);
    assert.ok(requests.length <= 4, "Native resume must not create extra model runs");
    const first=requests.length%2===1;
    const message = first?{role:"assistant",content:null,tool_calls:[{id:"resume-read-"+requests.length,type:"function",function:{name:"view",arguments:JSON.stringify({path:join(scope.root,"input.txt")})}}]}
      :{ role: "assistant", content: "Turn " + requests.length/2 + " complete" };
    const finish=first?"tool_calls":"stop";
    if (payload.stream !== true) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "controlled", object: "chat.completion", model: payload.model,
      choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [[first?{role:"assistant",tool_calls:[{index:0,...message.tool_calls![0]}]}:message, null], [{}, finish]]) res.write("data: " + JSON.stringify({ id: "controlled", object: "chat.completion.chunk", model: payload.model,
      choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
    res.end("data: [DONE]\n\n");
  })().catch(error => { errors.push(error); res.destroy(); }); });
  scope.defer(() => closePeerServer(provider)); await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(scope.root,"input.txt"),"Actual native resume fixture");
  const environment: Record<string, string> = { PATH: process.env.PATH!, HOME: home, USERPROFILE: home, COPILOT_HOME: copilotHome, COPILOT_CACHE_HOME: cache,
    TMPDIR: scope.root, TMP: scope.root, TEMP: scope.root, COPILOT_OFFLINE: "true", COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_WIRE_API: "completions",
    COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, COPILOT_PROVIDER_API_KEY: "controlled-local-key", COPILOT_MODEL: "gpt-4.1",
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:"4096",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  scope.defer(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, environment);
  await grantFixtureExtension(scope, scope.root, environment); assert.equal(requests.length, 0);
  const adapter = new CopilotAdapter({ env: { binPath: process.env.PHONON_TEST_COPILOT_BIN, defaultModel: "gpt-4.1", peerContext: true } });
  const session = await adapter.createSession({ sessionId: "native-resume-owned", agentId: "copilot", model: "gpt-4.1", cwd: scope.root }); scope.defer(() => session.terminate());
  const nativeIds: string[] = [], observations: any[] = [], events: any[] = [];
  let oldEnvironment: Record<string, string> | undefined;
  for (let turn = 0; turn < 2; turn++) {
    let offered = false; const messageId = randomUUID();
    const bridge = new PeerContextBridge({ prepare: async boundary => {
      const capability = session.peerContextCapability?.(); assert.equal(capability?.readiness, "ready");
      assert.equal(boundary.nativeSessionId, capability?.nativeSessionId);
      const messages = offered||boundary.budget?.state!=="known" ? [] : [{ messageId, content: "[Untrusted peer observation] " + markers[turn] }];
      if(messages.length){nativeIds.push(boundary.nativeSessionId);offered = true;}
      return { ...boundary, messages, deferred: [] };
    }, observe: value => { observations.push(value); } });
    scope.defer(() => bridge.close()); const channel = await bridge.listen();
    await session.preparePeerContext?.(environment); assert.equal(session.peerContextCapability?.()?.readiness, "pending");
    if (oldEnvironment) {
      let status: number | undefined;
      try { status = (await fetch(oldEnvironment.AGENT_PHONON_PEER_CONTEXT_URL!, { method: "POST", headers: { authorization: "Bearer " + oldEnvironment.AGENT_PHONON_PEER_CONTEXT_TOKEN }, body: "{}" })).status; } catch { /* Closed native turn. */ }
      assert.notEqual(status, 200);
    }
    const run = session.send("Original task turn " + (turn + 1), { turnId: "turn-" + turn, verbosity: "tools", emit: event => events.push(event), environment: { ...environment, ...channel },
      peerContext: { prepare: async () => { throw new Error("Use private native bridge"); }, observe: () => {} } });
    scope.watch((session as unknown as { current?: { child: ChildProcess } }).current?.child, true); await run;
    assert.equal(events.at(-1).status, "completed", JSON.stringify(events.at(-1))); assert.equal(events.at(-1).text, "Turn " + (turn + 1) + " complete");
    assert.equal(JSON.stringify(requests[turn*2]).includes(markers[turn]!),false);
    assert.ok(JSON.stringify(requests[turn*2+1]).includes(markers[turn]!));
    await bridge.close(); oldEnvironment = channel;
  }
  assert.deepEqual(errors, []); assert.equal(requests.length, 4);
  assert.equal(nativeIds.length,2);assert.equal(new Set(nativeIds).size, 1);
  assert.equal(observations.length, 2); assert.ok(observations.every(value => value.evidence === "context_hook"));
  assert.equal(JSON.stringify(events.filter(event => event.type === "message" || event.type === "result")).includes(markers[0]!), false);
  assert.equal(JSON.stringify(events.filter(event => event.type === "message" || event.type === "result")).includes(markers[1]!), false);
}));
