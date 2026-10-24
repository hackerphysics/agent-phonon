# Herdr Agent Interaction Study

Date: 2026-10-24. Research only, not an integration plan.
The [accepted decision](../decisions/2026-10-24-native-agents-only.md) explicitly
removes Herdr support and compatibility.

## Sources And Method

Read upstream source over HTTPS without cloning, installing, building or
starting Herdr or an Agent. No third-party implementation was copied into our
runtime. Two source pins distinguish the previously qualified baseline from
newer upstream behavior:

- Herdr v0.9.1: commit `065ef9d6a531c49fb8bee7e818ef837065b21ee9`.
- Upstream inspected snapshot: `5608de0608918aba2f9d501e7793b984a0ca9cfa`.

The baseline's integration revisions are Claude 10, Codex 8, Copilot 3, Pi 9,
Hermes 5 and OpenCode 12. Newer scripts have different revisions. Findings do
not imply universal compatibility with any Agent version or provider.

## Interaction Model

Herdr runs the original interactive CLI in its own PTY. Its CLI talks to the
terminal server, which sends input to that PTY and exposes terminal reads,
process/session identity and lifecycle state. This is not a common structured
Agent tool/result protocol.

| Agent | Native integration inspected | What that integration proves |
| --- | --- | --- |
| Claude Code | SessionStart command hook; rejects Agent-child reports | Native session ID/transcript/start source, not complete task lifecycle |
| Codex | Command hook reporting original session/transcript | Session identity, not a native completion receipt |
| Copilot | Hook script accepting native session ID spelling variants | Session identity, not structured tools or successful completion |
| Hermes | Plugin hooks on session start/reset and pre-LLM observation; bounded CLI report | Original interactive session identity, not full working/blocked/idle authority |
| Pi | TUI extension; session/start/settled events and explicit blocked notifications | Native lifecycle plus session file/ID; idle requires final settlement and actual isIdle |
| OpenCode | Native plugin session/status/permission/question events; server/TUI ownership differs by version and mode | Lifecycle only for the qualified owning path; a loaded server plugin alone is not proof of current TUI identity |

Baseline source:
[Claude](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/claude/herdr-agent-state.sh),
[Codex](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/codex/herdr-agent-state.sh),
[Copilot](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/copilot/herdr-agent-state.sh),
[Hermes](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/hermes/__init__.py),
[Pi](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/pi/herdr-agent-state.ts),
[OpenCode](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/opencode/herdr-agent-state.js).

For Agents without full native lifecycle authority, Herdr combines foreground
process detection, PTY activity and versioned screen rules. Screen output is
therefore heuristic evidence, not equivalent to native events. The distinction
is explicit in its [authority classification](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/detect/mod.rs#L327).

## Mechanisms Worth Learning

### 1. Explain Why A State Was Reported

Its newer `agent explain` path distinguishes lifecycle-hook authority from a
screen-rule match, including rule ID, priority, region, manifest version and
skip/fallback reason. Its [Codex rules](https://github.com/herdrdev/herdr/blob/5608de0608918aba2f9d501e7793b984a0ca9cfa/src/detect/manifests/codex.toml)
restrict matches to meaningful screen regions and explicitly avoid stale
transcript/history matches.

For Phonon, keep native event, process liveness, user-action wait and unknown
states distinct. A useful follow-up is bounded, inspectable state provenance,
not another terminal parser. We already separate capability/readiness/evidence
in `peer-context.ts`; a unified per-adapter lifecycle diagnostic remains an
opportunity, not something implemented by this removal.

### 2. Keep Input Acceptance Separate From Completion

The newer [submission implementation](https://github.com/herdrdev/herdr/blob/5608de0608918aba2f9d501e7793b984a0ca9cfa/src/app/api/agents.rs#L139)
validates the target and blocked state before writing. It prepares the waiter
before side effects, separates pasted text from Enter, handles Copilot focus,
and has a Windows Codex paste-boundary workaround.

Its [CLI contract](https://github.com/herdrdev/herdr/blob/5608de0608918aba2f9d501e7793b984a0ca9cfa/src/cli/agent/bindings.rs#L259)
explicitly warns that state waits do not track turns: an already-working turn
can satisfy a later wait. Therefore do not import `idle/done == our task
succeeded`. Keep Phonon's original session/turn/call identity and distinguish
queued, accepted, working, awaiting human action and native final result.
The native Pi RPC and current-turn acknowledgement paths already implement
important parts of this separation. PTY key workarounds are irrelevant to those
structured paths and should not be added speculatively.

### 3. Treat Native Settlement As Stronger Than Intermediate End Events

Pi reports idle on `agent_settled` only when native `isIdle()` agrees, avoiding
premature idle during retry/compaction. Session reload also reobserves whether
the Agent is active instead of assuming it starts idle.

Our `adapters/pi-rpc.ts`, `pi.ts` and native retry/recovery tests already follow
final native settlement. Retain and test that behavior; no duplicate extension,
polling loop or Herdr dependency is needed.

### 4. Make Observational State Cheap And Order-Aware

The Pi extension attaches monotonically increasing sequence numbers, serializes
reports and coalesces queued state to the latest observation. Newer terminal
[detection scheduling](https://github.com/herdrdev/herdr/blob/5608de0608918aba2f9d501e7793b984a0ca9cfa/src/pane/agent_detection.rs#L1)
skips unchanged idle content and confirms ambiguous working-to-idle transitions
with bounded rechecks rather than rescanning continuously.

Apply this principle only to replaceable UI/status snapshots. Our
`peer-context-reporter.ts` already serializes and coalesces wakeups while keeping
durable message evidence. Never coalesce tool results, approval decisions,
execution receipts or final events. Native final events must not be delayed
just because a heuristic status indicator uses debounce.

### 5. Keep Session Identity And Authority Separate

Reporting a session ID, discovering an executable, or observing a live process
does not prove login, current-turn ownership, safe tool permission or task
success. Preserve the original root session and reject child/stale observations.
Prefer hooks/plugins loaded only for the current owned invocation where the
native API allows it, without rewriting the owner's personal configuration.

Phonon already has per-adapter source checks, bounded discovery probes,
process-tree supervision and peer admission. Preserve these direct integrations;
do not replace them with generic process-name matching or screen scraping.

## Conclusion

Learn the evidence hierarchy, inspectable diagnosis, preflight-before-input,
final settlement and bounded state-report lifecycle. Do not adopt the PTY
wrapper as a dependency, copy the screen-detection catalog, install global
integration scripts, auto-answer native approvals or add a compatibility layer.
No broad new runtime behavior is justified solely by this inspection.

Upstream is Apache-2.0 at the inspected snapshot. Any future literal source
reuse needs a separate license/notice review; this study imports no code.
