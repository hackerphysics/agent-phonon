import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {execFile as execute,execFileSync} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {hermesNativeToolEnvironment,HERMES_NATIVE_TOOLS_BRIDGE} from "../../core/dist/adapters/hermes-native-tools.js";
import {hermesCommand} from "../../core/dist/adapters/hermes-command.js";
import {AgentInteractionBridge} from "../../core/dist/agent-interaction-bridge.js";
import {HERMES_BRIDGE} from "../../core/dist/adapters/hermes-bridge.js";
import type {SendOptions} from "@agent-phonon/core";

const execFile=promisify(execute);
const token=randomBytes(32).toString("base64url");
const base={AGENT_PHONON_MCP_URL:"http://127.0.0.1:23456/mcp",AGENT_PHONON_INTERACTION_URL:"http://127.0.0.1:23456/interaction",AGENT_PHONON_INTERACTION_TOKEN:token};
const options={turnId:"native",verbosity:"tools",emit(){},requestInteraction:async()=>({requestId:"native",action:"cancel"})} as SendOptions;

test("Hermes rejects a changed native profile before tools or model inference",()=>{
  const prefix=[
    "import sys,types,pathlib",
    "sys.argv=['bridge','/native/hermes']",
    "def module(name,**values):",
    "    value=types.ModuleType(name);value.__dict__.update(values);sys.modules[name]=value",
    "module('hermes_cli')",
    "module('hermes_cli.main',main=lambda:(_ for _ in ()).throw(AssertionError('must not infer')))",
    "module('hermes_cli.config',load_config=lambda:(_ for _ in ()).throw(AssertionError('must not read tool config')))",
    "module('hermes_constants',get_hermes_home=lambda:pathlib.Path('/native/wrong-profile'))",
  ].join("\n");
  let failure:any;
  try{execFileSync("python3",["-c",prefix+"\n"+HERMES_BRIDGE],{encoding:"utf8",timeout:10000,env:{...process.env,PHONON_HERMES_EXPECTED_PROFILE_HOME:"/native/expected-profile",PHONON_HERMES_NATIVE_MCP_CONTEXT:""}});}catch(error){failure=error;}
  assert.equal(failure?.status,2);assert.ok(failure.stdout.includes("profile identity changed before inference"));
  assert.ok(!failure.stderr.includes("must not"));
});

test("Hermes native tools use invocation-only paired capabilities and only supplied controller callbacks",()=>{
  assert.deepEqual(hermesNativeToolEnvironment({...options,requestInteraction:undefined,environment:base}),{PHONON_HERMES_NATIVE_MCP_CONTEXT:""});
  const environment=hermesNativeToolEnvironment({...options,environment:base});
  assert.deepEqual(JSON.parse(environment.PHONON_HERMES_NATIVE_MCP_CONTEXT!),{v:1,url:base.AGENT_PHONON_MCP_URL,interactionUrl:base.AGENT_PHONON_INTERACTION_URL,token,names:["phonon_request_interaction","phonon_acknowledge_interaction"]});
  const message=hermesNativeToolEnvironment({...options,environment:base,conversationMessage:async()=>({status:"not_found",requestId:randomUUID()})});
  assert.deepEqual(JSON.parse(message.PHONON_HERMES_NATIVE_MCP_CONTEXT!).names,["phonon_request_interaction","phonon_acknowledge_interaction","phonon_conversation_message"]);
  assert.ok(!HERMES_NATIVE_TOOLS_BRIDGE.includes(token));
  const coordination=hermesNativeToolEnvironment({...options,requestInteraction:undefined,environment:base,projectCoordination:async()=>({})});
  assert.deepEqual(JSON.parse(coordination.PHONON_HERMES_NATIVE_MCP_CONTEXT!).names,["phonon_project_coordination"]);
  for(const changed of [{AGENT_PHONON_MCP_URL:"https://127.0.0.1:23456/mcp"},{AGENT_PHONON_MCP_URL:"http://localhost:23456/mcp"},{AGENT_PHONON_MCP_URL:"http://127.0.0.1:23457/mcp"},
    {AGENT_PHONON_MCP_URL:"http://127.0.0.1:23456/mcp?next=foreign"},{AGENT_PHONON_INTERACTION_TOKEN:"short"},{AGENT_PHONON_INTERACTION_URL:"http://127.0.0.1:23456/other"}]){
    assert.throws(()=>hermesNativeToolEnvironment({...options,environment:{...base,...changed}}),/verified current-turn/);
  }
});

