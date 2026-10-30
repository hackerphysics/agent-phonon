import type { SendOptions } from "../adapter.js";
import { hermesCommand } from "./hermes-command.js";
import { discoveryProbe } from "../discovery-probe.js";
import { nativeVersionAtLeast } from "@agent-phonon/protocol";

/** Read-only qualification; registration itself is checked again in the owned child. */
export async function hermesPeerContextSupported(bin: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<boolean> {
  try {
    const command = hermesCommand(bin);
    const result = await discoveryProbe(command.python, ["-B", "-c", String.raw`
import sys, os, json
sys.path[0] = os.path.dirname(os.path.realpath(sys.argv[1]))
from importlib.metadata import version
from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
from hermes_cli.middleware import VALID_MIDDLEWARE
print(json.dumps({"version":version("hermes-agent"),"ready":callable(PluginContext.register_middleware) and callable(get_plugin_manager) and {"llm_request","llm_execution"}.issubset(VALID_MIDDLEWARE)}))
`, command.entry], options?.signal, options);
    const value = JSON.parse(result ?? "null");
    return nativeVersionAtLeast(value?.version, "0.21.1") && value.ready === true;
  } catch { return false; }
}

export function hermesPeerContextEnvironment(options: Pick<SendOptions, "environment" | "peerContext">): Record<string, string> {
  const url = options.environment?.AGENT_PHONON_PEER_CONTEXT_URL, token = options.environment?.AGENT_PHONON_PEER_CONTEXT_TOKEN;
  if (!options.peerContext) return { PHONON_HERMES_PEER_CONTEXT: "", AGENT_PHONON_PEER_CONTEXT_URL: "", AGENT_PHONON_PEER_CONTEXT_TOKEN: "" };
  const endpoint = new URL(url ?? "");
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/peer-context"
    || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) throw new Error("Hermes peer checkpoint requires an owned local capability");
  return { PHONON_HERMES_PEER_CONTEXT: JSON.stringify({url,token}), AGENT_PHONON_PEER_CONTEXT_URL: "", AGENT_PHONON_PEER_CONTEXT_TOKEN: "" };
}

