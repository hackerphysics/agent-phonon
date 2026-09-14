/**
 * Narrow instrumentation of the installed Hermes CLI, not an inference client.
 * 0.16's -z drops run_conversation's failure fields; ACP also returns end_turn
 * for failures. Keep native chat/config/profile/session/auth/tool execution and
 * observe the actual structured return before the CLI renders it as prose.
 * Embedded so bundled daemon distributions need no separate Python asset.
 */
export const HERMES_BRIDGE = String.raw`
import sys, json, os
wire = sys.stdout
sys.stdout = sys.stderr
sys.argv = sys.argv[1:]
# Match the console-script import path, not the untrusted project cwd.
sys.path[0] = os.path.dirname(os.path.realpath(sys.argv[0]))

def emit(value):
    wire.write(json.dumps(value, ensure_ascii=False) + "\n")
    wire.flush()

# Import main FIRST: it applies --profile and native dotenv precedence before
# modules cache HERMES_HOME. Do not read or copy any native authentication cache.
from hermes_cli.main import main
from hermes_cli.config import load_config
cfg = load_config()
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

def observe(self, *args, **kwargs):
    global root_agent
    if root_agent is not None:
        return native_run(self, *args, **kwargs)
    root_agent = self
    history = kwargs.get("conversation_history") or (args[2] if len(args) > 2 else []) or []
    old_ids = {c.get("id") for m in history if isinstance(m, dict) for c in (m.get("tool_calls") or [])}
    result = native_run(self, *args, **kwargs)
    if not isinstance(result, dict):
        emit({"type": "hermes_result", "completed": False, "error": "Native structured result unavailable"})
        return result
    # Actual model call ids and actual tool messages, not UI preview or final text.
    calls = set()
    for m in result.get("messages", []):
        if not isinstance(m, dict):
            continue
        for c in m.get("tool_calls", []) or []:
            cid = c.get("id")
            if cid and cid not in old_ids and cid not in calls:
                calls.add(cid)
                emit({"type": "hermes_tool_call", "call": c})
        if m.get("role") == "tool" and m.get("tool_call_id") in calls:
            emit({"type": "hermes_tool_result", "message": m})
    emit({"type": "hermes_result", **{k: result.get(k) for k in
        ("completed", "failed", "partial", "interrupted", "error", "final_response")},
        "session_id": getattr(self, "session_id", None)})
    return result

AIAgent.run_conversation = observe
try:
    main()
except SystemExit:
    raise
except Exception as exc:
    # Native diagnostics can contain provider secrets; use native redaction before
    # crossing the bridge, then the TypeScript diagnostic redactor as a second pass.
    from agent.redact import redact_sensitive_text
    emit({"type": "hermes_result", "completed": False, "error": redact_sensitive_text(str(exc), force=True)})
    sys.exit(1)
`;
