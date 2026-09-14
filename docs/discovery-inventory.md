# Shared discovery inventory and producer boundaries

## Inventory lifecycle

`AdapterRegistry.inventory` is the single inventory/cache for a registry. The daemon takes a startup lease and awaits the initial bounded snapshot before dialing servers. Connections take callback leases, including embedded `PhononClient`/`PhononConnection` users. Last release cancels polling and scans; daemon stop permanently disposes inventory before closing clients/adapters/store. Reconnect takes a new lease and reads the current list; notifications are invalidations, not a durable replay queue.

Owner configuration (optional, backwards compatible):

```json
{"discovery":{"pollIntervalMs":30000,"scanTimeoutMs":20000}}
```

Polling starts after the preceding scan completes. The range is 100–3,600,000 ms for polling and 50–120,000 ms for each adapter deadline; low values are for isolated tests, not recommended production defaults. `discovery.list/get` share this TTL and in-flight scan, rather than starting one native scan per connection/request. An embedded owner can call `registry.inventory.refresh()`; this is not a new RPC. No watcher dependency, external scheduler, service or cron is installed. Runtime executable availability/native inventory changes are detected; changing the daemon's adapter configuration itself still requires owner reload/restart (no new config hot-loader).

Only successful schema-valid results replace that adapter's last-good rows. Explicit unavailable descriptors and successful empty inventories are real changes. Rejected, timed-out, oversized or malformed probes preserve the last-good inventory, logging `discovery.scan_failed`/`discovery.scan_timeout` through the existing observer bus (with a safe console fallback, no raw native diagnostics). Other adapters may still update. A non-cooperative adapter is never scanned again concurrently; its late result is discarded. Initial failures have no last-good rows and are logged; clients receive only known inventory, not manufactured availability. Gateway reachability is explicitly represented by its existing unavailable descriptor; connected Gateway agent/model RPC failures now reject instead of manufacturing fallback removals.

Native version/help/profile commands reuse the process-tree supervisor, with cancellation, a 10-second command limit and a 512-KiB stdout bound. Catalog HTTP probes accept cancellation and cap response size. Optional Hermes/Codex catalogs retain their last successful model list (scoped to the same catalog/provider), or native-config defaults when none was obtained, and log a safe `discovery.catalog_failed` warning. An optional catalog redirect/error is not evidence that a working native executable disappeared; no cross-endpoint credential redirect is added. Existing Gateway RPC deadlines remain bounded; disposing the daemon closes its Gateway clients. Cancellation checks prevent a disposed scan from advancing to another Gateway RPC. Polling/deadline/listener ownership is released; no force-exit test flag is needed.

Comparison excludes `scannedAt`, object key order and order-only arrays, but includes all other protocol descriptor fields. Added/removed rows emit `agent_added`/`agent_removed`; model changes emit `models_changed`; availability/version/capability changes emit `agent_updated`. Combined changes produce one notification with the complete updated snapshot (model change takes kind precedence). Startup is quiet, and unchanged scans do not notify. This mechanism observes fields adapters actually discover; it does not invent a native model catalog where an adapter currently exposes only `default`.

Both list/get and outgoing events enforce each connection's exact `allowedAgents`. `availableOnly` is honored. `get` requires the exact agentId, never the first sibling from the same runtime. Sink failures are isolated and logged, without killing other subscribers or the daemon. Each consumer receives a cloned descriptor. No protocol methods or TS/Python SDK surface were added; the existing `discovery.changed` schema and SDK notification handlers are reused.

## Remaining producer scope (2026-09-09 source audit)

| Surface | Existing production path | Remaining boundary |
| --- | --- | --- |
| discovery.changed | Shared inventory → tenant-filtered connection → existing SDK event | Fixed here; standalone snapshot clients must refetch after reconnect. |
| OpenClaw native hook | `packages/openclaw-plugin/src/index.ts` before_tool_call → HTTP `HookBridge` → owning connection `fireHook` → server decision | A producer exists. Requires installed/enabled plugin, matching bridge URL/token, real native tool callback with the Phonon-derived sessionKey, and an authorized native session. Manually posting HTTP or calling `fireHook` is not native proof. |
| Claude/Codex/Hermes/OpenCode/Copilot native hook | Capability hook declarations, but no corresponding native callback bridge in their session execution paths | Product integration gap, not merely a missing test server. Requires a native callback contract and explicit owner permissions; do not emulate interception from ordinary tool output. |
| OpenClaw Gateway proactive | `sessions.messages.subscribe`; Gateway event routing by sessionKey; `GatewaySession.handleEvent` emits unsolicited final chat through SessionEngine | Producer bridge exists for this supported event shape. Genuine source must be an independently triggered native run while no local turn is active. Ordinary `session.send` or manually emitted p2s notifications do not prove proactive output. Current Gateway source/event-shape compatibility needs its own isolated native trigger acceptance. |
| OpenClaw CLI proactive | Declares proactiveOutput, but no `setUnsolicitedSink` producer in the one-shot CLI adapter | Product gap. Do not hide it by changing capabilities without implementing the bridge. |
| Generic document | `DocumentDirective`/`document.send` schemas and `sendDocument` RPC helper | No native directive parser → tenant/project-authorized read → descriptor/hash/content producer. A helper round trip or `file.read` is not document delivery. |
| Generic form | `interaction.request/response/cancel` schema and helper | Generic adapter-origin form producer absent. **Workflow human_review does have a production parser/producer** through WorkflowEngine → `requestInteraction`; do not label all forms unimplemented. |
| Large upload | `prepareUpload` credential RPC helper and ref schema | No owned bounded HTTP uploader, stream/hash/retry lifecycle or native document-to-upload producer. Server prepare-upload success alone is not upload success. |
| Schedule webhook | Engine/SDK `schedule.webhook` invocation and trigger semantics | No standalone HTTP webhook listener in the daemon. A protocol trigger is not an HTTP ingress producer. |

On this acceptance host the existing `agent-phonon-hitl` plugin is installed/enabled and defaults to the shared loopback bridge port 4318. This batch does not modify or restart the real Gateway, retarget its plugin, or claim a new native hook/proactive PASS. A later owner-approved isolated native session can verify the existing hook chain using an appropriate bridge and real native tool execution; a native scheduler/heartbeat trigger with a sessionKey accepted by the installed Gateway is additionally required for proactive proof. An isolated fake Gateway is useful for compatibility regression only and must stay labeled simulated.

Gemini native endpoint 404 is an external endpoint condition; Codex bwrap requires a compliant sandbox runtime. Neither is repaired by protocol fallback, proxy changes, privilege expansion or sandbox bypass. D03/D08 remain user-deferred and unchanged. This batch does not claim a rerun of the historical 192-scenario matrix.
