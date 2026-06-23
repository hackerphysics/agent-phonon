# L3 Orchestration Protocol

Status: protocol contract introduced; execution engine is the next implementation step.

agent-phonon L3 is task-level multi-agent orchestration built on top of L1 sessions and L2 tenant isolation. It does not replace `session.*`; it creates and coordinates ordinary agent sessions, then emits workflow-scoped observability events so callers can tell which agent/session/node produced each status or stream.

## Modes

### 1. DAG execution

Use `workflow.run` with `plan.mode = "dag"`.

A DAG plan contains:

- `nodes[]`: each node binds `nodeId`, `agent`, `model`, optional `role`, optional `input`, and optional `dependsOn`.
- `edges[]`: optional explicit edges; `dependsOn` is the compact form.
- `finalNodeId`: optional node whose result should be treated as the workflow final result.

Semantics:

1. Nodes with no dependencies become ready.
2. Ready nodes create normal L1 sessions and run through `session.send` semantics.
3. A node becomes completed/failed/skipped/cancelled.
4. Downstream nodes become ready when dependencies complete.
5. The workflow completes when all reachable required nodes finish, or fails/cancels on terminal error policy.

### 2. Free graph execution with executor

Use `workflow.run` with `plan.mode = "graph"`.

A graph plan contains:

- `executor`: one agent session responsible for decision and routing.
- `workers[]`: role-bound worker agents.
- `communicationGraph`: allowed edges, loop allowance, and `maxIterations`.

Semantics:

1. agent-phonon starts the executor session plus worker sessions.
2. The executor receives the graph, roles, state snapshot, and latest worker outputs.
3. The executor decides which worker(s) receive the next message and why.
4. agent-phonon enforces the communication graph and iteration limit.
5. Observability events report executor decisions, worker status, and worker streams.

## Methods

### `workflow.run` server→phonon request

Starts a workflow.

Returns:

```ts
{ workflowId, status, createdAt }
```

### `workflow.status` server→phonon request

Returns workflow status plus per-node runtime state:

```ts
{
  workflowId,
  status,
  project,
  mode,
  nodes: [{ nodeId, status, agent, model, role, sessionId, turnId, ... }],
  createdAt,
  updatedAt,
  completedAt?,
  error?
}
```

### `workflow.cancel` server→phonon request

Cancels a workflow and should cancel/terminate owned sessions according to the workflow runtime policy.

### `workflow.list` server→phonon request

Lists workflow runs, optionally filtered by status.

### `workflow.event` phonon→server notification

Workflow-scoped observability stream. Event types:

- `workflow.status`
- `node.status`
- `node.stream`
- `edge.route`
- `executor.decision`

Every event carries `workflowId` and monotonic `seq`. Node/session events also carry enough identity to disambiguate concurrent agent sessions:

```ts
{
  workflowId,
  seq,
  type,
  nodeId?,
  sessionId?,
  turnId?,
  agent?,
  model?,
  role?,
  status?,
  payload?,
  timestamp
}
```

## Observability rule

L3 must preserve L1 observability rather than hiding it. When a node creates an L1 session, workflow events must include at least:

- `workflowId`
- `nodeId`
- `agent`
- `model`
- `role` when present
- `sessionId`
- `turnId` when present

This lets the server render one workflow timeline while still being able to drill into individual agent sessions.

## Implementation notes

The initial protocol is already in `packages/protocol/src/schemas/workflow.ts` and registered in `METHODS` as:

- `workflow.run`
- `workflow.status`
- `workflow.cancel`
- `workflow.list`
- `workflow.event`

Core currently rejects these methods with `errCapabilityUnsupported`; the next step is to add a `WorkflowEngine` that owns workflow state, creates L1 sessions through `SessionEngine`, and emits `workflow.event` notifications through the existing L2 transport.
