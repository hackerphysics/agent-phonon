import { HERMES_NATIVE_TOOL_POLICY } from "./hermes-native-tools.js";
import { HERMES_PROFILE_FILES } from "./hermes-profile-files.js";

/** Fixed native-profile files only. No path or executable is accepted from RPC. */
export const HERMES_PROFILE_BRIDGE=String.raw`
import sys, os, json, stat, hashlib, uuid
from io import StringIO
from pathlib import Path
wire = sys.stdout
sys.stdout = sys.stderr
sys.path[0] = os.path.dirname(os.path.realpath(sys.argv[1]))

def fail(code):
    raise RuntimeError(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def directory(parent, name, create=False):
    if create:
        try: os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError: pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

def read(parent, name, optional=False, too_large='employee_file_unsafe'):
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        if optional: return None
        raise
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1: fail('employee_file_unsafe')
        if meta.st_size > 1048576: fail(too_large)
        chunks=[];size=0
        while True:
            data=os.read(fd,65536)
            if not data: break
            size+=len(data)
            if size>1048576: fail(too_large)
            chunks.append(data)
        return b''.join(chunks)
    finally: os.close(fd)

def write(parent, name, data):
    temp='.phonon-write-'+uuid.uuid4().hex
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
    try:
        with os.fdopen(fd,'wb') as stream:
            stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.replace(temp,name,src_dir_fd=parent,dst_dir_fd=parent)
    finally:
        try: os.unlink(temp,dir_fd=parent)
        except FileNotFoundError: pass

# PHONON_NATIVE_PROFILE_FILES

def config(parent, name='config.yaml', optional=False):
    import yaml
    raw=read(parent,name,optional,too_large='employee_base_config_too_large')
    # 0.16 read_raw_config() is process-global; 0.21 adds a path-based
    # read_user_config_raw(). Both use raw safe YAML, without merging defaults.
    # Parse the pinned file instead of changing HERMES_HOME or following paths.
    value=yaml.safe_load(raw) if raw is not None else None
    if value is None: return {}
    if not isinstance(value,dict): fail('employee_base_config_invalid')
    return value

# PHONON_NATIVE_TOOL_POLICY

def managed_profile_tools(cfg, root_fd, source_fd, profile_fd, data, creating=False):
    if data.get('managedProfileNativeTools') is not True:
        return
    import re
    if not re.fullmatch(r'phn-[a-f0-9]{40}',data['runtimeProfile']): fail('employee_profile_owner_conflict')
    for fd in [root_fd,source_fd,profile_fd]:
        profile_private_directory(fd)
    workspace=Path(data['workspace'])
    if not workspace.is_absolute() or workspace.name!=data['employeeId'] or str(workspace.resolve())!=str(workspace): fail('employee_profile_owner_conflict')
    owned=profile_root(str(workspace),data.get('workspaceIdentity'))
    try:
        profile_private_directory(owned);profile_private_marker(owned,'.phonon-employee')
        if read(owned,'.phonon-employee')!=data['nonce'].encode(): fail('employee_profile_owner_conflict')
    finally: profile_close(owned)
    if read(profile_fd,'.phonon-employee.json')!=json.dumps({'employee':data['employeeId'],'nonce':data['nonce']},sort_keys=True).encode(): fail('employee_profile_owner_conflict')
    try:
        for policy in [config(root_fd,optional=True),config(source_fd,optional=True),cfg]:
            agent=policy.get('agent',{})
            if not isinstance(agent,dict): raise ValueError()
            _phonon_assert_tools_policy(agent.get('disabled_toolsets'))
            servers=policy.get('mcp_servers',{})
            if not isinstance(servers,dict): raise ValueError()
            if 'phonon_current_turn' in servers: fail('employee_profile_native_tools_alias_conflict')
            platforms=policy.get('platform_toolsets',{})
            if not isinstance(platforms,dict): raise ValueError()
            if 'cli' in platforms:
                selected=platforms['cli']
                if not isinstance(selected,list) or not selected or any(not isinstance(item,str) or not item.strip() for item in selected): fail('employee_profile_native_tools_allowlist_unrecognized')
                if 'no_mcp' in selected: fail('employee_profile_native_tools_policy_denied')
        # Root/base dotenv policy must not be evaded by inference-only copying.
        from dotenv import dotenv_values
        for parent in [root_fd,source_fd,profile_fd]:
            raw=read(parent,'.env',True,too_large='employee_base_env_too_large')
            if raw is None: continue
            values=dotenv_values(stream=StringIO(raw.decode('utf8')),interpolate=False)
            if 'HERMES_SAFE_MODE' in values and str(values['HERMES_SAFE_MODE']).strip().lower() not in {'','0','false','no','off'}: raise ValueError()
    except RuntimeError:
        raise
    except Exception:
        fail('employee_profile_native_tools_policy_denied')
    platforms=cfg.get('platform_toolsets',{})
    selected=platforms.get('cli',['hermes-cli'])
    if not creating:
        if 'mcp-phonon_current_turn' not in selected: fail('employee_profile_native_tools_enablement_missing')
        return
    # Both native 0.16 and 0.21 one-shot selectors use platform_toolsets.cli,
    # not root toolsets or cli.toolsets. Preserve the native explicit selection.
    cfg['platform_toolsets']={**platforms,'cli':[*selected]+([] if 'mcp-phonon_current_turn' in selected else ['mcp-phonon_current_turn'])}
    if 'toolsets' in cfg:
        selected=cfg['toolsets']
    else:
        from hermes_cli.config import DEFAULT_CONFIG
        selected=DEFAULT_CONFIG.get('toolsets')
    if not isinstance(selected,list) or not selected or any(not isinstance(item,str) or not item.strip() for item in selected): fail('employee_profile_native_tools_allowlist_unrecognized')
    if 'mcp-phonon_current_turn' not in selected:
        cfg['toolsets']=[*selected,'mcp-phonon_current_turn']

def run():
    profile_fs_ready()
    data=json.load(sys.stdin)
    name=data['runtimeProfile'];base=data['base']
    if not name.startswith('phn-') or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name): fail('employee_profile_name_invalid')
    from hermes_cli.profiles import get_profile_dir
    import hermes_constants
    native_root=hermes_constants.get_default_hermes_root()
    root=native_root.resolve()
    source=get_profile_dir(base)
    try: parts=source.relative_to(native_root).parts
    except ValueError: fail('employee_base_profile_unavailable')
    if parts and (len(parts)!=2 or parts[0]!='profiles' or parts[1] in ['.','..']): fail('employee_base_profile_unavailable')
    deleted=getattr(hermes_constants,'named_profile_is_deleted',None)
    def assert_live():
        if deleted is not None:
            if not callable(deleted): fail('employee_profile_native_failure')
            if parts and deleted(source): fail('employee_base_profile_unavailable')
            if deleted(native_root/'profiles'/name): fail('employee_profile_missing')
    assert_live()
    root_fd=profile_root(str(root))
    profiles=directory(root_fd,'profiles',True)
    marker=json.dumps({'employee':data['employeeId'],'nonce':data['nonce']},sort_keys=True).encode()
    stage='.phonon-stage-'+name+'-'+data['nonce']
    profile=None;source_fd=None
    try:
        try: source_fd=directory(profiles,parts[1]) if parts else profile_dup(root_fd)
        except FileNotFoundError: fail('employee_base_profile_unavailable')
        try: profile=directory(profiles,name)
        except FileNotFoundError:
            if data['operation']!='apply': fail('employee_profile_missing')
            if data.get('previousHashes') is not None or data.get('previousIdentity'): fail('employee_profile_missing')
            stage_fd=directory(profiles,stage,True)
            try:
                prior=read(stage_fd,'.phonon-employee.json',True)
                if prior is None and profile_entries(stage_fd): fail('employee_profile_owner_conflict')
                if prior is not None and prior!=marker: fail('employee_profile_owner_conflict')
                write(stage_fd,'.phonon-employee.json',marker)
                for child in ['memories','sessions','skills','skins','logs','plans','workspace','cron','home']:
                    fd=directory(stage_fd,child,True);profile_close(fd)
                # Native profile layout, without cloning identity, memories, sessions,
                # channels, skills or rotating OAuth/auth.json credentials.
                import yaml
                cfg=config(source_fd,optional=True)
                honcho=cfg.get('honcho')
                external_honcho=bool(honcho) and not (isinstance(honcho,dict) and honcho.get('enabled') is False)
                if external_honcho or cfg.get('memory_providers'): fail('employee_external_memory_requires_configuration')
                cfg.pop('gateway',None);cfg.pop('platforms',None);cfg.pop('telegram',None);cfg.pop('discord',None)
                if isinstance(cfg.get('terminal'),dict): cfg['terminal'].pop('cwd',None)
                model=cfg.get('model')
                cfg['model']={**model,'default':data['model']} if isinstance(model,dict) else {'default':data['model']}
                if data.get('provider'): cfg['model']['provider']=data['provider']
                managed_profile_tools(cfg,root_fd,source_fd,stage_fd,data,creating=True)
                write(stage_fd,'config.yaml',yaml.safe_dump(cfg,sort_keys=False).encode())
                # Native declared inference-provider environment keys only. Auth stores
                # are never copied; Hermes retains its own root credential-pool fallback.
                env={}
                source_env=read(source_fd,'.env',True,too_large='employee_base_env_too_large')
                if source_env is not None:
                    from dotenv import dotenv_values
                    from hermes_cli.auth import PROVIDER_REGISTRY
                    provider=cfg['model'].get('provider')
                    entry=PROVIDER_REGISTRY.get(provider)
                    if entry:
                        allowed=set(entry.api_key_env_vars)
                        if entry.base_url_env_var: allowed.add(entry.base_url_env_var)
                        parsed=dotenv_values(stream=StringIO(source_env.decode('utf8')),interpolate=False)
                        env={key:parsed[key] for key in allowed if parsed.get(key) and 'OAUTH' not in key.upper()}
                write(stage_fd,'.env',''.join(key+'='+json.dumps(value)+'\n' for key,value in env.items()).encode())
                write(stage_fd,'.no-bundled-skills',b'Managed Phonon employee profile.\n')
                memories=directory(stage_fd,'memories')
                try:
                    if read(memories,'USER.md',True) is None: write(memories,'USER.md',data['documents']['USER.md'].encode())
                finally: profile_close(memories)
                for filename,content in data['documents'].items(): write(stage_fd,filename,content.encode())
                profile_sync(stage_fd)
                assert_live()
                profile_publish(profiles,stage,name,stage_fd)
            finally: profile_close(stage_fd)
            profile=directory(profiles,name)
        if data.get('previousIdentity') and profile_identity(profile)!=data['previousIdentity']: fail('employee_profile_identity_changed')
        if read(profile,'.phonon-employee.json')!=marker: fail('employee_profile_owner_conflict')
        assert_live()
        # A retry may find an already-published directory. Verify it instead of
        # silently blessing a root-only grant or migrating an existing profile.
        managed_profile_tools(config(profile),root_fd,source_fd,profile,data)
        if data['operation']=='apply':
            import yaml
            cfg=config(profile)
            model=cfg.get('model')
            cfg['model']={**model,'default':data['model']} if isinstance(model,dict) else {'default':data['model']}
            if data.get('provider'): cfg['model']['provider']=data['provider']
            write(profile,'config.yaml',yaml.safe_dump(cfg,sort_keys=False).encode())
        hashes={}
        for filename,content in data['documents'].items():
            current=read(profile,filename,True);wanted=content.encode();old=(data.get('previousHashes') or {}).get(filename)
            if data['operation']=='apply':
                if current is not None and digest(current)!=digest(wanted) and digest(current)!=old: fail('employee_profile_local_changes')
                if current!=wanted: write(profile,filename,wanted)
                current=wanted
            if current is None: fail('employee_profile_file_missing')
            hashes[filename]=digest(current)
        memory_bytes=0
        memories=directory(profile,'memories')
        try:
            for filename in ['MEMORY.md','USER.md']:
                contents=read(memories,filename,True)
                if contents: memory_bytes+=len(contents)
        finally: profile_close(memories)
        return {'documentHashes':hashes,'memoryBytes':memory_bytes,'home':str(root/'profiles'/name),'nativeIdentity':profile_identity(profile)}
    finally:
        if profile is not None: profile_close(profile)
        if source_fd is not None: profile_close(source_fd)
        profile_close(profiles);profile_close(root_fd)

try:
    result=run()
    wire.write(json.dumps({'ok':True,'result':result})+'\n')
except Exception as exc:
    message=str(exc)
    code=message if message.startswith('employee_') and '\n' not in message else 'employee_profile_native_failure'
    wire.write(json.dumps({'ok':False,'error':code})+'\n')
wire.flush()
`.replace("# PHONON_NATIVE_PROFILE_FILES",HERMES_PROFILE_FILES).replace("# PHONON_NATIVE_TOOL_POLICY",HERMES_NATIVE_TOOL_POLICY);
