# Pi Native Steering

The maintained Pi adapter uses RPC for a verified Pi 0.84.1-or-newer release
whose actual `--help` advertises RPC. Older/unknown versions retain the JSON
transport and advertise `injectMidTurn:false`. Help alone is insufficient:
Pi 0.70.6 has RPC but not the verified settled-run lifecycle used here.

Every Phonon turn still has its own native process. Prompts and RPC commands
travel over LF-only JSONL stdin, never argv. The adapter correlates responses
by private command IDs. Before sending the initial prompt it confirms native
session ID, canonical native path, model/provider, idle/compaction state and
empty native pending input. Native tool registration and the existing exact
recovery guard must be ready first. A mismatch fails without a fresh prompt.

`insertAtToolGap` uses native `steer`, not another `prompt`, `follow_up`, process
restart or queued Phonon turn. Its promise resolves only after **both**:

- the matching native steering command succeeds;
- the exact input appears in a native user-message completion event on the
  original active process/run, after the original user message was observed.

A queue acknowledgement, assistant echo, unrelated user message, rejected RPC,
or native content expansion is not enough. If the harness transforms input so
the exact delivery cannot be matched, the result remains unconfirmed rather
than claiming insertion. Concurrent identical inputs have independent command
and consumption observations. No model-obedience or completion claim follows
from insertion acknowledgement alone.

Early, idle, aborted and closed-run inputs are rejected. Native `agent_settled`
closes the input channel, rejects unconfirmed insertions and ends stdin. Actual
successful process exit and a nonempty final assistant reply are required for
success. A native process that fails to close after settlement is stopped and
reported as failed, not silently accepted. Cancellation remains interruption
even if an outstanding state/prompt command rejects during shutdown.

Intermediate text stays observable. The successful result uses the latest whole
assistant message ending in native `stop`/`length`, not concatenated planning
text. Native checkpoint creation still verifies the complete v3 transcript,
working directory, owner/mode/inode/snapshot, settled tools and original model.
A device-configured path alias is normalized through its existing parent;
this does not permit a different native directory or retained file.

`workflow.input` supplies the durable source binding and receipt described in
`WORKFLOW_INPUTS.md`. Controller replacement leaves an unconfirmed insertion
unknown; reading/retrying it cannot launch another native operation.

Actual Mac acceptance with Pi 0.84.1 and GLM-5.3/Kimi-K3 is recorded in Phonon
Work's `mobile/PI_STEERING_TEST_RUN_2026-10-22.md`. Each case verifies a real
blocking human request, exact original-turn steering, explicit refusal receipt,
native history, result and restart-only receipt reads. Linux Pi 0.70.6 has only
metadata/unsupported-capability verification, not real steering acceptance.

This primitive does not complete the ordinary Dev durable wait/FIFO scheduler,
its authorization renewal or iOS busy-input controls. Those remain source-owned
work; a phone polling loop or expiring delegated bearer is not a durable queue.
Native compression/context UX and other harnesses' insertion are not advertised
as implemented by this Pi transport change.
