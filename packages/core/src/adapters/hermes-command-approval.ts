import type { SendOptions } from "../adapter.js";
import { verifiedNativeToolChannel } from "../native-tool-channel.js";
import { PhononError } from "../rpc.js";

/** Controller-owned human channel; never a model-selected approval policy. */
export function hermesCommandApprovalEnvironment(options: SendOptions): Record<string, string> {
  if (!options.requestInteraction || !options.acknowledgeInteraction) return { PHONON_HERMES_APPROVAL_CONTEXT: "" };
  try {
    const { interaction, token } = verifiedNativeToolChannel(options.environment ?? {});
    const receipt = new URL("/applied", interaction).href;
    if (options.environment?.AGENT_PHONON_INTERACTION_RECEIPT_URL !== receipt) throw Error("unpaired receipt");
    return { PHONON_HERMES_APPROVAL_CONTEXT: JSON.stringify({ v: 1, url: interaction.href, receipt, token }) };
  } catch {
    throw new PhononError("errCapabilityUnsupported", "Hermes command approval requires a verified paired human channel");
  }
}

// Native command detection, hardline/deny rules, smart/manual selection and the
// actual command execution remain Hermes-owned. This supplies only a human UI.
export const HERMES_COMMAND_APPROVAL_BRIDGE = String.raw`
_phonon_approval_payload = os.environ.pop("PHONON_HERMES_APPROVAL_CONTEXT", "")
_phonon_approval_secret = ""
_phonon_approval_capsule = None
if _phonon_approval_payload:
    try:
        import re
        from urllib.parse import urlsplit
        _c = json.loads(_phonon_approval_payload)
        if not isinstance(_c, dict) or set(_c) != {"v", "url", "receipt", "token"} or type(_c["v"]) is not int or _c["v"] != 1:
            raise ValueError()
        for _name, _path in (("url", "/interaction"), ("receipt", "/applied")):
            _u = urlsplit(_c[_name])
            if _u.scheme != "http" or _u.hostname != "127.0.0.1" or not _u.port or _u.username or _u.password or _u.path != _path or _u.query or _u.fragment:
                raise ValueError()
        if urlsplit(_c["url"]).netloc != urlsplit(_c["receipt"]).netloc or not re.fullmatch(r"[A-Za-z0-9_-]{43}", _c["token"]):
            raise ValueError()
        _phonon_approval_capsule = _c
        _phonon_approval_secret = _c["token"]
    except Exception:
        raise RuntimeError("Invalid Phonon human approval channel") from None

def _phonon_install_command_approval():
    if _phonon_approval_capsule is None:
        return lambda: None
    # Register a real callback before declaring a human-present command surface.
    # -q normally has nobody listening. Here a controller-validated Phonon human
    # is reachable. No deny rule, scanner, config, allowlist or gate is patched.
    from tools.terminal_tool import set_approval_callback, _get_approval_callback
    from tools.approval_context import set_hermes_interactive_context, reset_hermes_interactive_context, _get_approval_timeout
    from tools.thread_context import propagate_context_to_thread
    from tools.interrupt import is_interrupted
    from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler, Request
    import uuid, time, socket
    if not callable(propagate_context_to_thread):
        raise RuntimeError("Native approval callback propagation unavailable")
    capsule = dict(_phonon_approval_capsule)
    active = threading.Event()
    active.set()
    old_callback = _get_approval_callback()
    old_environment = {key: os.environ.get(key) for key in ("HERMES_SINGLE_QUERY_SESSION", "HERMES_EXEC_ASK")}

    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError("Approval endpoint redirect refused")
    opener = build_opener(ProxyHandler({}), NoRedirect())

    def live():
        return active.is_set() and not is_interrupted()

    def post(url, body, remaining):
        if not live() or remaining <= 0:
            raise ValueError("Approval turn expired")
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if len(data) > 60000:
            raise ValueError("Approval request too large")
        request = Request(url, data=data, method="POST", headers={"Authorization": "Bearer " + capsule["token"], "Content-Type": "application/json"})
        with opener.open(request, timeout=remaining) as response:
            if response.status != 200 or response.geturl() != url:
                raise ValueError("Approval response unavailable")
            raw = response.read(65537)
        if len(raw) > 65536 or not live():
            raise ValueError("Approval turn expired")
        return json.loads(raw)

    def ask(command, description, **_scope):
        # Only once/deny. A successful request/notification is NOT authorization.
        try:
            if not live() or not isinstance(command, str) or not isinstance(description, str):
                return "deny"
            if len(command) > 16000 or len(description) > 8000:
                return "deny"  # Never ask approval for a silently truncated command.
            timeout = min(300, max(1, int(_get_approval_timeout())))
            deadline = time.monotonic() + timeout
            request_id = str(uuid.uuid4())
            command = command.replace(capsule["token"], "[REDACTED]")
            description = description.replace(capsule["token"], "[REDACTED]")
            body = {"requestId": request_id, "timeoutSeconds": timeout,
                    "presentation": {"kind": "approval", "decisionField": "approve", "feedbackField": "feedback"},
                    "form": {"title": "命令执行审批 / Command approval", "description": "仅批准本次执行 / Allow this operation once.\n\nAgent process directory (the original tool may specify a different workdir): " + os.getcwd() + "\n\nCommand:\n" + command + "\n\nReason:\n" + description,
                             "fields": [{"key": "approve", "label": "批准本次执行 / Approve once", "type": "boolean", "required": True, "defaultValue": False},
                                        {"key": "feedback", "label": "反馈 / Feedback", "type": "textarea", "required": False}],
                             "submitLabel": "提交决定 / Submit decision", "cancelLabel": "拒绝 / Deny"}}
            reply = post(capsule["url"], body, deadline - time.monotonic())
            if not isinstance(reply, dict) or reply.get("requestId") != request_id:
                return "deny"
            if reply.get("action") == "timeout":
                return "timeout"
            if reply.get("action") != "submit":
                return "deny"
            proof = reply.get("decisionHash")
            if not isinstance(proof, str) or not re.fullmatch(r"[a-f0-9]{64}", proof):
                return "deny"
            values = reply.get("values")
            allowed = isinstance(values, dict) and values.get("approve") is True
            receipt = post(capsule["receipt"], {"requestId": request_id, "decisionHash": proof}, deadline - time.monotonic())
            if not isinstance(receipt, dict) or receipt.get("applied") is not True or not live() or time.monotonic() >= deadline:
                return "deny"
            return "once" if allowed else "deny"
        except (TimeoutError, socket.timeout):
            return "timeout"
        except Exception:
            # Never include exceptions/URLs/credentials in model-visible errors.
            return "deny"

    set_approval_callback(ask)
    context = set_hermes_interactive_context(True)
    # Ask-mode also guards whole execute_code scripts; a mere CLI flag would
    # leave those scripts implicitly approved. Preserve cron/unattended policy.
    os.environ["HERMES_SINGLE_QUERY_SESSION"] = ""
    os.environ["HERMES_EXEC_ASK"] = "1"
    def close():
        active.clear()
        set_approval_callback(old_callback)
        reset_hermes_interactive_context(context)
        for key, value in old_environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    return close
`;