const mock=String.raw`
import os,sys,json,types
from types import SimpleNamespace
emitted=[]; registered=[]; calls=[]; entries={}; owned=True
def emit(value): emitted.append(value)
def module(name,**attrs):
    value=types.ModuleType(name);value.__dict__.update(attrs);sys.modules[name]=value
    return value
for name in ["agent","tools"]: module(name)
module("utils",env_var_enabled=lambda key:os.environ.get(key,"").lower() in ["1","true"])
module("agent.skill_utils",parse_config_string_list=lambda value:value.split(",") if isinstance(value,str) else (value or []))
module("agent.delegation_context",is_dispatcher_owned_worker_context=lambda:owned)
def native_name(server,name): return "mcp__"+server+"__"+name
def register(servers):
    if os.environ["CASE"]=="discovery": raise RuntimeError("secret="+os.environ["TEST_SECRET"])
    registered.append(list(servers))
    for server,config in servers.items():
        assert config["headers"]["Authorization"]=="Bearer "+os.environ["TEST_SECRET"]
        assert config["tools"]["resources"] is False and config["tools"]["prompts"] is False
        for name in config["tools"]["include"]:
            def original(args,**kwargs):
                calls.append(args);return json.dumps({"result":"native"})
            entries[native_name(server,name)]=SimpleNamespace(toolset="mcp-"+server,handler=original)
    return list(entries)
module("tools.mcp_tool_discovery",register_mcp_servers=register,get_registered_mcp_server_names=lambda:[])
module("tools.mcp_tool_schema",mcp_prefixed_tool_name=native_name)
module("tools.registry",registry=SimpleNamespace(get_entry=lambda name:entries.get(name)))
def refresh(agent,enabled_override=None):
    if enabled_override is not None: agent.enabled_toolsets=enabled_override
def definitions(**kwargs):
    return [] if "mcp-phonon_current_turn" in (kwargs.get("disabled_toolsets") or []) else [{"function":{"name":name}} for name in entries]
module("tools.mcp_tool_agent",refresh_agent_mcp_tools=refresh)
module("model_tools",get_tool_definitions=definitions)
cfg={"agent":{"disabled_toolsets":[]},"security":{"redact_secrets":True},"mcp_servers":{}}
case=os.environ["CASE"]
if case=="disabled": cfg["agent"]["disabled_toolsets"]=["mcp-phonon_current_turn"]
if case=="conflict": cfg["mcp_servers"]["phonon_current_turn"]={"url":"https://existing.invalid"}
before=json.dumps(cfg,sort_keys=True)
exec(__BRIDGE__)
exited=False; refreshed=None; child_denied=None
try:
    _phonon_setup_native_tools(cfg)
    root=SimpleNamespace(enabled_toolsets=["file"],disabled_toolsets=["mcp-phonon_current_turn"] if case=="selection" else [],tools=[],valid_tool_names=set())
    refreshed=_phonon_refresh_native_tools(root)
    if refreshed and entries:
        first=next(iter(entries.values()));first.handler({"operation":"members"})
        owned=False;child_denied="error" in json.loads(first.handler({"operation":"members"}));owned=True
        assert root.disabled_toolsets==[]
        assert root.enabled_toolsets==["file","phonon_current_turn"]
except SystemExit:
    exited=True
assert before==json.dumps(cfg,sort_keys=True)
print(json.dumps({"emitted":emitted,"registered":len(registered),"calls":len(calls),"exited":exited,"refreshed":refreshed,"childDenied":child_denied,"tokenInToolEnv":"AGENT_PHONON_INTERACTION_TOKEN" in os.environ,"capsuleInToolEnv":"PHONON_HERMES_NATIVE_MCP_CONTEXT" in os.environ,"noProxy":os.environ.get("NO_PROXY","")}))
`.replace("__BRIDGE__",JSON.stringify(HERMES_NATIVE_TOOLS_BRIDGE));

