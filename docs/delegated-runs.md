---
title: "Delegated runs"
summary: "First-class child agent runs: lifecycle, harness seam (ACP), lineage, and presentation"
read_when:
  - Launching, inspecting, or debugging a delegated agent run
  - Changing the run lifecycle, the ACP launcher, or how runs are presented
---

# Delegated runs

Owner Operator launches child coding agents (Claude Code, Codex) as durable, daemon-owned
**delegated runs** ([#69](https://github.com/lhotwll217/owner-operator/issues/69)). A run is
tracked with explicit lineage, durable status, controls, and presentation — never inferred from
transcript activity. The domain terms live in [CONTEXT.md](../CONTEXT.md).

The daemon owns execution; the executor extends the scheduler's durable-run substrate rather
than adopting an orchestration framework. The child process is reached over the
[Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) via
pinned [`acpx`](inspiration.md) — one protocol client for every harness.

```text
Operator (delegate_agent / manage_agent_run tool)
        │  Gateway HTTP
   AgentRunExecutor ──── State (agent_runs ledger) ──── SSE agent-run.changed
        │
   ACP launcher (acpx) ──── child harness session (Claude Code / Codex)
```

## Lifecycle

`pending → running → { completed | failed | cancelled | interrupted | lost }`.

- **Terminal states are monotonic.** A finished row never changes status. Resume does not
  downgrade a row — it creates a *new* run under the same child identity.
- **The protocol turn result finalizes a run**, never process exit alone. A completed ACP turn
  is `completed`; a cancelled turn is `cancelled`; a turn error or child death is `failed`.
- **`interrupted`** is resumable: a graceful daemon shutdown mid-run, or a restart reconciling a
  row left `running` by a crash, lands here. The child identity is preserved for resume.
- **`lost`** is assigned only by the reconciliation sweep: a `running` row with no live
  in-process turn and no activity inside the grace window. Liveness is the executor's active-turn
  set plus durable rows — persisted metadata alone never keeps a run alive, and a live turn is
  never reclaimed.

## Execution

- **Background by default.** `delegate_agent` records the durable `pending` row and returns
  immediately; the parent session is never frozen. The result is carried by the ledger, not the
  parent tool call. An optional bounded `waitSeconds` (and `manage_agent_run wait`) blocks for the
  result without coupling liveness to the parent.
- **Concurrency** is capped (default 3 running daemon-wide); launches beyond the cap stay
  `pending` and start as slots free, claimed one row at a time under the cap in a single
  transaction so a race can never overshoot.
- **Owner Operator owns the deadline.** The executor aborts on its own per-run timeout so a
  launcher-side timeout after partial output can never read as success.
- **Depth is 1**, enforced not just structurally. The executor rejects a launch whose parent
  thread is itself a delegated run's child (`AGENT_RUN_MAX_DEPTH`). A child needing a helper (e.g.
  a review agent) uses its harness's native subagents, which never touch the ledger.
- **Model** is pinnable per run (`delegate_agent`'s `model`), threaded to the child through ACP
  session options; omitting it lets the harness pick its default.

## Permissions

Each child honors its **own harness's** permission system, exactly as any other session of that
harness on the owner's machine. Owner Operator builds no cross-harness permission layer and never
escalates: the ACP launcher is deny-by-default for non-read asks and fails a turn on the first
unapprovable change ask (recorded as a run failure) rather than continuing degraded, so the
owner's harness config stays the real gate. The exact `acpx` permission settings live in
[`src/agent-runs/acp-launcher.ts`](../src/agent-runs/acp-launcher.ts). (Privacy blacklist enforcement
for foreign-harness children is a separate OS-sandbox concern, not a permission-seam concern.)

## Lineage and presentation

A run row carries `parent_thread_id`. When the monitor observes the child's transcript through
its ordinary scan path, the observed thread joins to its `agent_runs` row by identity
(`child_session_id`), so the session-state projection exposes `parentThreadId` and the child
nests under its delegating parent instead of appearing as an unexplained flat thread. This is an
identity join, never inference from transcript-file growth.

In the terminal, the `delegate_agent`/`manage_agent_run` tools render a compact agent row
(harness · task · state · activity-or-outcome · elapsed) instead of a generic tool call
(`formatAgentRunRow` in `src/shared/oo-presentation.ts`).

## State

The `agent_runs` table is the durable ledger; its columns are documented once in
[`src/state/schema-docs.ts`](../src/state/schema-docs.ts) and inspectable through `query_database`.
`acpx` persists per-child session records under `~/.owner-operator/agent-runs/` (relocated out of
the system tmpdir so restart reconciliation and resume find child identities across restarts).
