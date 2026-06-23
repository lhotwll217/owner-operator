# apps/widget — always-on-top macOS glance

The omnipresent triage surface. **Status: 🌱 v1 — live, read-only.**

A native floating HUD (SwiftUI in a borderless `NSPanel`) that sits **above your windows and on
every Space / fullscreen app** — always on screen. Collapsed it's a small bar (status dot · state
counts · the loudest needs-you leaf); click `⌄` to expand it **in place** into the full rail,
grouped by repo and ordered loudest-first — the same rail the TUI renders.

```
always on top, top-right of the screen:

  collapsed (small, always there)        expanded (click ⌄)
┌────────────────────────────┐        ┌────────────────────────────┐
│ ● ◐1 ●2 ○7  turn this in… ⌄ │        │ ● ◐1 ●2 ○7            ⌃     │
└────────────────────────────┘        │ ────────────────────────── │
   │                                   │ ▾ Spreadsheet Agent  1     │
   │ drag the bar to reposition        │  ◐ P3 Monorepo deploy  19m │
   ▼                                   │     → review checklist     │
   right-click → Refresh / Quit        │ ▾ owner-operator  2        │
                                       │  ● make a macOS widget  now│
                                       │ ────────────────────────── │
                                       │ ● 127.0.0.1:47711  ↻  Quit  │
                                       └────────────────────────────┘
```

## Thin client over the daemon

Following OpenClaw's gateway pattern ([docs/inspiration.md](../../docs/inspiration.md)), the widget
**owns no state** — the daemon does. It:

- discovers the live port from `~/.owner-operator/daemon.json`,
- `GET`s `/snapshot` + `/triage` and joins them by id (exactly like [`core/sidebar.ts`](../../packages/core/src/sidebar.ts)),
- subscribes to the SSE `/events` stream so state changes land instantly (a 5s poll is the heartbeat / offline-recovery fallback).

If the daemon is down the widget stays on screen and shows how to start it.

## Run

Needs the daemon running (`oo daemon`) and a macOS GUI session. No Xcode / no signing — just SwiftPM:

```sh
cd apps/widget
make run          # show the floating widget          (swift run oo-widget)
make once         # print the current rail + exit      (swift run oo-widget --once) — the smoke test
make build        # release build
```

Controls: **drag** the bar to reposition · **click `⌄`** to expand/collapse · **right-click** for
Refresh / Quit. `--once` renders the same rail to stdout, so you can verify the daemon round-trip
headlessly.

### Keep it across reboots (optional)

The widget is omnipresent while running, but a process you launch dies on reboot. To have it come
back at login (and relaunch if it ever crashes), install it as a LaunchAgent:

```sh
make install      # load ~/Library/LaunchAgents/com.owner-operator.widget.plist (RunAtLoad + KeepAlive)
make uninstall    # remove it
```

## Scope

- **V1 (now):** read-only glance — prioritized leaves, live via the daemon push stream.
- **V2:** drop a prompt to the right agent (drill-in — your prompt, your branch; no telephone game).

> Tech note: the [VISION](../../VISION.md) leaned WidgetKit, but a WidgetKit widget lives in
> Notification Center and can't hold a live connection or float on top — so "always there +
> expandable + dynamic" is a floating panel agent. A WidgetKit complication can still ship later on
> top of the same daemon.

See [../../VISION.md](../../VISION.md).
