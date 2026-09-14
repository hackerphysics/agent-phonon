#!/usr/bin/env python3
"""Foreground, loopback-only LiteLLM with a process-local compatibility binding."""
import argparse
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--home", required=True, help="Dedicated empty runtime home (not the real user HOME)")
parser.add_argument("--audit", help="Opt-in private acceptance event log; includes model text/tool results")
args = parser.parse_args()
home = Path(args.home).resolve()
if home == Path.home() or not home.is_dir():
    parser.error("--home must be an existing dedicated runtime directory, not the user HOME")
audit_path = str(Path(args.audit).resolve()) if args.audit else None
# No inherited credentials, OAuth, shell startup, user proxy, or telemetry settings.
os.environ.clear()
os.environ.update({"HOME": str(home), "PATH": str(Path(sys.executable).parent) + ":/usr/bin:/bin",
                   "NO_COLOR": "1", "LITELLM_LOCAL_MODEL_COST_MAP": "True", "LITELLM_TELEMETRY": "False",
                   "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
                   "NO_PROXY": "127.0.0.1,localhost"})
if audit_path:
    os.environ["PHONON_COMPAT_AUDIT"] = audit_path

import httpx
from compat import audit, install


def guard(request):
    u = request.url
    if u.scheme != "http" or u.host != "127.0.0.1" or u.port != 4000 or u.path != "/v1/responses" or u.query or u.userinfo:
        raise RuntimeError("Converter permits only local4000 /v1/responses")
    import json
    body = json.loads(request.content)
    if body.get("model") != "gpt-5.6-sol" or body.get("store") is not False:
        raise RuntimeError("Converter model/store boundary rejected")
    if request.headers.get("authorization") not in (None, "Bearer local-no-auth-placeholder"):
        raise RuntimeError("Converter credential boundary rejected")
    audit("upstream_request", url=str(u), model=body.get("model"), stream=body.get("stream"), store=body.get("store"),
          known_nonsecret_auth=True, input=[i for i in body.get("input", []) if isinstance(i, dict) and i.get("type") in ("function_call", "function_call_output")])


sync_send = httpx.Client.send
async_send = httpx.AsyncClient.send


def send(self, request, *args, **kwargs):
    guard(request)
    kwargs["follow_redirects"] = False
    return sync_send(self, request, *args, **kwargs)


async def asend(self, request, *args, **kwargs):
    guard(request)
    kwargs["follow_redirects"] = False
    return await async_send(self, request, *args, **kwargs)


httpx.Client.send = send
httpx.AsyncClient.send = asend
install()
from litellm import run_server
sys.argv = ["litellm", "--host", "127.0.0.1", "--port", "24339", "--num_workers", "1",
            "--telemetry", "False", "--config", str(HERE / "config.yaml")]
run_server()