function mocked(mode:string,coordinationOnly=false){
  const environment=hermesNativeToolEnvironment({...options,environment:base,...(coordinationOnly?{requestInteraction:undefined,projectCoordination:async()=>({})}:{})});
  const output=execFileSync("python3",["-c",mock],{encoding:"utf8",timeout:10000,env:{...process.env,...base,...environment,CASE:mode,TEST_SECRET:token,NO_PROXY:"example.invalid",HERMES_SAFE_MODE:mode==="safe"?"1":"0"}});
  assert.ok(!output.includes(token));
  return JSON.parse(output);
}
test("Hermes native registration preserves config/filters, withholds tool-shell tokens and denies delegated callers",()=>{
  const value=mocked("normal");
  assert.equal(value.registered,1);assert.equal(value.calls,1);assert.equal(value.refreshed,true);assert.equal(value.childDenied,true);
  assert.equal(value.tokenInToolEnv,false);assert.equal(value.capsuleInToolEnv,false);assert.equal(value.noProxy,"example.invalid,127.0.0.1");
});
test("Hermes native registry accepts coordination alone without installing human or group tools",()=>{
  const value=mocked("normal",true);
  assert.equal(value.registered,1);assert.equal(value.calls,1);assert.equal(value.refreshed,true);assert.equal(value.childDenied,true);
  const names=value.emitted.find((event:any)=>event.type==="hermes_native_tools").names;
  assert.deepEqual(names,["mcp__phonon_current_turn__phonon_project_coordination"]);
});
for(const mode of ["disabled","safe","conflict","discovery","selection"]){
  test("Hermes native tools fail closed without inference for "+mode,()=>{
    const value=mocked(mode);assert.equal(value.calls,0);
    assert.equal(mode==="selection"?value.refreshed===false:value.exited,true);
    if(["disabled","safe","conflict"].includes(mode))assert.equal(value.registered,0);
    assert.equal(value.emitted.at(-1).completed,false);
  });
}

