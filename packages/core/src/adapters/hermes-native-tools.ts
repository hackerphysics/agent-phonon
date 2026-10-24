import type {SendOptions} from "../adapter.js";
import {PhononError} from "../rpc.js";
import {nativeControllerToolNames,selectedNativeControllerTools,verifiedNativeToolChannel} from "../native-tool-channel.js";

/** Consumed before native profile loading; never written into argv or user config. */
export function hermesNativeToolEnvironment(options:SendOptions):Record<string,string> {
  const names=selectedNativeControllerTools(options);
  if(!names.length)return {PHONON_HERMES_NATIVE_MCP_CONTEXT:""};
  try{
    const {url,interaction,token}=verifiedNativeToolChannel(options.environment??{});
    return {PHONON_HERMES_NATIVE_MCP_CONTEXT:JSON.stringify({v:1,url:url.href,interactionUrl:interaction.href,token,names})};
  }catch{
    throw new PhononError("errCapabilityUnsupported","Native Hermes tools require a verified current-turn local MCP channel; update the device runtime");
  }
}

export const HERMES_NATIVE_TOOL_POLICY = String.raw`
def _phonon_disabled_toolsets(value):
    # 0.16 lacks parse_config_string_list. Malformed policy must not become [].
    if value is None:
        return []
    if isinstance(value, str):
        if value.strip().startswith("["):
            import ast
            value = ast.literal_eval(value.strip())
        else:
            value = value.split(",")
    if not isinstance(value, (list, tuple)) or any(not isinstance(name, str) for name in value):
        raise ValueError()
    return [name.strip() for name in value if name.strip()]

def _phonon_assert_tools_policy(disabled):
    from utils import env_var_enabled
    if env_var_enabled("HERMES_SAFE_MODE") or set(_phonon_disabled_toolsets(disabled)) & {"all", "*", "mcp", "phonon_current_turn", "mcp-phonon_current_turn"}:
        raise ValueError()
`;

