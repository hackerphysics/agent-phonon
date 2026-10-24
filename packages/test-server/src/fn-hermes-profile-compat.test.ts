import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync,statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HERMES_PROFILE_BRIDGE } from "../../core/dist/adapters/hermes-profile-bridge.js";

const python=process.env.PHONON_TEST_HERMES_PROFILE_PYTHON??"python3";
const realParsers=!!process.env.PHONON_TEST_HERMES_PROFILE_PYTHON;
const posix={skip:process.platform==="win32"};
const versions=["0.16","0.21"] as const;
const envValues={OPENAI_API_KEY:"inference-fixture",OPENAI_BASE_URL:"${UNRELATED_SECRET}",PROVIDER_OAUTH_TOKEN:"must-not-copy-oauth",TELEGRAM_BOT_TOKEN:"must-not-copy-channel"};
const envText=Object.entries(envValues).map(([key,value])=>`${key}=${value}\n`).join("");

// Model the actual native path/registry contracts. JSON fixtures are valid YAML;
// the default parser doubles keep this suite independent of Python site packages.
const nativeMock=String.raw`
import os,sys,json,types,re
from pathlib import Path
from types import SimpleNamespace
root=Path(os.environ['PROFILE_FIXTURE_ROOT'])
def module(name,**attrs):
    value=types.ModuleType(name);value.__dict__.update(attrs);sys.modules[name]=value
    return value
module('hermes_cli')
module('utils',env_var_enabled=lambda name:os.environ.get(name,'').strip().lower() in {'1','true','yes','on'})
def profile(name):
    if os.environ.get('PROFILE_FIXTURE_ESCAPE'): return Path(os.environ['PROFILE_FIXTURE_ESCAPE'])
    if name=='default': return root
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}',name): raise ValueError('invalid native profile')
    return root/'profiles'/name
module('hermes_cli.profiles',get_profile_dir=profile)
constants=module('hermes_constants',get_default_hermes_root=lambda:root)
if os.environ['PROFILE_FIXTURE_VERSION']=='0.21':
    constants.named_profile_is_deleted=lambda home:(Path(home).parent/'.deleted'/Path(home).name).exists()
def record_reader(name):
    with open(root/'native-reader-calls','a') as stream: stream.write(name+'\n')
def read_raw_config():
    record_reader('read_raw_config')
    return json.loads((root/'config.yaml').read_text())
def read_user_config_raw(path=None):
    record_reader('read_user_config_raw')
    return json.loads((path or root/'config.yaml').read_text())
def forbidden_loader(): raise AssertionError('merged/migrating config loader must not run')
cfg=module('hermes_cli.config',read_raw_config=read_raw_config,load_config=forbidden_loader,get_config_path=lambda:root/'config.yaml',DEFAULT_CONFIG={'toolsets':['hermes-cli']})
if os.environ['PROFILE_FIXTURE_VERSION']=='0.21': cfg.read_user_config_raw=read_user_config_raw
module('hermes_cli.auth',PROVIDER_REGISTRY={'openai-api':SimpleNamespace(api_key_env_vars=('OPENAI_API_KEY','PROVIDER_OAUTH_TOKEN'),base_url_env_var='OPENAI_BASE_URL')})
if os.environ['PROFILE_FIXTURE_REAL_PARSERS']!='1':
    def safe_load(value):
        if hasattr(value,'read'): value=value.read()
        if isinstance(value,bytes): value=value.decode('utf8')
        return json.loads(value) if value.strip() else None
    module('yaml',safe_load=safe_load,safe_dump=lambda value,**kwargs:json.dumps(value))
    def dotenv_values(path=None,stream=None,interpolate=True):
        assert path is None and stream is not None and interpolate is False
        raw=stream.read()
        if raw==os.environ['PROFILE_FIXTURE_ENV_TEXT']: return json.loads(os.environ['PROFILE_FIXTURE_ENV_VALUES'])
        cases={value+'\n':{'HERMES_SAFE_MODE':value.split('=',1)[1]} for value in ['HERMES_SAFE_MODE=0','HERMES_SAFE_MODE=1','HERMES_SAFE_MODE=$'+'{LOCAL_FLAG}']}
        if raw in cases: return cases[raw]
        return {key:(json.loads(value) if value.startswith('"') else value) for key,value in (line.split('=',1) for line in raw.splitlines() if '=' in line)}
    module('dotenv',dotenv_values=dotenv_values)
sys.argv=['profile-bridge',str(root/'native/hermes')]
`;

