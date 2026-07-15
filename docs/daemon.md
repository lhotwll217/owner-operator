---
title: "Daemon"
summary: "Daemon lifecycle: loopback auth, health/readiness, staleness, LaunchAgents"
read_when:
  - Debugging daemon startup, replacement, or client connection failures
  - Changing daemon discovery, supervision, or fingerprinting
---

# Daemon

`oo daemon` is the long-lived local process hosting the state, session monitor,
scheduler, and loopback Gateway. Terminal clients ensure the current daemon is
ready.

The daemon binds only `127.0.0.1`. Its mode-`0600` discovery file carries a fresh bearer token;
every HTTP/SSE request authenticates with it. `/health` reports PID, start time, fingerprint, and
staleness; `/ready` reports module initialization. Clients require readiness. Production clients
never open SQLite and there is no `OO_DAEMON=0` mode.

The runtime fingerprint hashes the source roots and settings files listed in
[`fingerprint.ts`](../src/daemon/fingerprint.ts), including uncommitted changes. A mismatch marks the daemon stale and exits it gracefully; launchd or the
terminal ensure path starts the current runtime. This adapts OpenClaw's installed service-version
stamp ([source](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-env.ts#L430-L446))
to a development checkout where source content, not package version, is authoritative.

When the daemon LaunchAgent is installed, launchd is the only process supervisor and terminal
clients request replacement through `launchctl kickstart`. Without the LaunchAgent, terminal clients
may start one detached daemon directly. Before replacement, the client authenticates the stale or
unready daemon identity and waits for it to release the Gateway; it never signals an unverified PID.
LaunchAgent ownership is verified against `launchctl print`; if an authenticated detached daemon
predates installation, the client stops it and waits for the port before handing ownership to launchd.
An ambiguous launchctl result fails closed and never authorizes direct signaling.
Long-lived Node clients invalidate cached discovery after authentication or connection failure.
After a 401, an ordinary Gateway request rereads discovery and replays once only when the daemon
identity or credential changed. SSE subscriptions reread `daemon.json` before reconnecting.

The widget installer installs the daemon and widget LaunchAgents together; the widget itself
is a pure Gateway client ([widget.md](widget.md)).
