# Pi Current-Turn Native Tools

Pi's pre-tool HITL gate and native conversation/Dev tools are separate features.
An optional HITL hook does not register model-callable tools. When a controller
provides `requestInteraction`, the Pi adapter now loads an invocation-scoped
native extension even when no pre-tool HITL bridge is configured.

The extension discovers the real current-turn MCP catalog using the paired
loopback endpoints/capability already issued by AgentInteractionBridge. A Dev
worker receives the interaction/request-acknowledgement tools only; other scopes
receive only the channels actually offered by their controller. Unknown names,
reserved-name collisions and missing channels fail closed. No global Pi settings,
profile permission, shell policy or automatic approval decision is changed.

Capabilities remain in the child environment, never argv or materialized source.
Controller requests use direct loopback HTTP, not the model process's proxy
environment; provider proxy settings and other native configuration are unchanged.
The private generated extension is removed when its invocation settles. A fresh
nonce acknowledges successful catalog/extension initialization; the adapter does
not release the prompt to stdin until this and any original native-recovery
guard acknowledgement are present. Pi binds runtime inspection APIs after
factory loading, so tool registration/selection validation runs at session start,
before inference. Source/schema/active-selection checks also run before provider
requests, preserving explicit tool exclusions rather than overriding them. Unsupported loaders never
silently become model turns without the required tools.

Native requests and applied receipts retain the existing controller-owned scope,
request identity, immutable hash, timeout/cancellation and stopped-turn fences.
There is no protocol/SDK contract change. Errors remain unconfirmed and do not
authorize new request IDs or infer human permission. Pi recovery continues to
select and verify the original native Session file.

See `fn-pi-native-tools.test.ts` for actual adapter/subprocess tests and the shared
native MCP tests for source/decision authority. Tests use a deterministic CLI;
record real installed-Pi/provider acceptance separately. The first G5 live Pi
attempt correctly reported missing tools and remains a negative outcome, not an
execution to replay after this change.
