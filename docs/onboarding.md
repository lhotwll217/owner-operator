---
title: "Onboarding"
summary: "First-run setup: privacy boundaries, credentials, harness review, permission mode, always-on services"
read_when:
  - Running or revisiting first-run setup
  - Debugging setup-required or fail-closed behavior
---

# Onboarding

`./oo` starts guided setup when needed. Setup creates `~/.owner-operator/workspace`, asks
which coding projects are off-limits, offers to copy existing standalone Pi authorizations and
model settings, then shows every supported harness and recognized app or CLI on one review
surface. Setup also asks whether shell commands and changes should ask, run automatically, or
remain unavailable. Standalone Pi is optional; fresh installs use Owner Operator's built-in
provider login and store credentials under `~/.owner-operator/pi`. Harnesses start included;
mark any to ignore. It then configures macOS always-on services, the active window, and
skills. The copy does not change standalone Pi.

Until setup finishes, headless calls and transcript/model processing fail closed: the daemon
does not scan or enrich transcripts, headless model calls return setup-required, and the
widget displays setup-required. The versioned consent marker records the reviewed harness IDs
and an access contract hash ([sessions.md](sessions.md) covers what reopens the review).

`./oo doctor` (or `./oo status`) prints the effective home, workspace, task directory,
credentials/model source, transcript stores, session host roots, skills, tools, and permission
mode without printing secrets. Use `/permissions` to change the mode, `/permission-system
show` to inspect the composed Pi rules, or `/onboarding` to revisit setup.
