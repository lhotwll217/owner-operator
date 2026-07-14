---
title: "Widget"
summary: "The always-on macOS panel: what it shows and its pure-client boundary"
read_when:
  - Changing what the widget shows or how it connects
  - Debugging widget install or an empty or setup-required panel
---

# Widget

A floating macOS panel that always shows every session, ordered by priority: what's working,
what's waiting, what you left open. Triage happens in place: read a session, rename a thread,
or mark it done without opening its harness.

The widget is a pure Gateway client: it renders daemon state and never spawns a process. The
widget installer installs the daemon and widget LaunchAgents together; daemon lifecycle and
client auth live in [daemon.md](daemon.md). Until onboarding completes it displays
setup-required ([onboarding.md](onboarding.md)).