function fixture(version:typeof versions[number],managed=false){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"phonon-hermes-profile-compat-")));
  const runtimeProfile=managed?"phn-"+"a".repeat(40):"phn-fixture";
  const base=join(root,"profiles/base"),home=join(root,"profiles",runtimeProfile);
  mkdirSync(base,{recursive:true});
  writeFileSync(join(root,"config.yaml"),JSON.stringify({model:{default:"wrong-global-model",provider:"wrong-global-provider"}}));
  const config:Record<string,any>={model:{default:"base-model",provider:"openai-api"},terminal:{cwd:"/not-the-employee",backend:"local"},gateway:{token:"must-not-clone-gateway"},platforms:{telegram:{}},telegram:{token:"must-not-clone-channel"},discord:{token:"must-not-clone-channel"},providers:{selected:{key_env:"PROVIDER_REFERENCE",api:"https://example.invalid/v1"}}};
  writeFileSync(join(base,"config.yaml"),JSON.stringify(config));
  writeFileSync(join(base,".env"),envText);
  for(const name of ["memories","sessions","skills","cron"]){mkdirSync(join(base,name));writeFileSync(join(base,name,"base-only"),"must-not-clone-native-state");}
  writeFileSync(join(base,"auth.json"),'"must-not-clone-rotating-auth"');
  const employeeId=randomUUID(),nonce=randomUUID(),workspace=join(root,"workspaces",employeeId);
  mkdirSync(workspace,{recursive:true,mode:0o700});
  writeFileSync(join(workspace,".phonon-employee"),nonce,{mode:0o600});
  const input={operation:"apply",employeeId,nonce,runtimeProfile,workspace,base:"base",model:"selected-model",documents:{"SOUL.md":"Identity","AGENTS.md":"Boundaries","USER.md":"Owner preferences","TOOLS.md":"Native tools"}};
  function run(changes:Record<string,unknown>={},environment:Record<string,string>={}){
    const stdout=execFileSync(python,["-B","-c",nativeMock+"\n"+HERMES_PROFILE_BRIDGE],{
      input:JSON.stringify({...input,...changes}),encoding:"utf8",timeout:10000,
      env:{...process.env,HERMES_HOME:root,HERMES_SAFE_MODE:"0",PROFILE_FIXTURE_ROOT:root,PROFILE_FIXTURE_VERSION:version,PROFILE_FIXTURE_REAL_PARSERS:realParsers?"1":"0",PROFILE_FIXTURE_ENV_TEXT:envText,PROFILE_FIXTURE_ENV_VALUES:JSON.stringify(envValues),UNRELATED_SECRET:"must-not-expand-process-secret",...environment},
    });
    for(const secret of ["inference-fixture","must-not-copy-oauth","must-not-copy-channel","must-not-expand-process-secret"])assert.ok(!stdout.includes(secret));
    return JSON.parse(stdout);
  }
  function profileConfig(){
    const raw=readFileSync(join(home,"config.yaml"),"utf8");
    return realParsers?JSON.parse(execFileSync(python,["-B","-c","import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"],{input:raw,encoding:"utf8",timeout:10000})):JSON.parse(raw);
  }
  return {root,base,home,config,input,run,profileConfig,close(){rmSync(root,{recursive:true,force:true});}};
}

