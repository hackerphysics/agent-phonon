import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PeerContextJournal, PeerContextReceiver } from "../peer-context.js";
import { PeerContextBridge } from "../peer-context-bridge.js";
import { HERMES_PEER_CONTEXT_BRIDGE, hermesPeerContextEnvironment, hermesPeerContextSupported } from "./hermes-peer-context.js";
import { hermesCommand } from "./hermes-command.js";
import { HermesAdapter } from "./hermes.js";
import { withPeerFixture, closePeerServer } from "../testing/peer-fixture.js";

const execFile = promisify(execFileCallback);
const MOCK_NATIVE = String.raw`
import types, importlib.metadata
installed_version = importlib.metadata.version
importlib.metadata.version = lambda name: os.environ.get("PEER_TEST_VERSION", "0.21.1") if name == "hermes-agent" else installed_version(name)
class Handle:
    def __init__(self, items, value): self.items=items; self.value=value; self.active=True
    def dispose(self):
        if self.active:
            self.active=False
            self.items.remove(self.value)
class Manager:
    def __init__(self): self.callbacks={}
    def discover_and_load(self): pass
    def list_plugins(self): return []
manager=Manager()
class PluginContext:
    def __init__(self, manifest, manager): self.manager=manager
    def register_middleware(self, kind, callback):
        items=self.manager.callbacks.setdefault(kind,[]); items.append(callback)
        return Handle(items,callback)
class PluginManifest:
    def __init__(self,**kwargs): pass
def apply(request,**context):
    current=copy.deepcopy(request)
    for callback in list(manager.callbacks.get('llm_request',[])):
        result=callback(request=copy.deepcopy(current),**context)
        if result: current=result['request']
    return SimpleNamespace(payload=current)
def execute(request,next_call,**context):
    callbacks=list(manager.callbacks.get('llm_execution',[]))
    def run(index,value):
        if index==len(callbacks): return next_call(value)
        return callbacks[index](request=value,next_call=lambda changed:run(index+1,changed),**context)
    return run(0,request)
plugins=types.ModuleType('hermes_cli.plugins')
plugins.PluginContext=PluginContext; plugins.PluginManifest=PluginManifest; plugins.get_plugin_manager=lambda:manager
middleware=types.ModuleType('hermes_cli.middleware')
middleware.VALID_MIDDLEWARE={'llm_request','llm_execution'}
middleware.apply_llm_request_middleware=apply;middleware.run_llm_execution_middleware=execute
sys.modules['hermes_cli']=types.ModuleType('hermes_cli')
sys.modules['hermes_cli.plugins']=plugins;sys.modules['hermes_cli.middleware']=middleware
`;

