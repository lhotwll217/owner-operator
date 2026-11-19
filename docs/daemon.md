---
title: "Daemon"
summary: "Daemon lifecycle: loopback auth, health/readiness, staleness, LaunchAgents"
read_when:
  - Installing or upgrading the pinned runtime
  - Debugging daemon startup, replacement, or client connection failures
  - Changing daemon discovery, supervision, or fingerprinting
---

# Daemon

`oo daemon` is the long-lived local process hosting State, the session monitor,
scheduler, Git-backed worktree orchestration, and the loopback Gateway. Terminal clients
ensure the current daemon is ready.

The daemon binds only `127.0.0.1`. Its mode-`0600` discovery file carries a fresh bearer token;
every HTTP/SSE request authenticates with it. `/health` reports PID, start time, fingerprint, and
staleness; `/ready` reports module initialization. Clients require readiness. Production clients
never open SQLite and there is no `OO_DAEMON=0` mode.

The runtime fingerprint hashes the source roots and settings files listed in
[`fingerprint.ts`](../src/daemon/fingerprint.ts), including uncommitted changes. A change to those
inputs marks the daemon stale and exits it gracefully; launchd or the terminal ensure path starts
the current runtime. This adapts OpenClaw's installed service-version
stamp ([source](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-env.ts#L430-L446))
to a development checkout where source content, not package version, is authoritative.

When the daemon LaunchAgent is installed, launchd is the only process supervisor and terminal
clients request replacement through `launchctl kickstart`. Without the LaunchAgent, terminal clients
may start one detached daemon directly. Before replacement, the client authenticates the stale or
unready daemon identity and waits for it to release the Gateway; it never signals an unverified PID.
LaunchAgent ownership is verified against `launchctl print`; if an authenticated detached daemon
predates installation, the client stops it and waits for the port before handing ownership to launchd.
An ambiguous launchctl result fails closed and never authorizes direct signaling.
The client requires `/health` to agree with `daemon.json` on PID and fingerprint before it
authorizes replacement. Once authenticated, a stale or unready daemon, or one from the client's own
checkout with a fingerprint different from the client's runtime, follows the replacement path above.
A client from another checkout, such as a worktree's `./oo`, connects to a ready daemon instead,
launchd-owned or detached, because replacement would interrupt every running child. Its commands are
then served by the daemon's code, not its own. To run a checkout's daemon code, use an isolated
`HOME` and `OO_HOME`. A health response that
disagrees with discovery is an identity failure, not authorization to replace that process.

Clean shutdown removes `daemon.json` only if its PID and start time still match the closing
daemon. A replacement can publish discovery while the old Gateway drains requests; the old
daemon leaves that replacement record intact. Discovery can survive a crash or reboot.
Missing or invalid PIDs count as no discovery. After a failed probe, an exited PID, `ECONNREFUSED`, or a successful
bind to the discovered loopback port permits startup. This lets a client recover from stale
discovery even if another process has reused the recorded PID. A denied connect or bind does
not establish that the port is free; a denied PID check does not establish that the PID exited.

If the PID still exists and the port cannot be established as free, the client leaves the process
running. The error includes the PID, address, underlying probe failure, and a manual recovery
command. Only permission errors suggest sandbox or network restrictions. Timeouts, HTTP 401,
and identity failures retain their own cause in both text and JSON CLI output. Discovery bearer
tokens are redacted from those diagnostics and any retained cause that contains the token.
For a hung or otherwise unreachable daemon, verify its identity before running the displayed
recovery command from an unrestricted terminal. Verified launchd ownership uses
`launchctl kickstart -k gui/<uid>/com.owner-operator.daemon`. A detached daemon uses `kill <pid>`;
if it does not exit, use `kill -9 <pid>` because a hung event loop cannot run its SIGTERM handler.
An installed LaunchAgent alone does not establish PID ownership. When ownership cannot be
verified, the error gives both recovery options and asks the operator to establish which applies.
Then retry `oo`. Manual recovery can interrupt running children, so a probe failure alone never
authorizes the client to stop an unverified process.

Long-lived Node clients invalidate cached discovery after authentication or connection failure.
After a 401, an ordinary Gateway request rereads discovery and replays once only when the daemon
identity or credential changed. SSE subscriptions reread `daemon.json` before reconnecting.

## Pinned runtime

[`scripts/install-runtime.sh [<git-ref>]`](../scripts/install-runtime.sh) installs one commit
(default `HEAD`; uncommitted changes are not included) into `$OO_HOME/runtime/<commit>` with
`git archive` and `npm ci`. It then writes the daemon and widget LaunchAgents to run that copy,
links the global `oo` to the copy with `npm install -g`, and takes over the daemon. Taking over
replaces whichever daemon serves, including a detached one started from a checkout before
installation, and the install fails unless `/health` then reports the copy as its `repoRoot`. Onboarding's always-on step and `make install` in `apps/widget` both run it.

Nothing edits the copy, so its fingerprint never changes and it never goes stale on its own. A
checkout's `./oo` is another checkout and connects to it instead of replacing it. A crash or
login restarts the same copy. Only a deliberate rerun changes the live code.

To upgrade, rerun the script with the new ref, for example `scripts/install-runtime.sh origin/main`
after `git fetch`. Rerunning a commit that is already installed only rewrites the services. Older
copies stay on disk until you delete them; delete one only when no LaunchAgent or global `oo`
points at it. Installs run one at a time, and a crashed install's `.partial-<commit>` directory is
replaced by the next install of that commit.

**Verify activation:** After installing a runtime, verify that the daemon is healthy and serves
the intended runtime, and that the widget process is running. Confirm widget visibility through
visual inspection or owner confirmation. Report activation complete only when all checks pass;
otherwise name the unverified check.

The widget itself is a pure Gateway client ([widget.md](widget.md)).
