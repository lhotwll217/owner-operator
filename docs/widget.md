---
title: "Widget"
summary: "The always-on macOS panel: what it shows and its pure-client boundary"
read_when:
  - Changing what the widget shows or how it connects
  - Debugging widget install or an empty or setup-required panel
---

# Widget

A floating macOS panel that shows session triage. Sessions needing attention stay first.
Triage happens in place: see each session's state and status summary, rename a thread, snooze it,
or mark it done without opening its harness. Clicking a row opens the thread in its own app when a
verified deep link exists (Codex, Claude desktop); other rows are inert.

Every row shows a title from the moment its work is visible, its repo, and its latest status
summary — including a working row, which is where the owner reads what is happening right now.
A delegated child's status summary stays folded until the owner opens it, and a child row is a
smaller line under its parent with no actions of its own.

Rows arrive in display order from `arrangeSessionState`
([`packages/core/src/session-state.ts`](../packages/core/src/session-state.ts)), the one order
the panel, `oo-widget --once`, and `oo session-state list` share. Sections run Needs you, Working,
Idle, then a collapsed Snoozed; done rows leave the panel. Needs-you, idle, and snoozed rows sort
by latest message, newest first, so a row moves when work comes back to the owner; working rows
sort by creation, newest first, so they never shuffle. A delegated child follows its parent, in
the parent's section, at any depth.

Snooze is owner state: until 2 hours from now, this evening at 18:00, tomorrow at 9:00, or the
next message. The widget resolves the preset to an instant in the owner's calendar; the daemon
evaluates the hold at read time, and any newer message wakes the row early, as it reopens a done
one. A held snooze stays in Snoozed regardless of age, and attention means the needs-you section,
so a snoozed row is never counted, ticked, or listed as needing the owner. A timed wake writes
nothing: the widget's 5-second poll shows it. Done, snooze, and wake hide the row while the
request runs, then the refetch places it.

The widget is a pure Gateway client. It renders `/session-state` and never spawns
a process or reads the `agent_runs` ledger directly.

SSE frames remain invalidations rather than state. An agent-run invalidation refetches the complete
session projection with an in-flight/dirty rule, and each replacement SSE connection refetches
again. Disconnect clears the rendered snapshot. Restart and reconnect reconstruct the thread list
from the Gateway.

An OO-delegated child's transcript can also become a session-state row. If both child and parent
are visible, `parentThreadId` lets the widget render the child beneath the parent. State projects
that root as working while any child is pending or running; the existing agent-run invalidation
refetches the session projection when this changes. Harness-native sub-agents have no delegated-run
guarantee; the complete boundary is in
[Sub-agents and delegated runs](delegated-runs.md#tracking-boundary).

Owner-origin Owner Operator conversations are ordinary root rows in `/session-state`; the widget
renders them in the same sections as coding-agent roots.

Install, lifecycle, and client auth live with the daemon ([daemon.md](daemon.md)); until
onboarding completes it displays setup-required ([onboarding.md](onboarding.md)).