const legacyMock=String.raw`
import os,sys,json,types,threading,contextvars,asyncio,re,ast
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from typing import Callable
import importlib.metadata
case=os.environ["CASE"];emitted=[];entries={};calls=[];registered=[];sent=[]
def emit(value): emitted.append(value)
def module(name,**attrs):
    value=types.ModuleType(name);value.__path__=[];value.__dict__.update(attrs);sys.modules[name]=value
    return value
for name in ["tools","agent"]: module(name)
class LegacyModules:
    def find_spec(self,fullname,path=None,target=None):
        if fullname in {"tools.mcp_tool_discovery","tools.mcp_tool_schema","tools.mcp_tool_agent","agent.delegation_context"}:
            raise ModuleNotFoundError("Absent in installed Hermes 0.16",name=fullname)
sys.meta_path.insert(0,LegacyModules())
module("utils",env_var_enabled=lambda key:os.environ.get(key,"").lower() in ["1","true"])
module("agent.skill_utils") # 0.16 has no parse_config_string_list.
installed_version=importlib.metadata.version
importlib.metadata.version=lambda name:("0.17.0" if case=="unknown-version" else "0.16.0") if name=="hermes-agent" else installed_version(name)
def propagate(target):
    ctx=contextvars.copy_context()
    return lambda *args,**kwargs:ctx.run(target,*args,**kwargs)
def schema(server,tool):
    return {"name":"mcp_"+re.sub(r"[^A-Za-z0-9_]","_",server)+"_"+re.sub(r"[^A-Za-z0-9_]","_",tool.name)}
if os.environ.get("NATIVE_SOURCE"):
    from pathlib import Path
    root=Path(os.environ["NATIVE_SOURCE"])
    def extracted(file,names,scope):
        tree=ast.parse((root/file).read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
        assert len(nodes)==len(names)
        exec(compile(ast.Module(body=nodes,type_ignores=[]),str(root/file),"exec"),scope)
        return scope
    native_schema=extracted("mcp_tool.py",["sanitize_mcp_name_component","_convert_mcp_schema"],{"re":re,"_normalize_mcp_input_schema":lambda value:value})
    schema=native_schema["_convert_mcp_schema"]
    callbacks=lambda:((_ for _ in ()).throw(RuntimeError("no native approval fixture")))
    native_context=extracted("thread_context.py",["propagate_context_to_thread"],{"Callable":Callable,"contextvars":contextvars,"_callback_api":callbacks,"logger":SimpleNamespace(debug=lambda *args,**kwargs:None)})
    propagate=native_context["propagate_context_to_thread"]
module("tools.thread_context",propagate_context_to_thread=propagate)
def register(servers):
    if case=="discovery": raise RuntimeError(os.environ["TEST_SECRET"])
    registered.append(list(servers))
    for server,cfg in servers.items():
        assert cfg["enabled"] is True and cfg["headers"]["Authorization"]=="Bearer "+os.environ["TEST_SECRET"]
        for name in cfg["tools"]["include"]:
            full=schema(server,SimpleNamespace(name=name,description="",inputSchema={"type":"object","properties":{}}))["name"]
            def handler(arguments,**kwargs): calls.append(arguments);return json.dumps({"result":"native"})
            entries[full]=SimpleNamespace(toolset="mcp-"+server,handler=handler)
    return [] if case=="missing-tools" else list(entries)
native=module("tools.mcp_tool",register_mcp_servers=register,_convert_mcp_schema=schema,_lock=threading.RLock(),_servers={},_server_connecting=set())
if case=="connecting-conflict": native._server_connecting.add("phonon_current_turn")
if case=="partial-modern": module("tools.mcp_tool_discovery",register_mcp_servers=register,get_registered_mcp_server_names=lambda:[])
module("tools.registry",registry=SimpleNamespace(get_entry=lambda name:entries.get(name)))
def definitions(**kwargs):
    enabled=kwargs.get("enabled_toolsets")
    assert kwargs["skip_tool_search_assembly"] is True
    if enabled is not None and not set(enabled)&{"all","*","mcp-phonon_current_turn","phonon_current_turn"}: return []
    return [{"type":"function","function":{"name":name}} for name in entries]
module("model_tools",get_tool_definitions=definitions)
if not os.environ.get("REAL_HTTPX"):
    class AsyncClient:
        async def send(self,request,**kwargs): sent.append((str(request.url),kwargs));return SimpleNamespace(status_code=307)
    module("httpx",AsyncClient=AsyncClient)
class Agent:
    def __init__(self):
        self.enabled_toolsets=["hermes-cli"]+([] if case=="unselected" else ["mcp-phonon_current_turn"])
        self.disabled_toolsets=["mcp-phonon_current_turn"] if case=="runtime-disabled" else []
        self.tools=[{"type":"function","function":{"name":"native_memory"}}];self.valid_tool_names={"native_memory"}
    def _execute_tool_calls_sequential(self,operation): return operation()
    def _execute_tool_calls_concurrent(self,operation):
        with ThreadPoolExecutor(max_workers=1) as pool: return pool.submit(propagate(operation)).result()
if case=="missing-scope": Agent._execute_tool_calls_concurrent=None
cfg={"agent":{"disabled_toolsets":[]},"toolsets":["hermes-cli","mcp-phonon_current_turn"],"mcp_servers":{}}
if case=="disabled": cfg["agent"]["disabled_toolsets"]=["mcp"]
if case=="serialized-disabled": cfg["agent"]["disabled_toolsets"]='["mcp-phonon_current_turn"]'
if case=="malformed-policy": cfg["agent"]["disabled_toolsets"]={"mcp":True}
before=json.dumps(cfg,sort_keys=True)
exec(__BRIDGE__)
exited=False;refreshed=None;denials=[];transport=None;agent=Agent();enabled=list(agent.enabled_toolsets)
try:
    _phonon_setup_native_tools(cfg)
    _phonon_install_native_tool_scope(Agent)
    refreshed=_phonon_refresh_native_tools(agent)
    if refreshed:
        invoke=lambda:json.loads(next(iter(entries.values())).handler({"operation":"members"}))
        assert "error" in invoke() # Mere registry access does not own a native turn.
        for method in ["_execute_tool_calls_sequential","_execute_tool_calls_concurrent"]:
            dispatch=getattr(agent,method)
            assert "error" not in dispatch(invoke)
            child=Agent();child._delegate_depth=1
            denials.append("error" in dispatch(lambda:getattr(child,method)(invoke)))
        with ThreadPoolExecutor(max_workers=1) as pool: denials.append("error" in pool.submit(invoke).result())
        snapshot=agent._execute_tool_calls_sequential(contextvars.copy_context)
        _phonon_native_turn_finished(agent)
        denials.append("error" in snapshot.run(invoke))
        assert "native_memory" in agent.valid_tool_names and agent.tools[0]["function"]["name"]=="native_memory"
        assert _phonon_tools_names.issubset(agent.valid_tool_names)
        assert {t["function"]["name"] for t in agent.tools}=={"native_memory"}|_phonon_tools_names
        import httpx
        async def check_transport():
            secret="Bearer "+os.environ["TEST_SECRET"]
            if os.environ.get("REAL_HTTPX"):
                def respond(request): sent.append(str(request.url));return httpx.Response(307,headers={"location":"http://127.0.0.1:23457/stolen"})
                async with httpx.AsyncClient(transport=httpx.MockTransport(respond),follow_redirects=True) as client:
                    response=await client.send(client.build_request("POST",_phonon_tools_context["url"],headers={"Authorization":secret}))
                    assert response.status_code==307 and len(sent)==1
                    try: await client.send(client.build_request("POST","http://127.0.0.1:23457/stolen",headers={"Authorization":secret}))
                    except ValueError: pass
                    else: raise AssertionError("capability must not leave its endpoint")
            else:
                client=httpx.AsyncClient()
                await client.send(SimpleNamespace(url=_phonon_tools_context["url"],headers={"authorization":secret}),follow_redirects=True)
                assert sent[-1][1]["follow_redirects"] is False
                try: await client.send(SimpleNamespace(url="http://127.0.0.1:23457/stolen",headers={"authorization":secret}))
                except ValueError: pass
                else: raise AssertionError("foreign capability request")
                await client.send(SimpleNamespace(url="https://native-provider.invalid",headers={"authorization":"other-native-credential"}),follow_redirects=True)
                assert sent[-1][1]["follow_redirects"] is True
            return True
        transport=asyncio.run(check_transport())
except SystemExit:
    exited=True
assert json.dumps(cfg,sort_keys=True)==before and agent.enabled_toolsets==enabled
print(json.dumps({"emitted":emitted,"registered":len(registered),"calls":len(calls),"exited":exited,"refreshed":refreshed,"denials":denials,"transport":transport,"configUnchanged":True,"allowListUnchanged":True,"nativeSourceContract":bool(os.environ.get("NATIVE_SOURCE"))}))
`.replace("__BRIDGE__",JSON.stringify(HERMES_NATIVE_TOOLS_BRIDGE));

