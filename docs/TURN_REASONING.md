# Per-Turn Reasoning Settings

The service negotiates managed hints only with device capabilities
`turn_reasoning_v1` and `best_effort_reasoning_v1`, adapter `reasoningControl: true`
and the selected model's reported `reasoningLevels`. UI controls must use those
reported levels; the original message is not rejected just because an optional
hint cannot be applied.
Missing metadata is unknown, not a universal set of supported levels. The
changes extend existing Session, workflow-node and stream schemas, not a
separate settings RPC.

`session.send` and every workflow node accept `reasoning: {level}`. Current
canonical levels are `low`, `standard`, `high`, `xhigh`, `max`; `standard` maps to native
`medium`. Unsupported native levels are not silently mapped onto this ladder.
`{level: null}` requests removing Phonon's override for that turn and restoring
the harness/profile's native default. A reset which cannot be verified stays
unconfirmed; never invent its effective value. Omitting `reasoning` preserves the legacy
unmanaged path. Direct SDK callers must explicitly clear a previously managed
override when switching back to native defaults.

`max` is distinct from `xhigh`: advertise it only when the selected model's
native metadata explicitly supports it. The protocol can carry all five levels;
this is not a claim that every adapter or model accepts all five. Hermes' list
describes native CLI configuration inputs, as distinguished below from downstream
provider acceptance.

```ts
await session.send("Review the change", {reasoning: {level: "high"}});
await session.send("Use the native default", {reasoning: {level: null}});
// Workflow node:
// {nodeId: "reply", agent, model, reasoning: {level: "standard"}}
```

```python
await session.send("Review the change", reasoning={"level": "high"})
await session.send("Use the native default", reasoning={"level": None})
```

## Confirmation

Saving a preference and receiving send acceptance are not confirmation. A capable
adapter acknowledges the actual native setting through the controller's
current-turn callback. The controller emits a durable `runtime_settings` stream
event, including Session/turn/agent/model and optional workflow/native-run
lineage. It is delivered even at final verbosity. Its `reasoning` contains
`requestedLevel`, `nativeValue` and `effectiveLevel` when the native value has an
exact canonical equivalent. A default may be confirmed without a canonical
effective level. There is no invented default or token/cost estimate.

The callback is not a model tool. Model/adapter-authored `runtime_settings`
events are ignored. Out-of-turn callbacks cannot publish proof; duplicate,
malformed or mismatched setting values do not become confirmation. Missing
confirmation does not manufacture execution failure or authorize another task
attempt. A real native completion remains completion; actual executor errors,
cancellation and permission denials retain their own outcomes.

If native control is unavailable, the controller sends the original input without
the hint. If the control exists but cannot report the requested level, it may
request native defaults instead. Original queued preferences and server-side
intent are not rewritten. A legacy controller lacking the best-effort capability
receives no managed hint, so its old missing-proof failure behavior cannot strand
new messages. Stored preferences remain available after a device update.

Reasoning is not an authorization, approval or budget gate. Authority checks and
cancellation still run before native effects, including after optional discovery
waits. Never replay an already attempted task merely to obtain a setting receipt.

This confirms **harness configuration**, not provider-internal reasoning tokens,
model quality, billed budget, or successful task effects. A provider may clamp
or ignore an accepted harness option; provider/model acceptance needs separate
live verification. In particular Hermes' advertised levels are CLI-accepted
configuration inputs, not assertions about every downstream provider's wire.

## Adapters

- OpenClaw Gateway reads `thinkingLevels` from the agent-scoped native catalog,
  patches only its Phonon-owned Session, verifies the returned entry, then sends
  the native thinking value with `chat.send`. Default clears the Session override.
  If patching fails or its response cannot confirm the setting, the original chat
  is still attempted once without the unverified thinking override. Cancellation
  before that attempt neither sends chat nor aborts another native chat.
  No global Agent defaults, credentials or unrelated Sessions are rewritten.
- Hermes discovers the installed CLI's `--reasoning` support. Each invocation
  receives the native flag; the narrow bridge observes `AIAgent.reasoning_config`
  before `run_conversation`. A mismatch/missing native field leaves the setting
  unconfirmed and does not suppress that call. No profile YAML is changed; a fresh default invocation uses
  native profile configuration. This preserves the existing CLI, provider, auth
  and memory lifecycle.
