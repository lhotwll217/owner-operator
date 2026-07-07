# apps/widget — macOS floating HUD

Always-on-top SwiftUI panel (borderless `NSPanel`, all Spaces). Collapses to a bar, expands to the
current session state. Read-only over your sessions; owner state (mark done, rename a title) goes through
the daemon. v1.

## Thin client over the daemon

Owns no state — the daemon does.

- port — `~/.owner-operator/daemon.json`
- data — `GET /session-state` (cf. [`core/session-state.ts`](../../packages/core/src/session-state.ts))
- live — SSE `/events`; short poll as fallback

UI (layout, controls, animation) lives in [`Sources/oo-widget/UI.swift`](Sources/oo-widget/UI.swift), not here.

## Build · run · test

Needs `oo daemon` + a GUI session. SwiftPM — no Xcode project, no signing.

```sh
make run       # launch
make once      # print the session state and exit — headless smoke test
make install   # LaunchAgent (survives reboot); make uninstall removes
swift test     # unit tests — session state grouping, decode, fresh-window
```

`swift test` needs XCTest (Xcode, not CLT): `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test`.

## Notes

- Read-only over your sessions. Owner actions write only owner state: mark done, and rename
  (double-click a title; your title shows instead of the AI's — which keeps titling underneath
  as an audit trail — until you clear the rename via an empty title or the row's context menu).
- Not WidgetKit — can't float on top or hold a live connection.
