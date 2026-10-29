# Claude Code Current-Turn Input

The local binding uses the installed Claude Code 2.0.1 bundled public SDK and
the Node runtime paired with that owner-selected CLI. It does not patch an
installed launcher/SDK, install another dependency tree, change credentials or
rewrite personal configuration. The SDK parent and native child use the paired
interpreter; the owned startup preload restores the original tool PATH.

Streaming stdin is not the insertion primitive. Installed characterization
observes the same message entering a tool result and then being repeated as a
later native input, with an additional model request. A streaming or replay
acknowledgement therefore cannot be relabelled as exactly one current-task
insertion.

The insertion path uses the original root's qualified `PostToolUse` context
API in one single-input SDK query. The original prompt, native session/cwd,
transcript path, observed root tool ID, startup-policy proof and native token
headroom must match. Child tool callbacks cannot drain the root inbox.

The controller authorizes the batch before native context effects. The binding
reports context application only after that hook output and the same original
root's next native `message_start` continuation. An offer alone cannot finish
the input. This is native-context application, not a fabricated native user
message or provider-payload/remote-consumption observation. Peer data retains
its separate weaker evidence ceiling.

The SDK ends the single original query normally. A completed/aborted query
rejects unconfirmed input and closes its private channel; no queued prompt,
query restart or second task is used to obtain a receipt. Existing native
permission settings, explicit tool denial and owner-selected standalone
settings remain authoritative.

Installed tests use an isolated home and controlled local Anthropic provider,
not paid-model or physical cross-device evidence. Adapter activation and the
shared effect-boundary source guards remain local until the concurrent
project-authority changes can be integrated without absorbing unrelated work.
