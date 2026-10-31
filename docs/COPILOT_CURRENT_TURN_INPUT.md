# Copilot Current-Turn Input

The locally qualified binding uses the owner-selected Copilot CLI 1.0.82 with
`--no-auto-update` and its bundled extension SDK. It preserves native lifecycle,
provider selection, configuration and observed UUID resume. It does not replace
the CLI with a direct SDK session, install another dependency tree or patch an
installed runtime.

The existing invocation-only Phonon plugin returns `additionalContext` at a
successful original-root PostToolUse boundary. Ordinary input selects the
adapter-owned `native_context` binding explicitly; the original single stdin
prompt remains unchanged. Initial prompt hooks, unrelated hooks and child tools
cannot drain ordinary input.

Before returning context, the private controller authorizes the exact offered
batch again. Acceptance then requires the native root's exact hook invocation,
successful hook output, matching successful tool-result content and subsequent
root loop continuation with the same interaction identity. Hook output alone,
a different model/tool/loop, child continuation, compaction, pending human input
or a closed binding cannot confirm insertion. The native-context receipt is not
provider-payload or remote model-consumption evidence. Peer observations retain
their separate `context_hook` ceiling.

The strict local `copilotPeerContext: true` opt-in remains necessary. The native
operator must also have enabled and authorized the extension in that location.
Production adds no experimental, allow-tool, allow-all or yolo flags and never
grants that consent automatically. Missing consent preserves the original CLI
task without claiming insertion. Unconfirmed input is not queued or replayed.

Installed tests reuse the existing native cache and SDK with isolated homes and
a controlled local provider. Fixture-only consent applies only to synthetic
locations and is not an implementation fallback. Both streaming and nonstreaming
native requests are handled by the provider fixture. Tests check actual original
provider input separately from the native application receipt.

October 29 local checkpoint: all 161 combined focused cases passed with no
failures or skips, including actual insertion before final completion, source
withdrawal, child isolation, native denial, stop and same-UUID continuation.
Shared current-turn input, native peer receipts, Pi RPC and durable workflow
input regressions passed in the same run.

The receipt/plugin foundation and adapter use the shared original-window/source
fence without importing separate directory-admission changes. There is no
release, production activation or managed-MCP cross-session acceptance claim
here.