function script(mock: boolean) {
  return String.raw`
import os,sys,json,threading,copy
from types import SimpleNamespace
def emit(value): print(json.dumps(value),flush=True)
${mock ? MOCK_NATIVE : ""}
${HERMES_PEER_CONTEXT_BRIDGE}
from hermes_cli.middleware import apply_llm_request_middleware,run_llm_execution_middleware
root_invocations=1
native_mode=os.environ.get('PEER_TEST_MODE','chat_completions')
root_agent=SimpleNamespace(session_id='native-root',model='fixture-model',base_url='http://owned.invalid/v1',context_compressor=SimpleNamespace(model='fixture-model',base_url='http://owned.invalid/v1',api_mode=native_mode,context_length=128000),api_mode=native_mode)
close=_phonon_install_peer_context(root_agent)
mode=root_agent.api_mode
field='input' if mode=='codex_responses' else 'messages'
request={field:[{'role':'user','content':'original authorized task'}],'max_tokens':2000,'model':'fixture-model'}
original=copy.deepcopy(request)
context={'session_id':'native-root','api_request_id':'first-request','api_mode':mode,'model':'fixture-model','base_url':'http://owned.invalid/v1'}
prepared=apply_llm_request_middleware(request,**context).payload
assert prepared==original
count=[0]
def first(payload): count[0]+=1; return {'original':True}
assert run_llm_execution_middleware(prepared,first,**context)=={'original':True}
from urllib.request import build_opener,ProxyHandler,Request
control=os.environ['PEER_TEST_CONTROL']
build_opener(ProxyHandler({})).open(Request(control,data=b'{}',method='POST'),timeout=3).close()
context['api_request_id']='next-request'
for value in (None, 0, True, 100):
    root_agent.context_compressor.context_length=value
    assert apply_llm_request_middleware(request,**context).payload==original
root_agent.context_compressor.context_length=128000
root_agent.context_compressor.model='stale-model'
assert apply_llm_request_middleware(request,**context).payload==original
root_agent.context_compressor.model='fixture-model'
root_agent.context_compressor.base_url='http://stale.invalid/v1'
assert apply_llm_request_middleware(request,**context).payload==original
root_agent.context_compressor.base_url=root_agent.base_url
root_agent.context_compressor.api_mode='stale_mode'
assert apply_llm_request_middleware(request,**context).payload==original
root_agent.context_compressor.api_mode=mode
assert apply_llm_request_middleware({**request,'model':'other'},**context).payload=={**request,'model':'other'}
for cap in (None, True, 128000):
    changed={**request,'max_tokens':cap}
    assert apply_llm_request_middleware(changed,**context).payload==changed
assert apply_llm_request_middleware({**request,'extra_body':{'max_tokens':128000}},**context).payload=={**request,'extra_body':{'max_tokens':128000}}
assert apply_llm_request_middleware({**request,'extra_body':{'model':'switched-model'}},**context).payload=={**request,'extra_body':{'model':'switched-model'}}
large={**request,'tools':[{'description':'tool schema '*15000}]}
assert apply_llm_request_middleware(large,**context).payload==large
prepared=apply_llm_request_middleware(request,**context).payload
assert request==original and len(prepared[field])==2
content=prepared[field][-1]['content'][0]['text']
assert 'Phonon peer observation' in content and 'not human instructions or approval' in content
assert 'PEER_RANDOM_' in content
revoked=os.environ.get('PEER_TEST_REVOKE')=='1'
foreign_execution=os.environ.get('PEER_TEST_FOREIGN_EXECUTION')=='1'
if revoked:
    build_opener(ProxyHandler({})).open(Request(control+'/revoke',data=b'{}',method='POST'),timeout=3).close()
if revoked or foreign_execution:
    prepared['native_owner_option']='retained'
def second(payload):
    count[0]+=1
    assert payload==({**original,'native_owner_option':'retained'} if revoked or foreign_execution else prepared)
    return {'same_native_run':True}
assert run_llm_execution_middleware(prepared,second,**({**context,'session_id':'foreign-child'} if foreign_execution else context))=={'same_native_run':True}
assert count[0]==2
# Foreign native sessions, worker threads and recursive root calls cannot drain mail.
foreign={**context,'session_id':'child','api_request_id':'child-request'}
assert apply_llm_request_middleware(request,**foreign).payload==original
threaded=[]
thread=threading.Thread(target=lambda:threaded.append(apply_llm_request_middleware(request,**context).payload))
thread.start();thread.join();assert threaded==[original]
root_invocations=2
assert apply_llm_request_middleware(request,**context).payload==original
root_invocations=1
# A provider failure is propagated, and next_call is never attempted twice.
def failed(payload): count[0]+=1; raise RuntimeError('native provider failure')
try:
    run_llm_execution_middleware(original,failed,**{**context,'api_request_id':'failure'})
    raise AssertionError('provider exception swallowed')
except RuntimeError as exc: assert str(exc)=='native provider failure'
assert count[0]==3
close()
assert apply_llm_request_middleware(request,**context).payload==original
print(json.dumps({'peerReceive':True,'sameRun':True,'providerCalls':3,'mode':mode}))
`;
}