for(const version of versions){
  test(`Hermes ${version} does not recreate a missing installed profile or adopt a copied replacement directory`,posix,()=>{
    const f=fixture(version);
    try{
      const first=f.run();assert.equal(first.ok,true);assert.match(first.result.nativeIdentity,/^p:[a-f0-9]+:[a-f0-9]+$/);
      renameSync(f.home,join(f.root,"retained-original-profile"));assert.equal(f.run({previousHashes:first.result.documentHashes,previousIdentity:first.result.nativeIdentity}).error,"employee_profile_missing");assert.equal(existsSync(f.home),false);
      const fresh=f.run();assert.equal(fresh.ok,true);assert.notEqual(fresh.result.nativeIdentity,first.result.nativeIdentity);
      assert.equal(f.run({previousHashes:first.result.documentHashes,previousIdentity:first.result.nativeIdentity}).error,"employee_profile_identity_changed");
      assert.equal(readFileSync(join(f.home,"SOUL.md"),"utf8"),f.input.documents["SOUL.md"]);
    }finally{f.close();}
  });
  test(`Hermes ${version} raw-profile compatibility pins the named base and copies no memory or auth`,posix,()=>{
    const f=fixture(version);
    try{
      const original=readFileSync(join(f.base,"config.yaml"),"utf8"),reply=f.run();
      assert.equal(reply.ok,true);assert.equal(reply.result.home,f.home);
      const config=f.profileConfig();
      assert.deepEqual(config.model,{default:"selected-model",provider:"openai-api"});
      assert.deepEqual(config.terminal,{backend:"local"});assert.deepEqual(config.providers,f.config.providers);
      for(const field of ["gateway","platforms","telegram","discord"])assert.equal(config[field],undefined);
      const env=readFileSync(join(f.home,".env"),"utf8");
      assert.ok(env.includes("inference-fixture"));assert.ok(env.includes("${UNRELATED_SECRET}"));assert.ok(!env.includes("must-not-expand-process-secret"));
      assert.ok(!env.includes("OAUTH"));assert.ok(!env.includes("TELEGRAM"));
      assert.equal(existsSync(join(f.home,"auth.json")),false);
      for(const dir of ["sessions","skills","cron"])assert.deepEqual(readdirSync(join(f.home,dir)),[]);
      assert.deepEqual(readdirSync(join(f.home,"memories")),["USER.md"]);
      assert.equal(readFileSync(join(f.home,"memories/USER.md"),"utf8"),f.input.documents["USER.md"]);
      assert.equal(readFileSync(join(f.base,"config.yaml"),"utf8"),original);
      assert.equal(readFileSync(join(f.base,".env"),"utf8"),envText);
      assert.equal(existsSync(join(f.root,"native-reader-calls")),false,"never read cached process-global configuration");
      assert.equal(statSync(f.home).mode&0o777,0o700);
      for(const file of ["config.yaml",".env",".phonon-employee.json","SOUL.md"])assert.equal(statSync(join(f.home,file)).mode&0o777,0o600);
      assert.equal(f.run({operation:"inspect"}).ok,true);
    }finally{f.close();}
  });

  test(`Hermes ${version} profile replay preserves learned memory and rejects changed ownership/documents`,posix,()=>{
    const f=fixture(version);
    try{
      const first=f.run();assert.equal(first.ok,true);
      writeFileSync(join(f.home,"memories/MEMORY.md"),"Independent learned memory");
      writeFileSync(join(f.home,"memories/USER.md"),"Learned owner preferences");
      const documents={...f.input.documents,"SOUL.md":"Updated identity","USER.md":"New desired preferences"};
      const second=f.run({documents,model:"new-model",previousHashes:first.result.documentHashes});assert.equal(second.ok,true);
      assert.equal(f.profileConfig().model.default,"new-model");
      assert.equal(readFileSync(join(f.home,"memories/MEMORY.md"),"utf8"),"Independent learned memory");
      assert.equal(readFileSync(join(f.home,"memories/USER.md"),"utf8"),"Learned owner preferences");
      assert.equal(f.run({operation:"inspect",documents}).result.documentHashes["SOUL.md"],second.result.documentHashes["SOUL.md"]);
      assert.equal(f.run({nonce:randomUUID()}).error,"employee_profile_owner_conflict");
      writeFileSync(join(f.home,"SOUL.md"),"Local edit");
      assert.equal(f.run({documents,previousHashes:second.result.documentHashes}).error,"employee_profile_local_changes");
      assert.equal(readFileSync(join(f.home,"SOUL.md"),"utf8"),"Local edit");
    }finally{f.close();}
  });
}

test("Hermes compatibility refuses malformed/non-mapping base config without a merged-config fallback",posix,()=>{
  for(const value of ['["not-a-mapping"]','false','"not-a-mapping"','{"malformed":']){
    const f=fixture("0.16");
    try{
      writeFileSync(join(f.base,"config.yaml"),value);
      const reply=f.run();assert.equal(reply.ok,false);
      assert.equal(reply.error,value==='{"malformed":'?"employee_profile_native_failure":"employee_base_config_invalid");
      assert.equal(existsSync(f.home),false);assert.equal(existsSync(join(f.root,"native-reader-calls")),false);
    }finally{f.close();}
  }
});