function legacyMocked(mode:string,extra:Record<string,string>={},python="python3",coordinationOnly=false){
  const capsule=hermesNativeToolEnvironment({...options,environment:base,...(coordinationOnly?{requestInteraction:undefined,projectCoordination:async()=>({})}:{})});
  const output=execFileSync(python,["-c",legacyMock],{encoding:"utf8",timeout:15000,env:{...process.env,...base,...capsule,CASE:mode,TEST_SECRET:token,HERMES_SAFE_MODE:mode==="safe"?"1":"0",...extra}});
  assert.ok(!output.includes(token));
  return JSON.parse(output);
}
test("Hermes 0.16 native MCP preserves allow-lists, memory tools, turn ownership and endpoint capability scope",()=>{
  const value=legacyMocked("normal");
  assert.equal(value.refreshed,true);assert.equal(value.registered,1);assert.equal(value.calls,2);
  assert.deepEqual(value.denials,[true,true,true,true]);assert.equal(value.transport,true);
  assert.equal(value.configUnchanged,true);assert.equal(value.allowListUnchanged,true);
});
test("Hermes 0.16 coordination-only native tools retain child isolation and existing memory selection",()=>{
  const value=legacyMocked("normal",{},"python3",true);
  assert.equal(value.refreshed,true);assert.equal(value.registered,1);assert.equal(value.calls,2);
  assert.deepEqual(value.denials,[true,true,true,true]);
  const names=value.emitted.find((event:any)=>event.type==="hermes_native_tools").names;
  assert.equal(names.length,1);assert.ok(names[0].endsWith("phonon_project_coordination"));
  assert.equal(value.configUnchanged,true);assert.equal(value.allowListUnchanged,true);
});
for(const mode of ["disabled","serialized-disabled","malformed-policy","safe","connecting-conflict","unknown-version","partial-modern","missing-tools","missing-scope","discovery","unselected","runtime-disabled"]){
  test("Hermes 0.16 native MCP fails closed without inference for "+mode,()=>{
    const value=legacyMocked(mode);assert.equal(value.calls,0);
    assert.equal(["unselected","runtime-disabled"].includes(mode)?value.refreshed===false:value.exited,true);
    if(["disabled","serialized-disabled","malformed-policy","safe","connecting-conflict","unknown-version","partial-modern"].includes(mode))assert.equal(value.registered,0);
    if(mode==="unselected")assert.match(value.emitted.at(-1).error,/profile toolset enablement required/);
  });
}
test("copied installed 0.16 schema and thread-context APIs satisfy the local compatibility contract",{skip:!process.env.PHONON_TEST_HERMES_LEGACY_SOURCE},()=>{
  const value=legacyMocked("normal",{NATIVE_SOURCE:process.env.PHONON_TEST_HERMES_LEGACY_SOURCE!});
  assert.equal(value.nativeSourceContract,true);assert.equal(value.calls,2);assert.deepEqual(value.denials,[true,true,true,true]);
});
test("legacy capability requests reject redirects with installed httpx without network or model calls",{skip:!process.env.PHONON_TEST_HERMES_NATIVE_BIN},()=>{
  const value=legacyMocked("normal",{REAL_HTTPX:"1"},hermesCommand(process.env.PHONON_TEST_HERMES_NATIVE_BIN!).python);
  assert.equal(value.transport,true,JSON.stringify(value));assert.equal(value.calls,2);
});