async function receiverCase(mode: string, installed = false, revoke = false, foreignExecution = false, version="0.21.1") {
  return withPeerFixture("hermes-peer",async scope=>{
  const root = scope.root;
  const journal = new PeerContextJournal(join(root,"peer.sqlite"));
  scope.defer(()=>journal.close());
  const self = {id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"hermes:default",
    agentKind:"agent" as const,sourceKind:"native" as const,sessionId:"owned",label:"root",activity:{summary:"",phase:"working" as const,impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active" as const};
  const message = {id:randomUUID(),position:"2",senderId:randomUUID(),recipientId:self.id,kind:"notice" as const,text:"PEER_RANDOM_"+randomUUID(),references:[],inReplyTo:null,depth:0,createdAt:null,expiresAt:null,state:"stored" as const,receivedAt:null};
  let pending = false, inbox = 0, revoked = false;
  const receiver = new PeerContextReceiver({tenantId:"owner",sessionId:"owned",turnId:"turn",runId:randomUUID(),nativeSessionId:"native-root",journal,active:()=>scope.active&&!revoked,
    coordinate:async input=>{assert.equal(input.operation,"inbox");inbox++;return {self,messages:pending?[message]:[],next:null};}});
  const bridge = new PeerContextBridge(receiver);scope.defer(()=>bridge.close());const environment=await bridge.listen();
  const {createServer} = await import("node:http");
  const control = createServer((req,res)=>{req.resume();if(req.url==="/revoke")revoked=true;else pending=true;res.writeHead(200).end("{}");});
  scope.defer(()=>closePeerServer(control));
  await new Promise<void>(resolve=>control.listen(0,"127.0.0.1",resolve));
  const controlUrl = `http://127.0.0.1:${(control.address() as {port:number}).port}`;
  writeFileSync(join(root,"config.yaml"),"model:\n  default: \"\"\nplugins:\n  enabled: []\n  disabled: []\n",{mode:0o600});
  const python = installed ? hermesCommand(process.env.PHONON_TEST_HERMES_BIN!).python
    : process.env.PHONON_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const capsule = hermesPeerContextEnvironment({environment,peerContext:receiver});
  try {
    const run = execFile(python,["-B","-c",script(!installed)],{cwd:root,timeout:30000,maxBuffer:1024*1024,
      env:{PATH:process.env.PATH,HOME:root,HERMES_HOME:root,TMPDIR:root,TMP:root,TEMP:root,PYTHONDONTWRITEBYTECODE:"1",LITELLM_LOCAL_MODEL_COST_MAP:"True",...capsule,PEER_TEST_CONTROL:controlUrl,PEER_TEST_MODE:mode,PEER_TEST_REVOKE:revoke?"1":"0",PEER_TEST_FOREIGN_EXECUTION:foreignExecution?"1":"0",PEER_TEST_VERSION:version}});
    scope.watch(run.child);scope.defer(async()=>{if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill("SIGTERM");await run.catch(()=>{});});
    const result=await run;
    assert.ok(result.stdout.includes('"peerReceive": true'),result.stderr);
    assert.equal(result.stdout.includes(message.text),false);
    assert.equal(result.stderr.includes(environment.AGENT_PHONON_PEER_CONTEXT_TOKEN!),false);
    assert.equal(result.stdout.includes(environment.AGENT_PHONON_PEER_CONTEXT_TOKEN!),false);
    assert.equal(journal.records("owner","owned")[0]?.state,revoke||foreignExecution?"offered":"provider_payload");
    assert.equal(inbox,16,"invalid or low native budgets are deferred; foreign and worker callbacks never reach the receiver");
  } finally {
    await bridge.close(); await closePeerServer(control);
  }
  });
}

for (const mode of ["chat_completions","anthropic_messages","codex_responses"]) {
  test(`Hermes ${mode} middleware receives at the next request without changing native history or replaying the provider`,()=>receiverCase(mode));
  test(`Hermes ${mode} withdraws revoked input before the original provider call without removing native options`,()=>receiverCase(mode,false,true));
  test(`Hermes ${mode} withdraws parent input from a mismatched native execution`,()=>receiverCase(mode,false,false,true));
}
test("installed Hermes middleware dispatch accepts the scoped receive bridge without inference",{skip:!process.env.PHONON_TEST_HERMES_BIN,timeout:35000},()=>receiverCase("chat_completions",true));

for(const version of ["0.21.2","0.22.0","1.0.0"])test(`Hermes minimum version preserves middleware delivery after upgrade to ${version}`,
  ()=>receiverCase("chat_completions",false,false,false,version));

test("Hermes peer capability cannot be enabled by environment alone and refuses foreign endpoint credentials",async()=>{
  const options={environment:{AGENT_PHONON_PEER_CONTEXT_URL:"http://127.0.0.1:4318/peer-context",AGENT_PHONON_PEER_CONTEXT_TOKEN:"x".repeat(43)}};
  assert.equal(hermesPeerContextEnvironment(options).PHONON_HERMES_PEER_CONTEXT,"");
  assert.throws(()=>hermesPeerContextEnvironment({...options,peerContext:{} as any,environment:{...options.environment,AGENT_PHONON_PEER_CONTEXT_URL:"https://foreign.invalid/peer-context"}}));
  assert.equal(await hermesPeerContextSupported("/missing/native/hermes"),false);
});

for(const channel of ["peer","insert"] as const)for(const budgetMode of ["known","unknown","exhausted"] as const)test(`installed Hermes native ${channel} ${budgetMode} budget preserves headroom and the original run`,{
  skip:!process.env.PHONON_TEST_HERMES_BIN,timeout:45000,
},()=>withPeerFixture("hermes-native",async scope=>{
  const root=scope.root,journal=new PeerContextJournal(join(root,"peer.sqlite"));scope.defer(()=>journal.close());
  const {createServer}=await import("node:http");
  const payloads:any[]=[],errors:unknown[]=[],events:any[]=[],requests:any[]=[];
  const self={id:randomUUID(),position:"1",projectId:randomUUID(),ownerId:"owner",deviceId:randomUUID(),agentId:"hermes:default",
    agentKind:"agent" as const,sourceKind:"native" as const,sessionId:"hermes-live",label:"root",activity:{summary:"",phase:"working" as const,impact:[],dependencies:""},activityRevision:0,lastSeenAt:null,presence:"active" as const};
  const message={id:randomUUID(),position:"2",senderId:randomUUID(),recipientId:self.id,kind:"notice" as const,text:"PEER_MIDTURN_"+randomUUID(),references:[],inReplyTo:null,depth:0,createdAt:null,expiresAt:null,state:"stored" as const,receivedAt:null};
  let pending=false,session:Awaited<ReturnType<HermesAdapter["createSession"]>>|undefined;
  let insertion:Promise<void>|undefined,insertionState:"pending"|"accepted"|"rejected"="pending";
  const provider=createServer((req,res)=>{
    void(async()=>{
      if(req.method==="GET"){
        req.resume();res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({object:"list",data:[{id:"peer-fixture",object:"model",context_length:128000}]}));return;
      }
      let body="";for await(const chunk of req)body+=String(chunk);
      const payload=JSON.parse(body);
      const names=(payload.tools??[]).map((tool:any)=>tool.function?.name??tool.name);
      requests.push({path:req.url,model:payload.model,names});
      if(!names.includes("read_file")){
        res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({id:"controlled-helper",object:"chat.completion",created:1,model:"peer-fixture",
          choices:[{index:0,message:{role:"assistant",content:"Controlled helper response"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));return;
      }
      payloads.push(payload);
      if(payloads.length>2){res.writeHead(500).end();return;}
      let result;
      if(payloads.length===1){
        assert.equal(body.includes(message.text),false);pending=true;
        if(channel==="insert"){
          insertion=session!.insertAtToolGap!(message.text,{turnId:"turn",signal:AbortSignal.timeout(30000)});
          void insertion.then(()=>{insertionState="accepted";},()=>{insertionState="rejected";});
        }
        const tools=payload.tools??[];assert.ok(tools.some((tool:any)=>tool.function?.name==="read_file"),"real native file tool required");
        result={role:"assistant",content:null,tool_calls:[{id:"native-read",type:"function",function:{name:"read_file",arguments:JSON.stringify({path:join(root,"input.txt")})}}]};
      }else{
        assert.equal(body.includes(message.text),budgetMode==="known","native budget must admit only when request output reservation and headroom are known");
        if(channel==="insert"&&budgetMode==="known")assert.equal(insertionState,"accepted","only the original native provider-payload observation acknowledges input");
        assert.ok(payload.messages.some((item:any)=>item.role==="tool"&&item.tool_call_id==="native-read"));
        result={role:"assistant",content:"Original native task complete"};
      }
      res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({id:"controlled",object:"chat.completion",created:1,model:"peer-fixture",
        choices:[{index:0,message:result,finish_reason:payloads.length===1?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));
    })().catch(error=>{errors.push(error);res.writeHead(500).end();});
  });
  scope.defer(()=>closePeerServer(provider));
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const port=(provider.address() as {port:number}).port;
  writeFileSync(join(root,"config.yaml"),`model:\n  default: peer-fixture\n  provider: custom\n  base_url: http://127.0.0.1:${port}/v1\n  api_key: controlled-local-key\n  api_mode: chat_completions\n  context_length: 128000\n  streaming: false\n${budgetMode!=="unknown"?`custom_providers:\n  - name: peer-fixture\n    base_url: http://127.0.0.1:${port}/v1\n    model: peer-fixture\n    extra_body:\n      max_tokens: ${budgetMode==="known"?2000:127999}\n`:""}agent:\n  max_turns: 4\n  disabled_toolsets: []\ntool_search:\n  enabled: off\nplugins:\n  enabled: []\ndisplay:\n  streaming: false\n`,{mode:0o600});
  writeFileSync(join(root,"input.txt"),"fixture input\n",{mode:0o600});
  const receiver=new PeerContextReceiver({tenantId:"owner",sessionId:self.sessionId,turnId:"turn",runId:randomUUID(),
    nativeSessionId:()=>session?.peerContextCapability?.()?.nativeSessionId,active:()=>scope.active,journal,
    coordinate:async()=>({self,messages:pending?[message]:[],next:null})});
  const budgets:any[]=[];
  const access={prepare:(boundary:Parameters<PeerContextReceiver["prepare"]>[0],signal?:AbortSignal)=>{budgets.push(boundary.budget);return receiver.prepare(boundary,signal);},observe:(value:Parameters<PeerContextReceiver["observe"]>[0])=>receiver.observe(value)};
  const bridge=new PeerContextBridge(access);scope.defer(()=>bridge.close());const environment=channel==="peer"?await bridge.listen():{};
  const originalHome=process.env.HERMES_HOME;process.env.HERMES_HOME=root;
  scope.defer(()=>{if(originalHome===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=originalHome;});
  try{
    const adapter=new HermesAdapter({env:{binPath:process.env.PHONON_TEST_HERMES_BIN!,provider:"custom",toolsets:"file"}});
    session=await adapter.createSession({sessionId:self.sessionId,agentId:"hermes:default",model:"peer-fixture",cwd:root});
    scope.defer(()=>session?.terminate());
    assert.ok(session.peerContextCapability?.(),"installed version must qualify before enabling peer delivery");
    let nativeOut="",nativeErr="";
    const run=session.send("Read input.txt once, then finish the original task.",{turnId:"turn",verbosity:"tools",emit:event=>events.push(event),...(channel==="peer"?{peerContext:access}:{}),signal:AbortSignal.timeout(30000),
      environment:{...environment,HERMES_HOME:root,PYTHONDONTWRITEBYTECODE:"1",LITELLM_LOCAL_MODEL_COST_MAP:"True",HTTP_PROXY:"",HTTPS_PROXY:"",ALL_PROXY:"",http_proxy:"",https_proxy:"",all_proxy:""}});
    const startupDeadline=Date.now()+5000;
    while(!(session as unknown as {current?:unknown}).current&&!events.some(event=>event.final)&&Date.now()<startupDeadline)await new Promise(resolve=>setTimeout(resolve,10));
    const native=(session as unknown as {current?:{child:ChildProcess}}).current?.child;
    scope.watch(native,true);
    native?.stdout?.on("data",chunk=>{nativeOut=(nativeOut+String(chunk)).slice(-16000);});
    native?.stderr?.on("data",chunk=>{nativeErr=(nativeErr+String(chunk)).slice(-20000);});
    await run;
    assert.deepEqual(errors,[]);
    const logsDirectory=join(root,"logs");
    const logs=events.at(-1)?.status==="completed"||!existsSync(logsDirectory)?[]:readdirSync(logsDirectory).filter(name=>name.endsWith(".log")).slice(-2).map(name=>readFileSync(join(logsDirectory,name),"utf8").slice(-12000));
    const diagnostic=JSON.stringify({events,requests,nativeOut,nativeErr,logs}).replaceAll(environment.AGENT_PHONON_PEER_CONTEXT_TOKEN??"no-peer-token","[redacted]");
    assert.equal(events.at(-1)?.status,"completed",diagnostic);
    assert.equal(payloads.length,2,JSON.stringify({requests,events}));
    if(channel==="peer"){
      assert.equal(journal.records("owner",self.sessionId)[0]?.state,budgetMode==="known"?"provider_payload":undefined,JSON.stringify({budgets,requests}));
      assert.ok(budgets.length>=2);assert.ok(budgets.every(budget=>budget?.state===(budgetMode==="unknown"?"unknown":"known")),JSON.stringify(budgets));
    }else{
      assert.ok(insertion,"a real running native task must receive the input attempt");
      if(budgetMode==="known")await insertion;else await assert.rejects(insertion);
      assert.equal(insertionState,budgetMode==="known"?"accepted":"rejected");
      assert.ok(events.every(event=>event.turnId==="turn"),"insertion must not start another task");
      assert.equal(journal.records("owner",self.sessionId).length,0,"ordinary input is not a fabricated peer message");
    }
    assert.equal(JSON.stringify(events).includes(message.text),false,"ephemeral peer context is not a human timeline event");
    assert.equal(events.filter(event=>event.type==="tool_call"&&event.toolName==="read_file").length,1);
  }finally{
    if(originalHome===undefined)delete process.env.HERMES_HOME;else process.env.HERMES_HOME=originalHome;
    await session?.terminate();await bridge.close();await closePeerServer(provider);
  }
}));