for(const version of versions){
  test(`Hermes ${version} managed MCP opt-in grants only new owned profiles and retains native policy`,posix,()=>{
    const f=fixture(version,true);
    try{
      const base={...f.config,toolsets:["hermes-cli","file"],platform_toolsets:{cli:["file"],telegram:["hermes-telegram"]},agent:{disabled_toolsets:["terminal"]},security:{redact_secrets:true}};
      writeFileSync(join(f.base,"config.yaml"),JSON.stringify(base));
      const before=readFileSync(join(f.base,"config.yaml"),"utf8");
      const result=f.run({managedProfileNativeTools:true});assert.equal(result.ok,true);
      const cfg=f.profileConfig();assert.deepEqual(cfg.toolsets,["hermes-cli","file","mcp-phonon_current_turn"]);
      assert.deepEqual(cfg.platform_toolsets,{cli:["file","mcp-phonon_current_turn"],telegram:["hermes-telegram"]});
      assert.deepEqual(cfg.agent,base.agent);assert.deepEqual(cfg.security,base.security);
      assert.equal(readFileSync(join(f.base,"config.yaml"),"utf8"),before);
      assert.equal(existsSync(join(f.home,"auth.json")),false);assert.deepEqual(readdirSync(join(f.home,"sessions")),[]);
    }finally{f.close();}
  });
  test(`Hermes ${version} managed opt-in uses only missing native defaults and never migrates existing profiles`,posix,()=>{
    const fresh=fixture(version,true),existing=fixture(version,true);
    try{
      assert.equal(fresh.run({managedProfileNativeTools:true}).ok,true);
      assert.deepEqual(fresh.profileConfig().toolsets,["hermes-cli","mcp-phonon_current_turn"]);
      assert.deepEqual(fresh.profileConfig().platform_toolsets,{cli:["hermes-cli","mcp-phonon_current_turn"]});
      writeFileSync(join(existing.base,"config.yaml"),JSON.stringify({...existing.config,toolsets:["hermes-cli"]}));
      assert.equal(existing.run({managedProfileNativeTools:false}).ok,true);
      assert.equal(existing.run({managedProfileNativeTools:true}).error,"employee_profile_native_tools_enablement_missing");
      assert.deepEqual(existing.profileConfig().toolsets,["hermes-cli"]);
      assert.equal(existing.run({operation:"inspect",managedProfileNativeTools:true}).error,"employee_profile_native_tools_enablement_missing");
      assert.deepEqual(existing.profileConfig().toolsets,["hermes-cli"]);
    }finally{fresh.close();existing.close();}
  });
}
for(const kind of ["base-deny","global-deny","serialized-deny","safe-mode","global-dotenv-safe","base-dotenv-safe","dynamic-dotenv-safe","alias-conflict","global-alias-conflict","malformed-policy","empty-allowlist","unknown-allowlist","cli-no-mcp","global-cli-no-mcp","empty-cli-allowlist","malformed-cli-allowlist","malformed-platform-map","wrong-nonce","unmanaged-name"]){
  test("Hermes new managed MCP opt-in refuses "+kind+" without policy bypass",posix,()=>{
    const f=fixture("0.16",true);
    try{
      const cfg={...f.config,toolsets:["hermes-cli"]} as Record<string,any>;
      if(kind==="base-deny")cfg.agent={disabled_toolsets:["mcp"]};
      if(kind==="serialized-deny")cfg.agent={disabled_toolsets:'["mcp-phonon_current_turn"]'};
      if(kind==="global-deny")writeFileSync(join(f.root,"config.yaml"),JSON.stringify({agent:{disabled_toolsets:["*"]}}));
      if(kind==="global-dotenv-safe"||kind==="dynamic-dotenv-safe")writeFileSync(join(f.root,".env"),kind==="dynamic-dotenv-safe"?'HERMES_SAFE_MODE=${LOCAL_FLAG}\n':'HERMES_SAFE_MODE=1\n');
      if(kind==="base-dotenv-safe")writeFileSync(join(f.base,".env"),'HERMES_SAFE_MODE=1\n');
      if(kind==="alias-conflict")cfg.mcp_servers={phonon_current_turn:{enabled:false}};
      if(kind==="global-alias-conflict")writeFileSync(join(f.root,"config.yaml"),JSON.stringify({mcp_servers:{phonon_current_turn:{enabled:false}}}));
      if(kind==="malformed-policy")cfg.agent={disabled_toolsets:{mcp:true}};
      if(kind==="empty-allowlist")cfg.toolsets=[];
      if(kind==="unknown-allowlist")cfg.toolsets="hermes-cli";
      if(kind==="cli-no-mcp")cfg.platform_toolsets={cli:["hermes-cli","no_mcp"]};
      if(kind==="global-cli-no-mcp")writeFileSync(join(f.root,"config.yaml"),JSON.stringify({platform_toolsets:{cli:["no_mcp"]}}));
      if(kind==="empty-cli-allowlist")cfg.platform_toolsets={cli:[]};
      if(kind==="malformed-cli-allowlist")cfg.platform_toolsets={cli:"hermes-cli"};
      if(kind==="malformed-platform-map")cfg.platform_toolsets=[];
      if(kind==="wrong-nonce")writeFileSync(join(f.input.workspace,".phonon-employee"),randomUUID());
      writeFileSync(join(f.base,"config.yaml"),JSON.stringify(cfg));
      const before=readFileSync(join(f.base,"config.yaml"),"utf8");
      const result=f.run({managedProfileNativeTools:true,...(kind==="unmanaged-name"?{runtimeProfile:"phn-fixture"}:{})},kind==="safe-mode"?{HERMES_SAFE_MODE:"1"}:{});
      assert.equal(result.ok,false);assert.equal(existsSync(f.home),false);
      assert.match(result.error,/employee_profile_(?:native_tools_|owner_conflict)/);
      assert.equal(readFileSync(join(f.base,"config.yaml"),"utf8"),before);
    }finally{f.close();}
  });
}

