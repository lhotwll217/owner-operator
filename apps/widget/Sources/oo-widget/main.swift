// Entry point. `--once` prints the rail and exits (smoke test); otherwise we run a menu-bar-less
// AppKit agent whose only window is the always-on-top floating widget.

import AppKit
import SwiftUI

if CommandLine.arguments.contains("--help") {
    print("""
    oo-widget — an always-on-top macOS glance over the Owner Operator daemon
      (no args)   show the floating widget (drag to move · click ⌄ to expand · right-click to quit)
      --once      print the current rail to stdout and exit
    """)
    exit(0)
}

if CommandLine.arguments.contains("--once") {
    exit(runOnce())
}

// Top-level code is nonisolated; AppKit is @MainActor. We're on the main thread here, so hop
// onto the main actor to boot. `run()` blocks until quit, keeping `delegate` (a weak app ref) alive.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: FloatingPanel?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory) // agent: no Dock icon, lives only as the floating HUD

        let client = DaemonClient.shared
        client.start()

        let host = NSHostingController(rootView: WidgetRoot().environmentObject(client))
        host.sizingOptions = [.preferredContentSize] // SwiftUI size drives the panel size

        let panel = FloatingPanel(contentViewController: host)
        panel.showTopRight()
        self.panel = panel
    }
}