export const HERMES_NATIVE_TOOLS_BRIDGE = String.raw`
# Freeze the controller capability before native dotenv/profile precedence.
_phonon_tools_payload = os.environ.pop("PHONON_HERMES_NATIVE_MCP_CONTEXT", "")
_phonon_tools_context = None
_phonon_tools_secret = ""
_phonon_tools_names = set()
_phonon_tools_alias = "phonon_current_turn"
_phonon_tools_legacy = False
_phonon_tools_root = None
_phonon_tools_owner = None
_phonon_tools_active = False
_phonon_tools_scope_installed = False
if _phonon_tools_payload:
    try:
        _phonon_tools_context = json.loads(_phonon_tools_payload)
        _phonon_tools_secret = _phonon_tools_context.get("token", "") if isinstance(_phonon_tools_context, dict) else ""
    except Exception:
        _phonon_tools_context = {}
    for _key in ("AGENT_PHONON_MCP_URL", "AGENT_PHONON_INTERACTION_URL",
                 "AGENT_PHONON_INTERACTION_RECEIPT_URL", "AGENT_PHONON_INTERACTION_TOKEN",
                 "AGENT_PHONON_BOARD_URL", "AGENT_PHONON_WORKFLOW_URL",
                 "AGENT_PHONON_MESSAGE_URL", "AGENT_PHONON_DOCUMENT_URL", "AGENT_PHONON_COORDINATION_URL"):
        os.environ.pop(_key, None)

def _phonon_tools_failure(stage):
    emit({"type": "hermes_result", "completed": False,
          "error": "Native Hermes current-turn MCP tools unavailable (" + stage + "); check runtime support and native policy"})

# PHONON_NATIVE_TOOL_POLICY

def _phonon_legacy_mcp_api():
    global _phonon_tools_legacy, _phonon_tools_owner
    from importlib.metadata import version
    if version("hermes-agent").split(".")[:2] != ["0", "16"]:
        raise ValueError()
    from contextvars import ContextVar
    from types import SimpleNamespace
    from tools import mcp_tool as native
    from tools.thread_context import propagate_context_to_thread
    if not callable(propagate_context_to_thread) or not callable(native.register_mcp_servers) or not callable(native._convert_mcp_schema):
        raise ValueError()
    if not isinstance(native._servers, dict) or not isinstance(native._server_connecting, set):
        raise ValueError()
    def server_names():
        with native._lock:
            return set(native._servers) | set(native._server_connecting)
    def prefixed(server, name):
        return native._convert_mcp_schema(server, SimpleNamespace(name=name, description="", inputSchema={"type": "object", "properties": {}}))["name"]
    # 0.16 ignores strict_redirect_headers. Tighten only this invocation's bearer
    # capability; other native provider/MCP traffic retains its original client.
    import httpx
    send = httpx.AsyncClient.send
    async def scoped_send(client, request, **kwargs):
        if request.headers.get("authorization") == "Bearer " + _phonon_tools_secret:
            if str(request.url) != _phonon_tools_context["url"]:
                raise ValueError("Phonon current-turn MCP endpoint changed")
            kwargs["follow_redirects"] = False
        return await send(client, request, **kwargs)
    httpx.AsyncClient.send = scoped_send
    _phonon_tools_owner = ContextVar("phonon_hermes_native_tool_owner", default=None)
    _phonon_tools_legacy = True
    def owning_turn():
        return _phonon_tools_active and _phonon_tools_root is not None and _phonon_tools_owner.get() is _phonon_tools_root
    return native.register_mcp_servers, server_names, prefixed, owning_turn

def _phonon_install_native_tool_scope(agent_class):
    global _phonon_tools_scope_installed
    if not _phonon_tools_payload or not _phonon_tools_legacy:
        return
    try:
        from functools import wraps
        methods = ["_execute_tool_calls_sequential", "_execute_tool_calls_concurrent"]
        if any(not callable(getattr(agent_class, name, None)) for name in methods):
            raise ValueError()
        def scoped(original):
            @wraps(original)
            def dispatch(agent, *args, **kwargs):
                owner = agent if agent is _phonon_tools_root and _phonon_tools_active and getattr(agent, "_delegate_depth", 0) == 0 else None
                context = _phonon_tools_owner.set(owner)
                try:
                    return original(agent, *args, **kwargs)
                finally:
                    _phonon_tools_owner.reset(context)
            return dispatch
        for name in methods:
            setattr(agent_class, name, scoped(getattr(agent_class, name)))
        _phonon_tools_scope_installed = True
    except Exception:
        _phonon_tools_failure("native turn scope API")
        raise SystemExit(2)

def _phonon_native_turn_finished(agent):
    global _phonon_tools_active
    if agent is _phonon_tools_root:
        _phonon_tools_active = False

def _phonon_setup_native_tools(config):
    global _phonon_tools_names
    if not _phonon_tools_payload:
        return
    stage = "endpoint"
    try:
        import re
        from urllib.parse import urlsplit
        capsule = _phonon_tools_context
        if not isinstance(capsule, dict) or set(capsule) != {"v", "url", "interactionUrl", "token", "names"} or type(capsule["v"]) is not int or capsule["v"] != 1:
            raise ValueError()
        url, interaction = urlsplit(capsule["url"]), urlsplit(capsule["interactionUrl"])
        for parsed, path in ((url, "/mcp"), (interaction, "/interaction")):
            if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username or parsed.password or parsed.path != path or parsed.query or parsed.fragment:
                raise ValueError()
        allowed = __PHONON_CONTROLLER_NAMES__
        requested = capsule["names"]
        if url.netloc != interaction.netloc or not re.fullmatch(r"[A-Za-z0-9_-]{43}", capsule["token"]):
            raise ValueError()
        if not isinstance(requested, list) or not requested or any(name not in allowed for name in requested) or len(set(requested)) != len(requested):
            raise ValueError()
        stage = "policy"
        agent_config = config.get("agent") or {}
        _phonon_assert_tools_policy(agent_config.get("disabled_toolsets"))
        stage = "alias conflict"
        if _phonon_tools_alias in (config.get("mcp_servers") or {}):
            raise ValueError()
        for key in ("NO_PROXY", "no_proxy"):
            prior = [item.strip() for item in os.environ.get(key, "").split(",") if item.strip()]
            if "127.0.0.1" not in prior:
                prior.append("127.0.0.1")
            os.environ[key] = ",".join(prior)
        stage = "native MCP API"
        try:
            from tools.mcp_tool_discovery import register_mcp_servers, get_registered_mcp_server_names
        except ModuleNotFoundError as exc:
            if exc.name != "tools.mcp_tool_discovery":
                raise
            register_mcp_servers, get_registered_mcp_server_names, mcp_prefixed_tool_name, is_dispatcher_owned_worker_context = _phonon_legacy_mcp_api()
        else:
            from tools.mcp_tool_schema import mcp_prefixed_tool_name
            from agent.delegation_context import is_dispatcher_owned_worker_context
        from tools.registry import registry
        stage = "alias conflict"
        if _phonon_tools_alias in get_registered_mcp_server_names():
            raise ValueError()
        expected = {mcp_prefixed_tool_name(_phonon_tools_alias, name) for name in requested}
        if any(registry.get_entry(name) is not None for name in expected):
            raise ValueError()
        stage = "discovery"
        registered = register_mcp_servers({_phonon_tools_alias: {
            "url": capsule["url"], "headers": {"Authorization": "Bearer " + capsule["token"]},
            "enabled": True, "skip_preflight": True, "strict_redirect_headers": True, "connect_timeout": 10, "timeout": 1800,
            "tools": {"include": requested, "resources": False, "prompts": False}}})
        if not expected.issubset(set(registered)):
            raise ValueError()
        def owning_turn_only(handler):
            def guarded(arguments, **kwargs):
                if not is_dispatcher_owned_worker_context():
                    return json.dumps({"error": "Phonon controller tools require the owning native turn"})
                return handler(arguments, **kwargs)
            return guarded
        for name in expected:
            entry = registry.get_entry(name)
            if entry is None or entry.toolset != "mcp-" + _phonon_tools_alias:
                raise ValueError()
            entry.handler = owning_turn_only(entry.handler)
        _phonon_tools_names = expected
    except Exception:
        _phonon_tools_failure(stage)
        raise SystemExit(2)

def _phonon_refresh_native_tools(agent):
    global _phonon_tools_root, _phonon_tools_active
    if not _phonon_tools_payload:
        return True
    stage = "tool selection"
    try:
        from model_tools import get_tool_definitions
        _phonon_assert_tools_policy(getattr(agent, "disabled_toolsets", None))
        enabled = getattr(agent, "enabled_toolsets", None)
        if _phonon_tools_legacy:
            if not _phonon_tools_scope_installed or _phonon_tools_root is not None:
                raise ValueError()
            # Do not expand 0.16's native allow-list. The isolated profile must
            # explicitly select this MCP toolset (or already allow all tools).
            stage = "profile toolset enablement required"
        else:
            from tools.mcp_tool_agent import refresh_agent_mcp_tools
            if enabled is not None:
                enabled = list(enabled)
                if _phonon_tools_alias not in enabled and "mcp-" + _phonon_tools_alias not in enabled:
                    enabled.append(_phonon_tools_alias)
            refresh_agent_mcp_tools(agent, enabled_override=enabled)
        definitions = get_tool_definitions(enabled_toolsets=getattr(agent, "enabled_toolsets", None),
            disabled_toolsets=getattr(agent, "disabled_toolsets", None), quiet_mode=True, skip_tool_search_assembly=True)
        available = {(item.get("function") or {}).get("name") for item in definitions}
        if not _phonon_tools_names.issubset(available):
            raise ValueError()
        if _phonon_tools_legacy:
            stage = "native tool snapshot"
            if not isinstance(agent.tools, list) or not isinstance(agent.valid_tool_names, set):
                raise ValueError()
            # Preserve native memory/engine tools and expose only the requested
            # current-turn definitions directly, even with native Tool Search.
            present = {(item.get("function") or {}).get("name") for item in agent.tools}
            agent.tools = list(agent.tools) + [item for item in definitions if (item.get("function") or {}).get("name") in _phonon_tools_names - present]
            agent.valid_tool_names = set(agent.valid_tool_names) | _phonon_tools_names
            _phonon_tools_root, _phonon_tools_active = agent, True
        emit({"type": "hermes_native_tools", "transport": "mcp", "names": sorted(_phonon_tools_names)})
        return True
    except Exception:
        _phonon_tools_failure(stage)
        return False
`.replace("__PHONON_CONTROLLER_NAMES__",JSON.stringify(nativeControllerToolNames)).replace("# PHONON_NATIVE_TOOL_POLICY",HERMES_NATIVE_TOOL_POLICY);