test("Hermes operator opt-in absent/false does not enable MCP or introduce new native policy requirements",posix,()=>{
  for(const flag of [undefined,false]){
    const f=fixture("0.16");
    try{
      const cfg={...f.config,toolsets:["hermes-cli"],agent:{disabled_toolsets:["mcp"]},mcp_servers:{phonon_current_turn:{enabled:false}}};
      writeFileSync(join(f.base,"config.yaml"),JSON.stringify(cfg));
      assert.equal(f.run({managedProfileNativeTools:flag},{HERMES_SAFE_MODE:"1"}).ok,true);
      assert.deepEqual(f.profileConfig().toolsets,["hermes-cli"]);assert.deepEqual(f.profileConfig().agent,cfg.agent);
    }finally{f.close();}
  }
});

test("Hermes compatibility refuses symlink/hardlink base files, oversized files and out-of-root native paths",posix,()=>{
  for(const name of ["config.yaml",".env"]){
    for(const kind of ["symlink","hardlink","oversized","fifo"]){
      const f=fixture("0.16");
      try{
        const path=join(f.base,name),external=join(f.root,"external");
        const original=readFileSync(path);writeFileSync(external,original);rmSync(path);
        if(kind==="symlink")symlinkSync(external,path);
        else if(kind==="hardlink")linkSync(external,path);
        else if(kind==="fifo")execFileSync("mkfifo",[path]);
        else writeFileSync(path," ".repeat(1048577));
        const reply=f.run();assert.equal(reply.ok,false);assert.equal(existsSync(f.home),false);
        assert.deepEqual(readFileSync(external),original);
        if(kind==="oversized")assert.equal(reply.error,name==="config.yaml"?"employee_base_config_too_large":"employee_base_env_too_large");
      }finally{f.close();}
    }
  }
  for(const kind of ["directory-symlink","outside-root"]){
    const f=fixture("0.21");
    try{
      const external=join(f.root,"external-profile");mkdirSync(external);
      writeFileSync(join(external,"config.yaml"),JSON.stringify(f.config));
      if(kind==="directory-symlink"){rmSync(f.base,{recursive:true});symlinkSync(external,f.base);}
      const reply=f.run({},kind==="outside-root"?{PROFILE_FIXTURE_ESCAPE:external}:{});
      assert.equal(reply.ok,false);assert.equal(existsSync(f.home),false);
    }finally{f.close();}
  }
});

