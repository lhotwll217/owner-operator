# apps/widget — macOS floating HUD

Always-on-top SwiftUI panel (borderless `NSPanel`, all Spaces). Collapses to a bar, expands to the
thread sidebar. Read-only. v1.

## Thin client over the daemon

Owns no state — the daemon does.

- port — `~/.owner-operator/daemon.json`
- data — `GET /snapshot` + `/triage`, joined by id (cf. [`core/sidebar.ts`](../../packages/core/src/sidebar.ts))
- live — SSE `/events`; short poll as fallback

UI (layout, controls, animation) lives in [`Sources/oo-widget/UI.swift`](Sources/oo-widget/UI.swift), not here.

## Build · run · test

Needs `oo daemon` + a GUI session. SwiftPM — no Xcode project, no signing.

```sh
make run       # launch
make once      # print the sidebar and exit — headless smoke test
make install   # LaunchAgent (survives reboot); make uninstall removes
swift test     # unit tests — sidebar join, decode, fresh-window
```

`swift test` needs XCTest (Xcode, not CLT): `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test`.

## Notes

- Read-only.
- Not WidgetKit — can't float on top or hold a live connection.
