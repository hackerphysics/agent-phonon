import {HERMES_NATIVE_TOOLS_BRIDGE} from "./hermes-native-tools.js";
import {HERMES_PEER_CONTEXT_BRIDGE} from "./hermes-peer-context.js";

/**
 * Narrow instrumentation of the installed Hermes CLI, not an inference client.
 * 0.16's -z drops run_conversation's failure fields; ACP also returns end_turn
 * for failures. Keep native chat/config/profile/session/auth/tool execution and
 * observe the actual structured return before the CLI renders it as prose.
 * Embedded so bundled daemon distributions need no separate Python asset.
 */
export const HERMES_BRIDGE = String.raw`
import sys, json, os, threading
wire = sys.stdout
wire_lock = threading.RLock()
sys.stdout = sys.stderr
sys.argv = sys.argv[1:]
# Match the console-script import path, not the untrusted project cwd.
sys.path[0] = os.path.dirname(os.path.realpath(sys.argv[0]))
expected_profile_home = os.environ.pop("PHONON_HERMES_EXPECTED_PROFILE_HOME", "")

def emit(value):
    payload = json.dumps(value, ensure_ascii=False)
    capability = globals().get("_phonon_tools_secret")
    if isinstance(capability, str) and capability:
        payload = payload.replace(capability, "[REDACTED]")
    peer_capability = globals().get("_phonon_peer_secret")
    if isinstance(peer_capability, str) and peer_capability:
        payload = payload.replace(peer_capability, "[REDACTED]")
    with wire_lock:
        wire.write(payload + "\n")
        wire.flush()

# PHONON_NATIVE_TOOLS
# PHONON_PEER_CONTEXT

# Import main FIRST: it applies --profile and native dotenv precedence before
# modules cache HERMES_HOME. Do not read or copy any native authentication cache.
from hermes_cli.main import main
from hermes_cli.config import load_config
try:
    from hermes_constants import get_hermes_home
    profile_home = str(get_hermes_home().resolve())
except Exception:
    profile_home = None
emit({"type":"hermes_runtime", "profile_home":profile_home})
if expected_profile_home and (not profile_home or os.path.realpath(profile_home) != os.path.realpath(expected_profile_home)):
    emit({"type":"hermes_result", "completed":False, "error":"Native Hermes profile identity changed before inference"})
    sys.exit(2)
cfg = load_config()
_phonon_setup_native_tools(cfg)
model_cfg = cfg.get("model") or {}
# Explicit Phonon model selection must not auto-detect away from a configured
# named provider. Keep keys and references in native Hermes' resolver.
if "--provider" not in sys.argv and isinstance(model_cfg, dict):
    provider = model_cfg.get("provider")
    providers = cfg.get("providers") or {}
    if isinstance(providers, dict) and provider in providers:
        sys.argv += ["--provider", provider]

from run_agent import AIAgent
native_run = AIAgent.run_conversation
root_agent = None
root_result = None
root_invocations = 0
_phonon_install_native_tool_scope(AIAgent)
reasoning_request = json.loads(os.environ.pop("PHONON_REASONING_REQUEST", "") or "null")
expected_session = json.loads(os.environ.pop("PHONON_HERMES_EXPECTED_SESSION", "") or "null")

def observe(self, *args, **kwargs):
    global root_agent, root_result, root_invocations
    if root_agent is not None:
        if self is root_agent:
            root_invocations += 1
        return native_run(self, *args, **kwargs)
    root_agent = self
    root_invocations = 1
    if not _phonon_refresh_native_tools(self):
        return {"completed": False, "error": "Native Hermes current-turn MCP tools unavailable"}
    history = kwargs.get("conversation_history") if "conversation_history" in kwargs else (args[2] if len(args) > 2 else None)
    if history is None:
        history = []
    if expected_session is not None:
        if (str(getattr(self, "session_id", "")) != expected_session["sessionId"]
                or profile_home != expected_session["home"]
                or os.path.realpath(os.getcwd()) != os.path.realpath(expected_session["cwd"])):
            result = {"completed": False, "error": "Native Session identity changed before inference"}
            emit({"type": "hermes_result", **result})
            return result
        if not isinstance(history, list) or not any(isinstance(message, dict) and message.get("role") in ("user", "assistant", "system", "tool") for message in history):
            result = {"completed": False, "error": "Native resumed history unavailable before inference"}
            emit({"type": "hermes_result", **result})
            return result
    if reasoning_request is not None:
        config = getattr(self, "reasoning_config", None)
        observed = "off" if isinstance(config, dict) and config.get("enabled") is False else (config.get("effort") if isinstance(config, dict) else None)
        if observed in ("off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto", "adaptive"):
            emit({"type": "hermes_reasoning", "native_value": observed})
    close_peer_context = _phonon_install_peer_context(self)
    old_ids = {c.get("id") for m in history if isinstance(m, dict) for c in (m.get("tool_calls") or [])}
    calls, results = set(), set()
    live = True
    original_start = getattr(self, "tool_start_callback", None)
    original_complete = getattr(self, "tool_complete_callback", None)
    try:
        from agent.delegation_context import is_dispatcher_owned_worker_context
        has_tool_callbacks = hasattr(self, "tool_start_callback") and hasattr(self, "tool_complete_callback")
    except ImportError:
        has_tool_callbacks = False

    def publish_call(call):
        cid, fn = call.get("id"), call.get("function") or {}
        if not isinstance(cid, str) or not cid or cid in old_ids or cid in calls or not isinstance(fn.get("name"), str) or not fn["name"]:
            return
        emit({"type": "hermes_tool_call", "call": call})
        calls.add(cid)

    def publish_result(message, name):
        cid = message.get("tool_call_id")
        if cid not in calls or cid in results:
            return
        content = message.get("content")
        projected = dict(message)
        try:
            from agent.display import _detect_tool_failure
            projected["is_error"] = bool(message.get("is_error")) or _detect_tool_failure(name, content)[0]
        except Exception:
            pass
        # Native display callbacks precede transcript spill/budget reduction.
        encoded = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        if len(encoded) > 131072:
            projected["content"] = encoded[:131072] + "\n[Phonon tool output excerpt; remaining content omitted]"
        emit({"type": "hermes_tool_result", "message": projected})
        results.add(cid)

    def started(cid, name, arguments):
        try:
            with wire_lock:
                if live and is_dispatcher_owned_worker_context():
                    publish_call({"id": cid, "function": {"name": name, "arguments": arguments}})
        finally:
            if callable(original_start):
                original_start(cid, name, arguments)

    def completed(cid, name, arguments, content):
        try:
            with wire_lock:
                if live and is_dispatcher_owned_worker_context():
                    publish_call({"id": cid, "function": {"name": name, "arguments": arguments}})
                    publish_result({"tool_call_id": cid, "content": content}, name)
        finally:
            if callable(original_complete):
                original_complete(cid, name, arguments, content)

    if has_tool_callbacks:
        self.tool_start_callback, self.tool_complete_callback = started, completed
    # Hermes already streams: run_conversation takes stream_callback invoked with
    # each text delta (see cli.py / chat_completion_helpers). The CLI passes its own
    # callback (TTS text_queue), so chain onto it rather than replacing it.
    existing = kwargs.get("stream_callback")
    if existing is None and len(args) >= 5:
        existing = args[4]
    def chained(delta):
        try:
            emit({"type": "hermes_text_delta", "text": delta})
        except Exception:
            pass
        if callable(existing):
            existing(delta)
    if "stream_callback" in kwargs:
        kwargs = dict(kwargs)
        kwargs["stream_callback"] = chained
    elif len(args) >= 5:
        args = list(args)
        args[4] = chained
        args = tuple(args)
    else:
        kwargs = dict(kwargs)
        kwargs["stream_callback"] = chained
    try:
        result = native_run(self, *args, **kwargs)
    finally:
        close_peer_context()
        _phonon_native_turn_finished(self)
        with wire_lock:
            live = False
            if has_tool_callbacks:
                if self.tool_start_callback is started:
                    self.tool_start_callback = original_start
                if self.tool_complete_callback is completed:
                    self.tool_complete_callback = original_complete
    if not isinstance(result, dict):
        emit({"type": "hermes_result", "completed": False, "error": "Native structured result unavailable"})
        return result
    root_result = result
    # Reconcile older runtimes and calls without callbacks; never replay live pairs.
    names = {}
    for m in result.get("messages", []):
        if not isinstance(m, dict):
            continue
        for c in m.get("tool_calls", []) or []:
            cid = c.get("id")
            if cid:
                names[cid] = (c.get("function") or {}).get("name", "")
                publish_call(c)
        if m.get("role") == "tool" and m.get("tool_call_id") in calls:
            publish_result(m, names.get(m.get("tool_call_id"), ""))
    emit({"type": "hermes_result", **{k: result.get(k) for k in
        ("completed", "failed", "partial", "interrupted", "error", "final_response")},
        "session_id": getattr(self, "session_id", None)})
    return result

AIAgent.run_conversation = observe

def finalize_legacy_quiet_session():
    # 0.16's -Q/-q path exits before the interactive CLI's native cli_close.
    # Close only this successful root invocation using its existing native DB.
    if root_agent is None or root_invocations != 1 or not isinstance(root_result, dict) or root_result.get("completed") is not True:
        return
    if any(root_result.get(key) for key in ("failed", "partial", "interrupted", "error")) or not str(root_result.get("final_response") or "").strip():
        return
    if "chat" not in sys.argv or "-Q" not in sys.argv or "-q" not in sys.argv:
        return
    try:
        from importlib.metadata import version
        if version("hermes-agent").split(".")[:2] != ["0", "16"]:
            return
        import sqlite3, math
        from pathlib import Path
        from hermes_state import SessionDB
        db = getattr(root_agent, "_session_db", None)
        sid = getattr(root_agent, "session_id", None)
        if not isinstance(db, SessionDB) or getattr(db, "read_only", True) is not False or not isinstance(sid, str) or not sid:
            raise ValueError()
        conn = getattr(db, "_conn", None)
        if not isinstance(conn, sqlite3.Connection) or not profile_home:
            raise ValueError()
        path = Path(profile_home) / "state.db"
        if path.is_symlink() or not path.is_file():
            raise ValueError()
        main = [row for row in conn.execute("PRAGMA database_list") if row[1] == "main"]
        if len(main) != 1 or Path(main[0][2]).resolve(strict=True) != path.resolve(strict=True):
            raise ValueError()
        row = db.get_session(sid)
        if not row or row.get("id") != sid or row.get("source") != "cli" or row.get("archived") != 0 or row.get("parent_session_id") is not None:
            raise ValueError()
        if Path(row["cwd"]).resolve(strict=True) != Path.cwd().resolve(strict=True):
            raise ValueError()
        if conn.execute("SELECT 1 FROM sessions WHERE parent_session_id=? LIMIT 1", (sid,)).fetchone() is not None or conn.execute("SELECT 1 FROM compression_locks WHERE session_id=? LIMIT 1", (sid,)).fetchone() is not None:
            raise ValueError()
        if row.get("ended_at") is None:
            db.end_session(sid, "cli_close")
        observed = db.get_session(sid)
        if not observed or observed.get("ended_at") is None or not math.isfinite(float(observed["ended_at"])):
            raise ValueError()
    except Exception:
        # Task success is not permission to retry if native cleanup failed.
        emit({"type": "hermes_runtime_warning", "code": "native_session_finalization_unavailable"})

try:
    main()
except SystemExit as exc:
    if exc.code is None or type(exc.code) is int and exc.code == 0:
        finalize_legacy_quiet_session()
    raise
except Exception as exc:
    # Native diagnostics can contain provider secrets; use native redaction before
    # crossing the bridge, then the TypeScript diagnostic redactor as a second pass.
    from agent.redact import redact_sensitive_text
    emit({"type": "hermes_result", "completed": False, "error": redact_sensitive_text(str(exc), force=True)})
    sys.exit(1)
else:
    finalize_legacy_quiet_session()
`.replace("# PHONON_NATIVE_TOOLS", HERMES_NATIVE_TOOLS_BRIDGE).replace("# PHONON_PEER_CONTEXT", HERMES_PEER_CONTEXT_BRIDGE);