test("Hermes raw-profile compatibility also reads the native default root without changing profile selection",posix,()=>{
  for(const version of versions){
    const f=fixture(version);
    try{
      assert.equal(f.run({base:"default"}).ok,true);
      assert.deepEqual(f.profileConfig().model,{default:"selected-model",provider:"wrong-global-provider"});
      assert.equal(readFileSync(join(f.home,".env"),"utf8"),"");
      assert.equal(existsSync(join(f.root,"native-reader-calls")),false);
    }finally{f.close();}
  }
});

test("Hermes 0.21 native deletion tombstones refuse base reuse and employee recreation",posix,()=>{
  for(const name of ["base","phn-fixture"]){
    const f=fixture("0.21");
    try{
      const deleted=join(f.root,"profiles/.deleted");mkdirSync(deleted);
      writeFileSync(join(deleted,name),"deleted\n");
      assert.equal(f.run().error,name==="base"?"employee_base_profile_unavailable":"employee_profile_missing");
      assert.equal(existsSync(f.home),false);
      assert.equal(readFileSync(join(deleted,name),"utf8"),"deleted\n");
    }finally{f.close();}
  }
  const f=fixture("0.21");
  try{
    assert.equal(f.run().ok,true);
    const soul=readFileSync(join(f.home,"SOUL.md"),"utf8"),deleted=join(f.root,"profiles/.deleted");mkdirSync(deleted);
    writeFileSync(join(deleted,"phn-fixture"),"deleted\n");
    assert.equal(f.run({operation:"inspect"}).error,"employee_profile_missing");
    assert.equal(f.run({documents:{...f.input.documents,"SOUL.md":"Must not update deleted profile"}}).error,"employee_profile_missing");
    assert.equal(readFileSync(join(f.home,"SOUL.md"),"utf8"),soul);
  }finally{f.close();}
});

test("Hermes real safe YAML parsing preserves raw references and refuses Python object tags",{skip:!realParsers||process.platform==="win32"},()=>{
  const f=fixture("0.16");
  try{
    writeFileSync(join(f.base,"config.yaml"),'model: {default: base-model, provider: openai-api}\nproviders:\n  selected: {key_env: PROVIDER_REFERENCE, base_url: "${UNRELATED_SECRET}"}\n');
    assert.equal(f.run().ok,true);
    assert.equal(f.profileConfig().providers.selected.base_url,"${UNRELATED_SECRET}");
  }finally{f.close();}
  const unsafe=fixture("0.21");
  try{
    writeFileSync(join(unsafe.base,"config.yaml"),'!!python/object/apply:builtins.str ["must-not-construct"]');
    assert.equal(unsafe.run().error,"employee_profile_native_failure");assert.equal(existsSync(unsafe.home),false);
  }finally{unsafe.close();}
});

test("Hermes profile compatibility does not follow managed-file symlinks or guess unknown-provider credentials",posix,()=>{
  const f=fixture("0.16");
  try{
    writeFileSync(join(f.base,"config.yaml"),JSON.stringify({...f.config,model:{provider:"unregistered-provider"}}));
    assert.equal(f.run().ok,true);assert.equal(readFileSync(join(f.home,".env"),"utf8"),"");
    const external=join(f.root,"external-tools");writeFileSync(external,"Keep outside contents");
    rmSync(join(f.home,"TOOLS.md"));symlinkSync(external,join(f.home,"TOOLS.md"));
    assert.equal(f.run().ok,false);assert.equal(readFileSync(external,"utf8"),"Keep outside contents");
  }finally{f.close();}
});

test("Hermes profile compatibility keeps external-memory refusal and supports absent optional base files",posix,()=>{
  for(const extra of [{honcho:{enabled:true}},{memory_providers:{shared:{}}}]){
    const f=fixture("0.21");
    try{
      writeFileSync(join(f.base,"config.yaml"),JSON.stringify({...f.config,...extra}));
      assert.equal(f.run().error,"employee_external_memory_requires_configuration");assert.equal(existsSync(f.home),false);
    }finally{f.close();}
  }
  const f=fixture("0.16");
  try{
    rmSync(join(f.base,"config.yaml"));rmSync(join(f.base,".env"));
    assert.equal(f.run().ok,true);assert.deepEqual(f.profileConfig().model,{default:"selected-model"});
    assert.equal(readFileSync(join(f.home,".env"),"utf8"),"");
  }finally{f.close();}
});
