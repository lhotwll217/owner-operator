---
title: "Widget"
summary: "The always-on macOS panel: what it shows and its pure-client boundary"
read_when:
  - Changing what the widget shows or how it connects
  - Debugging widget install or an empty or setup-required panel
---

# Widget

A floating macOS panel that shows both session triage and delegated-agent state. Sessions needing
attention stay first; delegated failures and interruptions stay separate from thread state.
Triage happens in place: see each session's state and summary, rename a thread, or mark it done
without opening its harness.

The widget is a pure Gateway client: it renders `/session-state` and `/agent-state`; it never spawns
a process or reads the `agent_runs` ledger directly. `/agent-state` is derived by the Gateway with
the browser-safe core run-view contract, so status vocabulary, bounded details, resumability, and
attention-first ordering match the terminal without Swift lifecycle logic. The literal agent-state
rail stays hidden when only calm terminal history remains; opening the panel shows bounded recent
history after attention and active runs.

SSE frames remain invalidations rather than state. An agent-run invalidation refetches the complete
Gateway projections with an in-flight/dirty rule, and each replacement SSE connection refetches
again. Disconnect clears the rendered snapshots; restart and reconnect therefore reconstruct from
the durable ledger without preserving stale running indicators.

An OO-delegated child's transcript can also become a session-state row. If both child and parent
are visible, `parentThreadId` lets the widget render the child beneath the parent. Harness-native
sub-agents have no delegated-run guarantee; the complete boundary is in
[Sub-agents and delegated runs](delegated-runs.md#tracking-boundary).

Install, lifecycle, and client auth live with the daemon ([daemon.md](daemon.md)); until
onboarding completes it displays setup-required ([onboarding.md](onboarding.md)).