/** Shared native middleware; the caller supplies the authority for its root invocation. */
export const HERMES_PEER_CONTEXT_RUNTIME = String.raw`
def _phonon_register_peer_context(agent, capsule, owning_root, announce):
    handles = []
    pending = {}
    live = True
    def close():
        nonlocal live
        live = False
        pending.clear()
        for handle in reversed(handles):
            try:
                handle.dispose()
            except Exception:
                pass
    try:
        import re, uuid, urllib.parse, http.client, copy
        from importlib.metadata import version
        from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
        from hermes_cli.middleware import VALID_MIDDLEWARE
        native_version = re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", version("hermes-agent"))
        if not native_version or tuple(map(int, native_version.groups())) < (0, 21, 1) or not callable(PluginContext.register_middleware) or not callable(get_plugin_manager) or not {"llm_request", "llm_execution"}.issubset(VALID_MIDDLEWARE):
            raise ValueError()
        endpoint = urllib.parse.urlsplit(capsule["url"])
        secret = capsule["token"]
        if (endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port or endpoint.path != "/peer-context"
                or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or not re.fullmatch(r"[A-Za-z0-9_-]{43}", secret)):
            raise ValueError()
        sid = getattr(agent, "session_id", None)
        if not isinstance(sid, str) or not sid or len(sid) > 512:
            raise ValueError()
        native_mode = getattr(agent, "api_mode", "")
        if native_mode not in ("chat_completions", "anthropic_messages", "codex_responses"):
            raise ValueError()
        owner_thread = threading.get_ident()
        def owning(context):
            return (live and owning_root(context)
                    and threading.get_ident() == owner_thread and context.get("session_id") == sid
                    and str(getattr(agent, "session_id", "")) == sid)
        def checkpoint(path, value):
            connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=1.5)
            try:
                connection.request("POST", path, json.dumps(value), {"Authorization":"Bearer " + secret, "Content-Type":"application/json"})
                response = connection.getresponse()
                raw = response.read(65537)
                if response.status != 200 or len(raw) > 65536:
                    raise ValueError()
                return json.loads(raw)
            finally:
                connection.close()
        def contains(value, text):
            if isinstance(value, str):
                return value == text
            if isinstance(value, list):
                return any(contains(item, text) for item in value)
            if isinstance(value, dict):
                return any(contains(item, text) for item in value.values())
            return False
        def native_budget(request, context):
            unknown = {"state":"unknown","source":"native_estimate"}
            try:
                engine = getattr(agent, "context_compressor", None)
                model = getattr(agent, "model", None)
                window = getattr(engine, "context_length", None)
                if (not isinstance(model, str) or not model or context.get("model") != model or request.get("model") != model
                        or getattr(engine, "model", None) != model
                        or context.get("base_url") != getattr(agent, "base_url", None)
                        or getattr(engine, "base_url", None) != getattr(agent, "base_url", None)
                        or getattr(engine, "api_mode", None) != native_mode
                        or type(window) is not int or not 0 < window <= 1000000000):
                    return unknown
                extra = request.get("extra_body")
                if extra is not None and (not isinstance(extra, dict) or extra.get("model", model) != model):
                    return unknown
                caps = [source[key] for source in (request, request.get("extra_body") or {}) if isinstance(source, dict)
                    for key in ("max_tokens", "max_completion_tokens", "max_output_tokens") if key in source]
                if not caps or any(type(value) is not int or not 0 < value <= 1000000000 for value in caps):
                    return unknown
                encoded = len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf8"))
                if encoded > 1000000000:
                    return unknown
                return {"state":"known","source":"native_estimate","contextWindowTokens":window,
                    "inputTokens":encoded,"outputTokens":max(caps),"overheadTokens":1024}
            except Exception:
                return unknown
        def prepare(request=None, **context):
            if not owning(context) or not isinstance(request, dict) or context.get("api_mode") != native_mode:
                return None
            request_id = context.get("api_request_id")
            if not isinstance(request_id, str) or not request_id or len(pending) >= 256:
                return None
            field = "input" if native_mode == "codex_responses" else "messages"
            if not isinstance(request.get(field), list):
                return None
            boundary = {"boundaryId":str(uuid.uuid4()),"nativeSessionId":sid}
            try:
                result = checkpoint("/peer-context", {**boundary,"budget":native_budget(request, context)})
                if (not owning(context) or not isinstance(result, dict) or result.get("boundaryId") != boundary["boundaryId"]
                        or result.get("nativeSessionId") != sid or not isinstance(result.get("messages"), list) or len(result["messages"]) > 8):
                    return None
                messages = result["messages"]
                if not messages or any(not isinstance(item, dict) or not isinstance(item.get("messageId"), str)
                        or not isinstance(item.get("content"), str) for item in messages):
                    return None
                changed = copy.deepcopy(request)
                rows = []
                for message in messages:
                    content = message["content"]
                    if native_mode == "codex_responses":
                        row = {"type":"message","role":"user","content":[{"type":"input_text","text":content}]}
                    else:
                        row = {"role":"user","content":[{"type":"text","text":content}]}
                    changed[field].append(row)
                    rows.append(row)
                pending[request_id] = {**boundary,"messages":messages,"rows":rows}
                return {"request":changed,"source":"phonon-peer-context"}
            except Exception:
                return None
        def withdraw(request, current):
            # Withdraw only our exact rows; retain other native middleware changes.
            field = "input" if native_mode == "codex_responses" else "messages"
            if not isinstance(request, dict) or not isinstance(request.get(field), list):
                raise ValueError("Native input withdrawal could not be confirmed")
            clean = copy.deepcopy(request)
            rows = list(current["rows"])
            retained = []
            for row in clean[field]:
                if row in rows:
                    rows.remove(row)
                else:
                    retained.append(row)
            if rows:
                raise ValueError("Native input withdrawal could not be confirmed")
            clean[field] = retained
            return clean
        def execute(request=None, next_call=None, **context):
            if not callable(next_call):
                raise ValueError("Native execution callback unavailable")
            current = pending.pop(context.get("api_request_id"), None)
            if current:
                if not owning(context):
                    request = withdraw(request, current)
                else:
                    message_ids = [item["messageId"] for item in current["messages"] if contains(request, item["content"])]
                    if message_ids:
                        try:
                            checkpoint("/peer-context/observe", {"boundaryId":current["boundaryId"],"nativeSessionId":sid,
                                "messageIds":message_ids,"evidence":"provider_payload"})
                        except Exception:
                            request = withdraw(request, current)
            # Never retry the provider callback here or swallow its native exception.
            return next_call(request)
        manager = get_plugin_manager()
        manager.discover_and_load()
        plugin_id = "phonon-runtime-peer-context"
        if any(loaded.get("key") == plugin_id or loaded.get("name") == plugin_id
                for loaded in manager.list_plugins()):
            raise ValueError("Phonon runtime peer registration name is already owned")
        manifest = PluginManifest(name=plugin_id, source="runtime")
        context = PluginContext(manifest, manager)
        handles.append(context.register_middleware("llm_request", prepare))
        handles.append(context.register_middleware("llm_execution", execute))
        if any(not getattr(handle, "active", False) for handle in handles):
            raise ValueError()
        announce({"type":"hermes_peer_ready","native_session_id":sid})
        return close
    except Exception:
        close()
        announce({"type":"hermes_runtime_warning","code":"peer_context_unavailable"})
        return lambda: None
`;

/** Registers native callbacks in the existing owned runtime, without modifying an installation. */
export const HERMES_PEER_CONTEXT_BRIDGE = String.raw`
_phonon_peer_payload = os.environ.pop("PHONON_HERMES_PEER_CONTEXT", "")
_phonon_peer_secret = ""
if _phonon_peer_payload:
    try:
        _phonon_peer_secret = json.loads(_phonon_peer_payload).get("token", "")
    except Exception:
        pass
${HERMES_PEER_CONTEXT_RUNTIME}
def _phonon_install_peer_context(agent):
    if not _phonon_peer_payload:
        return lambda: None
    try:
        capsule = json.loads(_phonon_peer_payload)
    except Exception:
        return lambda: None
    return _phonon_register_peer_context(agent, capsule,
        lambda context: root_agent is agent and root_invocations == 1, emit)
`;