- Pi reads `get_available_models` in an ephemeral, metadata-only RPC process,
  without prompts, saved Sessions, discovered extensions/skills or project
  context. Model-specific native thinking maps decide xhigh/max support;
  the table's reasoning boolean alone never authorizes advanced efforts.
  Native clamping, missing setting metadata or a rejected setting callback cannot
  prevent the original prompt RPC. Session/file/turn identity checks remain in place.
- Codex uses invocation-only `-c model_reasoning_effort=...`, including resume.
  Confirmation comes from a new matching model/effort `turn_context` record in
  the actual native Session's rollout, after that invocation began. Old records
  cannot confirm a later turn. Reads are bounded to 2 MB of new transcript data.
  Model levels come from explicit owner model metadata or, for native OpenAI
  configuration, matching native model-cache metadata. No provider name implies
  a level set. Missing rollout evidence remains unconfirmed.
  Missing or mismatched effort evidence never replaces a real native completion
  with failure, nor causes another execution attempt.
  Discovery now also reads bounded, paginated native `model/list` metadata with
  the same configured provider and native home. A compatible endpoint returning
  model IDs without effort fields must not erase matching native effort data.
- Copilot reads authenticated native `models.list` over a bounded, owned
  Content-Length-framed metadata process. No Session or task is created.
  Per-model supported efforts, not static help/model-name guesses, supply the
  menu. A verified CLI flag receives `--reasoning-effort` on the original
  invocation. Only fresh root `session.start`/`session.resume` evidence with
  the exact selected model, native Session and value can confirm application.
  Missing/stale/foreign evidence does not replace native completion.
- OpenCode reads `models --pure --verbose` and maps only unambiguous, enabled
  variants carrying a canonical native `reasoningEffort`. The configured default
  alias is enriched only from a proven exact model. The original invocation
  receives the actual variant name through `--variant`, including after model
  switching. A reasoning boolean alone is insufficient. No setting proof is
  fabricated from the flag or successful task output.
- OpenClaw one-shot CLI reads its configured Agent's native model list and
  enriches only exact matches from agent-scoped Gateway `models.list`. Both
  OpenClaw paths accept native `thinkingLevels` entries using the actual `id`
  field, not just earlier fixture `value` fields. The verified one-shot flag is
  `--thinking`; it does not invent confirmation from invocation arguments.
- The installed Claude Code 2.0.1 has no verified effort flag and retains the
  unmanaged path. Other versions require their own native evidence.

Unconfirmed default resets remain unconfirmed; neither CLI flag omission nor
successful execution proves that a resumed native Session removed an earlier
override. Never replay a task to obtain that proof.

## Scheduling And Isolation

Each queued Session send preserves its own requested setting. Insertion into a
running turn cannot change that turn's reasoning; an optional hint on an
otherwise valid insertion is ignored rather than rejecting its input. Active
turn identity and permission checks still apply. Workflow DAG/graph/discussion nodes carry the setting through the
existing Session path; retained Sessions do not take it from the next caller.

The mobile control plane freezes its selected default/override when taking the
next turn and chooses a safe optional hint using current device/model metadata.
The actual dispatched setting is included in the immutable request/hash; the
original desired preference/frozen plan remains intact. Later edits apply only to later
turns. A managed-intent flag is committed with dispatch, so a lost confirmation
does not suppress a later required default reset. Unconfigured conversations
do not gain an unsolicited settings operation. Confirmations are journaled
before ACK and matched to the frozen node, Session, turn, model and native run.
Older valid round receipts cannot replace a newer confirmation. Private chats,
project groups and ordinary Agent Sessions remain independent.

Coverage: `fn-turn-reasoning.test.ts`, Python options/cross-language workflow
tests, and the mobile service's actual HTTP/PG/Gateway/prepared-daemon tests.
The local HTTP/PG/current-source-daemon acceptance also verifies an unconfirmed
setting does not pause the queue and the next input uses the same native Session
without manual recovery. Adapters/models in automated execution tests are deterministic; these are not
paid-provider or personal-profile inference claims.
