# Hermes command approval through Phonon

The Hermes adapter now installs a native human approval callback when the current
controller supplies both interaction and acknowledgement handlers and paired
loopback capabilities. It does not modify user configuration, installed Hermes
sources, allowlists, dangerous-command detection, hardline rules, or user deny
rules. Explicit native policies (including smart/manual and selected transports)
remain host-owned.

## Human presence, not auto-approval

Hermes CLI `-q` marks a turn as unattended. Inside the supervised invocation,
after registering the real callback, the bridge temporarily replaces that marker
with native interactive context plus ask-mode. Ask-mode is important: whole
`execute_code` scripts must not silently become allowed as they would in a plain
interactive CLI. Existing cron/unattended restrictions remain in effect. The
callback and environment are restored on exit; late callback results are denied.
Without a paired controller channel the original native unattended policy remains.
Unsupported callback propagation APIs fail rather than weakening checks.

Each warning requests a real Phonon approval form with a new UUID. It offers only
approve-once or deny (never session/always). It returns `once` only for the matching
request's explicit `action=submit`, Boolean `approve=true`, a valid decision proof,
and a successful application acknowledgement before the deadline. String `true`,
cancel, expired/closed calls, HTTP errors/redirects and mismatched receipts cannot
authorize execution. Timeout remains distinct from explicit refusal.

Commands/reasons arrive from Hermes' redacted prompt surface; the capability is
also stripped from displayed text and bridge diagnostics. Oversized commands are
denied rather than requesting approval for a truncated preview. The form labels
the agent process directory honestly: Hermes' callback does not supply the actual
per-command terminal workdir, so it must not be presented as the execution cwd.

No new server protocol or iOS UI is required: `interaction.request`, approval
presentation and decision receipts already exist. The backend still stamps the
original execution/conversation identity. Sending a form is not consent.

## Verification

Build first, then run:

    PHONON_HERMES_TEST_PYTHON=/path/to/hermes/venv/bin/python \
    PHONON_HERMES_TEST_SOURCE=/path/to/hermes/source \
    node --test scripts/hermes-command-approval.test.mjs

The tests run the installed Hermes guard and terminal against owned disposable
fixtures with a controlled HTTP responder. They are NOT claims of human consent
or notification delivery. They cover unpaired channel rejection, approve once,
explicit denial, cancellation, timeout, wrong request/proof, string-vs-Boolean
approval, acknowledgement failure, inactive scope and native worker propagation.
Hardline commands are checked without executing them. Ordinary unattended
behavior is checked before and after the callback scope.

## Real human acceptance (not yet complete)

`hermes-command-approval-live.mjs` runs a real native terminal command that removes
only a newly allocated test directory, waits for a real human response, and saves
whether the directory still exists. It requires the current controller's original
channel and must not borrow a different turn's capability.

When testing from inside a running Hermes process whose channel environment has
already been consumed, `hermes-command-approval-relay.mjs` provides an explicitly
manual acceptance relay: forward its generated request unchanged through this
conversation's native interaction tool, write the actual result to `response.json`,
and forward/acknowledge the actual receipt before writing `receipt-result.json`.
Never fabricate either file or describe this manual relay as automatic deployment.

The first real request `60bfb9b6-285b-4ab3-aa0e-d2e476a88931` timed out. Its owned
directory remained and no command executed. A follow-up asking the user whether
the card/push was visible also timed out at the tool boundary. This does NOT prove
notification delivery, explicit denial, or approve-then-execute. The required
human acceptance remains blocked pending an actual response; this feature is not
reported as complete or activated in the installed daemon.

Do not change approvals.mode to off, single_query_mode to approve, or hot-patch the
running employee to demonstrate this feature. Deploy verified committed main
through the normal runtime upgrade, then repeat approval/denial acceptance on the
activated version and confirm the user's actual notification experience.
