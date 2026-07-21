---
title: "Sub-agents and delegated runs"
summary: "Owner Operator-issued sub-agents: tracking boundaries, lifecycle, harness seam (ACP), and lineage"
read_when:
  - Understanding sub-agents, child agents, or delegated work
  - Determining whether child work is tracked in the run ledger, session state, or widget
  - Launching, inspecting, or debugging a delegated agent run
  - Changing the run lifecycle, the ACP launcher, or how runs are presented
---

# Sub-agents and delegated runs

**Sub-agent** is the broad relationship: an agent launched to help another agent. Owner Operator
uses the narrower term **delegated run** for a child execution its daemon issues and owns through
the AgentRun launch path. `delegate_agent` is the Operator-facing route; authenticated Gateway
clients can use the same path directly. The child is still a Claude Code or Codex session; the
delegated run is OO's durable lifecycle record for that execution.

This distinction matters because a harness can launch its own native sub-agents without OO.
Those helpers are sub-agents, but they are not OO-delegated runs and never enter OO's run ledger.
A **schedule run** is a separate domain object; the delegated-run name does not imply that
schedules or triggers launch sub-agents.

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

## Tracking boundary

Run ownership, transcript observation, and widget visibility are separate:

| Work | `agent_runs` ledger | `/session-state` | Widget |
|---|---|---|---|
| Child launched through OO's AgentRun path (`delegate_agent` or Gateway) | Always; this is the canonical OO-issued marker | When the scanner admits its harness transcript, joined by `child_session_id` | Appears as a normal session row when present in session state |
| Native Claude, Codex, or Cursor sub-agent | Never | Harness-dependent: it may be folded into its parent, excluded as automated work, or admitted as an ordinary session | Mirrors session state; it has no OO lineage |
| Any agent launches a separate supported coding CLI | Only if the launch went through `delegate_agent` | Its transcript may be discovered and admitted normally | An ordinary row, without OO lineage |
| Owner Operator's own conversation | Not a child run; its id may be recorded as a run's parent | Intentionally excluded from external transcript discovery | Not an ordinary session row |

The ledger relationship is authoritative: a session is OO-delegated when its id matches an
`agent_runs.child_session_id`. Do not infer ownership from process ancestry, transcript location,
or activity. [`scan-active-transcripts.mjs`](../src/session-monitor/scan-active-transcripts.mjs)
owns the harness-specific admission, folding, and automated-session policy; [sessions.md](sessions.md)
owns transcript identity and discovery.

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

## Live state and clients

The ledger is a live, durable projection—not just a final result:

1. Launch persists and returns a `pending` row.
2. Queue claim records `running` and `started_at`.
3. ACP session creation records `child_session_id` and `acpx_record_id`.
4. Non-thought ACP text, status, and tool-call events replace `activity` with a bounded preview
   and advance `last_activity_at`. This is latest activity, not a durable event log.
5. Turn completion records the terminal status, `finished_at`, bounded `result_tail`, and `error`.

Every successful mutation publishes an `agent-run.changed` invalidation. Gateway SSE deliberately
carries only the event kind; clients refetch `/agent-runs` or `/agent-runs/:id` for durable truth.
A client that renders activity should coalesce refetches because a verbose child can produce many
ACP deltas.

Client behavior follows the same invalidation/refetch contract:

- **Interactive TUI:** each open parent thread lists its complete fleet by `parentThreadId` before
  opening one Gateway subscription, then lists again after attachment to close the snapshot gap.
  Initial and replacement SSE connections invalidate the fleet. `ParentRunSession` coalesces
  invalidations with an in-flight/dirty refetch rule. Its shared view drives the literal
  `Agent state` footer and the `/agent-state` picker; it never drives the parent's working indicator.
- **Widget:** receives the SSE invalidation but currently refetches only `/session-state`, not
  `/agent-runs`, so it does not render ledger activity or outcomes.
- **RPC:** Owner Operator does not expose a Pi RPC frontend today. A future conversation UI can
  use RPC for turns and tool events, but background runs should remain a Gateway resource so they
  outlive the tool call, parent conversation, and UI process.

The reusable status categories, bounded detail, ordering, controls, and completion envelope live
in the dependency-free `@owner-operator/core/agent-state` export. Gateway subscriptions, Pi UI,
and terminal styling are adapters over that contract.

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
- **Process ownership is explicit on POSIX.** Before `acpx` can spawn, the launcher persists a
  lease and puts its unguessable id on a stable Owner Operator wrapper's command line. Normal
  completion closes the ACP process tree and lease; daemon startup reaps only orphaned trees whose
  live wrapper path and lease id both match. It fails closed on unavailable process listings and
  never claims a bare Claude, Codex, or `acpx` process.

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
(`child_session_id`), so the session-state projection exposes `parentThreadId`. This is an
identity join, never inference from transcript-file growth. A client may use that lineage when
the parent is also visible. Owner Operator conversations are not session-state rows, so an
admitted OO-delegated child currently appears in the widget as an ordinary root session; its
ledger record remains the canonical provenance.

In the terminal, the `delegate_agent`/`manage_agent_run` tools retain their compact launch/control
snapshot row (`formatAgentRunRow` in `src/shared/oo-presentation.ts`). The parent-scoped live view
is separate: the footer shows queued, running, and attention counts only while one exists;
`/agent-state` orders attention before active and recent terminal runs, then shows bounded task,
harness, glyph-plus-text status, elapsed time, activity, and only currently valid controls.
Cancellation confirms before mutation.

Terminal completion behavior is defined at four linked seams: the browser-safe
[completion envelope](../packages/core/src/agent-state.ts), parent-scoped
[terminal reconciliation](../src/agent-runs/parent-run-session.ts), the
[Pi custom-message adapter](../src/agent-runs/agent-run-completion.ts), and its model-free
[saved-session integration contract](../test/agent-run-completion.integration.test.ts).

## State

The `agent_runs` table is the durable ledger; its columns are documented once in
[`src/state/schema-docs.ts`](../src/state/schema-docs.ts) and inspectable through `query_database`.
`acpx` session records and process leases live under `~/.owner-operator/agent-runs/` (relocated
out of the system tmpdir so restart reconciliation, safe orphan reaping, and resume retain their
identities across daemon restarts).
