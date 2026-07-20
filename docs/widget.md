---
title: "Widget"
summary: "The always-on macOS panel: what it shows and its pure-client boundary"
read_when:
  - Changing what the widget shows or how it connects
  - Debugging widget install or an empty or setup-required panel
---

# Widget

A floating macOS panel that shows your sessions, the ones needing attention first: what's
working, what's waiting, what you left open. Triage happens in place: see each session's state
and summary, rename a thread, or mark it done without opening its harness.

The widget is a pure Gateway client: it renders `/session-state` and never spawns a process or
reads the `agent_runs` ledger directly. An OO-delegated child therefore appears when its
transcript becomes a session-state row, and it may look like any other session. If both child and
parent are visible, the Gateway's `parentThreadId` lineage lets the widget render the child beneath
the parent. Ledger-only runs and harness-native sub-agents have no independent widget guarantee;
the complete boundary is in
[Sub-agents and delegated runs](delegated-runs.md#tracking-boundary).

Install, lifecycle, and client auth live with the daemon ([daemon.md](daemon.md)); until
onboarding completes it displays setup-required ([onboarding.md](onboarding.md)).
