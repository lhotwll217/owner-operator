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
and summary, rename a thread, or mark it done without opening its harness. Delegated child
sessions render directly beneath their parent thread using the Gateway's explicit lineage.

The widget is a pure Gateway client: it renders daemon state and never spawns a process.
Install, lifecycle, and client auth live with the daemon ([daemon.md](daemon.md)); until
onboarding completes it displays setup-required ([onboarding.md](onboarding.md)).