test("installed Hermes MCP client registers and invokes the real current-turn endpoint without model inference",{skip:!process.env.PHONON_TEST_HERMES_NATIVE_BIN,timeout:60000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"phonon-hermes-mcp-")),command=hermesCommand(process.env.PHONON_TEST_HERMES_NATIVE_BIN!);
  const config="model:\n  default: \"\"\nagent:\n  disabled_toolsets: []\ntool_search:\n  enabled: \"off\"\n";
  await writeFile(path.join(root,"config.yaml"),config,{mode:0o600});
  const before=createHash("sha256").update(await readFile(path.join(root,"config.yaml"))).digest("hex");
  const group=randomUUID(),person=randomUUID(),project=randomUUID(),calls:any[]=[];
  const message:NonNullable<SendOptions["conversationMessage"]>=async input=>{calls.push(input);return {status:"members",conversationID:group,projectID:project,senderID:person,enabled:false,members:[{id:person,name:"Native fixture"}],limits:{maxHops:6,maxDeliveries:24,maxRecipients:8,maxRoots:64}};};
  const bridge=new AgentInteractionBridge(async input=>({requestId:input.requestId!,action:"cancel"}),()=>{},undefined,undefined,message);
  const environment=await bridge.listen(),capsule=hermesNativeToolEnvironment({...options,environment,conversationMessage:message});
  const code=[
    "import os,sys,json","from types import SimpleNamespace","def emit(value): print(json.dumps(value))",
    HERMES_NATIVE_TOOLS_BRIDGE,
    "from hermes_cli.config import load_config",
    "_phonon_setup_native_tools(load_config())",
    "from tools.registry import registry",
    "from tools.mcp_tool_schema import mcp_prefixed_tool_name",
    "from tools.mcp_tool_lifecycle import shutdown_mcp_servers",
    "from agent.delegation_context import delegated_child_context",
    "try:",
    "    root=SimpleNamespace(enabled_toolsets=['mcp-phonon_current_turn'],disabled_toolsets=[],tools=[],valid_tool_names=set())",
    "    assert _phonon_refresh_native_tools(root)",
    "    entry=registry.get_entry(mcp_prefixed_tool_name('phonon_current_turn','phonon_conversation_message'))",
    "    result=json.loads(entry.handler({'operation':'members'}))",
    "    body=json.loads(result['result']) if isinstance(result['result'],str) else result['result']",
    "    assert body['status']=='members' and body['enabled'] is False",
    "    with delegated_child_context('unowned-child'):",
    "        assert 'error' in json.loads(entry.handler({'operation':'members'}))",
    "    assert 'AGENT_PHONON_INTERACTION_TOKEN' not in os.environ",
    "    print(json.dumps({'nativeMcpClient':True,'memberRead':True,'delegatedCallerDenied':True,'modelCalls':0}))",
    "finally: shutdown_mcp_servers()",
  ].join("\n");
  try{
    const result=await execFile(command.python,["-c",code],{cwd:root,timeout:45000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,HOME:root,HERMES_HOME:root,PYTHONDONTWRITEBYTECODE:"1",...environment,...capsule}});
    assert.ok(!result.stdout.includes(environment.AGENT_PHONON_INTERACTION_TOKEN!));assert.ok(!result.stderr.includes(environment.AGENT_PHONON_INTERACTION_TOKEN!));
    assert.ok(result.stdout.includes('"nativeMcpClient": true'));assert.deepEqual(calls,[{operation:"members"}]);
    assert.equal(createHash("sha256").update(await readFile(path.join(root,"config.yaml"))).digest("hex"),before);
  }finally{await bridge.close();await rm(root,{recursive:true,force:true});}
});
