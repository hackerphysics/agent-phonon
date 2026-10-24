import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmployeeProfileTarget } from "@agent-phonon/core";
import { AgentId } from "@agent-phonon/protocol";
import { HERMES_NATIVE_TOOLS_BRIDGE } from "../../core/dist/adapters/hermes-native-tools.js";

export function hermesProfileFixture(configure?: (config: Record<string, any>) => void, dotenv = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phonon-daemon-hermes-profile-")));
  const native = join(root, "native"), employeeId = randomUUID(), workspace = join(root, employeeId), nonce = randomUUID();
  mkdirSync(native, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, ".phonon-employee"), nonce, { mode: 0o600 });
  const config: Record<string, any> = { model: { default: "base-model", provider: "fixture-provider" }, toolsets: ["hermes-cli"], platform_toolsets: { cli: ["hermes-cli"], telegram: ["hermes-telegram"] }, agent: { disabled_toolsets: [] } };
  configure?.(config);
  writeFileSync(join(native, "config.yaml"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(native, ".env"), 'FIXTURE_API_KEY="approved-inference-fixture"\n' + dotenv, { mode: 0o600 });
  mkdirSync(join(native, "memories")); writeFileSync(join(native, "memories/MEMORY.md"), "Do not clone daily memory");
  writeFileSync(join(native, "auth.json"), '"Do not clone rotating auth"', { mode: 0o600 });
  const python = process.env.PHONON_TEST_HERMES_PROFILE_PYTHON ?? execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const wrapper = join(root, "python3"), entry = join(root, "hermes"), selector = new URL("../src/fixtures/hermes016-tool-selection.py", import.meta.url).pathname;
  const bootstrap = String.raw`
import os,sys,json,types,re
from pathlib import Path
from types import SimpleNamespace
root=Path(__ROOT__)
def module(name,**attrs):
    value=types.ModuleType(name);value.__path__=[];value.__dict__.update(attrs);sys.modules[name]=value
    return value
module('hermes_cli')
module('hermes_cli.profiles',get_profile_dir=lambda name:root if name=='default' else root/'profiles'/name)
module('hermes_constants',get_default_hermes_root=lambda:root)
module('hermes_cli.config',DEFAULT_CONFIG={'toolsets':['hermes-cli']})
module('hermes_cli.auth',PROVIDER_REGISTRY={'fixture-provider':SimpleNamespace(api_key_env_vars=('FIXTURE_API_KEY',),base_url_env_var=None)})
module('utils',env_var_enabled=lambda name:os.environ.get(name,'').lower() in {'1','true','yes','on'})
def safe_load(value):
    if isinstance(value,bytes): value=value.decode()
    return json.loads(value) if value.strip() else None
module('yaml',safe_load=safe_load,safe_dump=lambda value,**kwargs:json.dumps(value))
def dotenv_values(stream=None,interpolate=True):
    assert interpolate is False
    return {key:(json.loads(value) if value.startswith('"') else value) for key,value in (line.split('=',1) for line in stream.read().splitlines() if '=' in line)}
module('dotenv',dotenv_values=dotenv_values)
`.replace("__ROOT__", JSON.stringify(native));
  writeFileSync(wrapper, `#!${python}\n${bootstrap}\nscript=sys.argv[2];sys.argv=['-c',*sys.argv[3:]]\nexec(compile(script,'hermes-profile-bridge','exec'))\n`, { mode: 0o700 });
  writeFileSync(entry, `#!${wrapper}\n`, { mode: 0o700 });
  const target: EmployeeProfileTarget = { input: { employeeId, revision: 1, profileId: randomUUID(), agent: AgentId.parse("hermes:default"), model: "selected-model", name: "Owned fixture", responsibility: "Fixture", documents: { soul: "Identity", agents: "Boundaries", user: "Owner", tools: "Native tools" } }, runtimeProfile: "phn-" + randomUUID().replaceAll("-", "") + "a".repeat(8), workspace, nonce };
  const home = join(native, "profiles", target.runtimeProfile);
  function select() {
    const selection = String.raw`
import ast,threading,importlib.metadata
from typing import Set,List,Optional,Dict,Any
cfg=json.loads(Path(__CONFIG__).read_text())
CONFIGURABLE_TOOLSETS=[('terminal','',''),('file','','')]
PLATFORMS={'cli':{'default_toolset':'hermes-cli'}}
_DEFAULT_OFF_TOOLSETS=set();_TOOLSET_PLATFORM_RESTRICTIONS={}
_get_plugin_toolset_keys=lambda:set()
_toolset_allowed_for_platform=lambda name,platform:True
_xai_credentials_present=lambda:False
_parse_enabled_flag=lambda value,default=True:value is True
toolsets={'hermes-cli':{'includes':['terminal','file']},'terminal':{},'file':{}}
def resolve(name): return {'hermes-cli':['native_terminal','native_read'],'terminal':['native_terminal'],'file':['native_read']}.get(name,[])
module('toolsets',resolve_toolset=resolve,TOOLSETS=toolsets)
# Execute the exact installed resolver, not a mock using root toolsets.
exec(compile(Path(__SELECTOR__).read_text(),'native-0.16-tools-config','exec'))
enabled=sorted(_get_platform_tools(cfg,'cli'))
entries={};emitted=[]
native_source=os.environ.get('PHONON_TEST_HERMES_016_SELECTION_SOURCE')
def extracted(file,names):
    path=Path(native_source)/file
    tree=ast.parse(path.read_text())
    functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
    assert len(functions)==len(names)
    exec(compile(ast.Module(body=functions,type_ignores=[]),str(path),'exec'),globals())
def emit(value): emitted.append(value)
for name in ['tools','agent']: module(name)
class LegacyOnly:
    def find_spec(self,fullname,path=None,target=None):
        if fullname in {'tools.mcp_tool_discovery','tools.mcp_tool_schema','tools.mcp_tool_agent','agent.delegation_context'}:
            raise ModuleNotFoundError('Native 0.16 API absent',name=fullname)
sys.meta_path.insert(0,LegacyOnly())
importlib.metadata.version=lambda name:'0.16.0'
def schema(server,tool): return {'name':'mcp_'+server+'_'+tool.name}
if native_source:
    _normalize_mcp_input_schema=lambda value:value
    extracted('mcp_tool.py',{'sanitize_mcp_name_component','_convert_mcp_schema'})
    schema=_convert_mcp_schema
def register(servers):
    for server,value in servers.items():
        for name in value['tools']['include']:
            entries[schema(server,SimpleNamespace(name=name,description='',inputSchema={'type':'object','properties':{}}))['name']]=SimpleNamespace(toolset='mcp-'+server,handler=lambda *args,**kwargs:None)
    return list(entries)
module('tools.mcp_tool',register_mcp_servers=register,_convert_mcp_schema=schema,_lock=threading.RLock(),_servers={},_server_connecting=set())
module('tools.thread_context',propagate_context_to_thread=lambda fn:fn)
registry=SimpleNamespace(get_entry=lambda name:entries.get(name),_generation=1,
    get_registered_toolset_names=lambda:{entry.toolset for entry in entries.values()},
    get_registered_toolset_aliases=lambda:{'phonon_current_turn':'mcp-phonon_current_turn'} if entries else {},
    get_toolset_alias_target=lambda name:'mcp-phonon_current_turn' if name=='phonon_current_turn' and entries else None,
    get_tool_names_for_toolset=lambda name:[key for key,entry in entries.items() if entry.toolset==name],
    get_definitions=lambda selected,quiet=True:[{'type':'function','function':{'name':name}} for name in entries if name in selected])
module('tools.registry',registry=registry)
class AsyncClient:
    async def send(self,*args,**kwargs): raise AssertionError('No network or model allowed')
module('httpx',AsyncClient=AsyncClient)
def definitions(**kwargs):
    selected=set(kwargs['enabled_toolsets'] or [])
    return [{'type':'function','function':{'name':name}} for name in entries if 'mcp-phonon_current_turn' in selected]
if native_source:
    TOOLSETS=toolsets
    extracted('toolsets.py',{'get_toolset','resolve_toolset','_get_plugin_toolset_names','_get_registry_toolset_aliases','validate_toolset'})
    _tool_defs_cache={};_TOOL_DEFS_CACHE_MAX=128;_LEGACY_TOOLSET_MAP={}
    logger=SimpleNamespace(warning=lambda *args:None)
    extracted('model_tools.py',{'get_tool_definitions','_compute_tool_definitions'})
    module('tools.schema_sanitizer',sanitize_tool_schemas=lambda value:value)
    module('tools.tool_search',assemble_tool_defs=lambda *args,**kwargs:None,load_config=lambda:SimpleNamespace(enabled='off'))
else:
    get_tool_definitions=definitions
module('model_tools',get_tool_definitions=get_tool_definitions)
os.environ['PHONON_HERMES_NATIVE_MCP_CONTEXT']=json.dumps({'v':1,'url':'http://127.0.0.1:23456/mcp','interactionUrl':'http://127.0.0.1:23456/interaction','token':'a'*43,'names':['phonon_request_interaction','phonon_acknowledge_interaction']})
exec(__TOOLS_BRIDGE__)
class Agent:
    def __init__(self):
        self.enabled_toolsets=enabled;self.disabled_toolsets=cfg['agent']['disabled_toolsets'];self.tools=[];self.valid_tool_names=set()
    def _execute_tool_calls_sequential(self): pass
    def _execute_tool_calls_concurrent(self): pass
_phonon_setup_native_tools(cfg)
_phonon_install_native_tool_scope(Agent)
agent=Agent();ok=_phonon_refresh_native_tools(agent)
print(json.dumps({'selected':enabled,'ready':ok,'names':sorted(agent.valid_tool_names),'events':emitted,'exactNativeDefinitions':bool(native_source)}))
`.replace("__CONFIG__", JSON.stringify(join(home, "config.yaml"))).replace("__SELECTOR__", JSON.stringify(selector)).replace("__TOOLS_BRIDGE__", JSON.stringify(HERMES_NATIVE_TOOLS_BRIDGE));
    return JSON.parse(execFileSync(python, ["-B", "-c", bootstrap + "\n" + selection], { encoding: "utf8", timeout: 10000, env: { ...process.env, HERMES_SAFE_MODE: "0" } }));
  }
  return { root, native, entry, target, home, config, select, profileConfig: () => JSON.parse(readFileSync(join(home, "config.yaml"), "utf8")), close() { rmSync(root, { recursive: true, force: true }); } };
}
