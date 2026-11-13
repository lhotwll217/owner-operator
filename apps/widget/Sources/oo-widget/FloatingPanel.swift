// The omnipresent shell: a borderless floating panel that sits ABOVE other windows and rides
// along to every Space / fullscreen app, so the widget is always on screen. Non-activating (it
// never steals focus), draggable, and it keeps the top-right corner the owner placed it at as the
// SwiftUI content grows/shrinks (collapse ⇄ expand).

import AppKit
import Combine

/// The visible height of the screen the panel is anchored on. The expanded list sizes from it, so
/// the panel always fits the screen it is on, whichever screen has focus.
final class PanelScreen: ObservableObject {
    @Published var visibleHeight: CGFloat = NSScreen.main?.visibleFrame.height ?? 900
}

final class FloatingPanel: NSPanel, NSWindowDelegate {
    private let panelScreen: PanelScreen
    /// The top-right corner the owner placed. Expanding may shift the panel to stay on screen;
    /// that shift never moves the anchor, so collapsing returns the bar to where it was put.
    private var anchorTopRight: NSPoint?
    private var repositioning = false

    init(contentViewController vc: NSViewController, panelScreen: PanelScreen) {
        self.panelScreen = panelScreen
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 80),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        contentViewController = vc
        isFloatingPanel = true
        level = .floating                  // above normal windows
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        isMovableByWindowBackground = true // drag the background to reposition
        appearance = NSAppearance(named: .darkAqua) // the header palette is drawn for dark only
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        hidesOnDeactivate = false
        animationBehavior = .utilityWindow
        delegate = self
    }

    // Borderless windows can't become key by default; allow it so SwiftUI buttons get clicks —
    // but never main, so we don't act like a foreground app.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // AppKit spends a click on an unfocused window on focusing it, and SwiftUI content never
    // accepts the first mouse, so a row or button took two clicks. Focus first, then dispatch.
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, !isKeyWindow { makeKey() }
        super.sendEvent(event)
    }

    /// Park it in the top-right of the active screen and show it without activating the app.
    func showTopRight() {
        if let vf = NSScreen.main?.visibleFrame {
            setFrameOrigin(NSPoint(x: vf.maxX - frame.width - 16, y: vf.maxY - frame.height - 16))
        }
        orderFrontRegardless()
    }

    func windowDidMove(_ notification: Notification) {
        guard !repositioning else { return }
        anchorTopRight = NSPoint(x: frame.maxX, y: frame.maxY)
        if let h = anchorScreen?.visibleFrame.height, h != panelScreen.visibleHeight {
            panelScreen.visibleHeight = h
        }
    }

    // Re-pin the anchor when the content resizes, so the panel grows down-and-left from it,
    // clamped to the anchor's screen so it's never pushed off an edge.
    func windowDidResize(_ notification: Notification) {
        guard let a = anchorTopRight else { return }
        var origin = NSPoint(x: a.x - frame.width, y: a.y - frame.height)
        if let vf = anchorScreen?.visibleFrame {
            origin.x = min(max(origin.x, vf.minX), max(vf.minX, vf.maxX - frame.width))
            origin.y = min(max(origin.y, vf.minY), max(vf.minY, vf.maxY - frame.height))
        }
        if abs(frame.minX - origin.x) > 0.5 || abs(frame.minY - origin.y) > 0.5 {
            repositioning = true
            setFrameOrigin(origin)
            repositioning = false
        }
    }

    private var anchorScreen: NSScreen? {
        guard let a = anchorTopRight else { return screen }
        let inside = NSPoint(x: a.x - 1, y: a.y - 1)
        return NSScreen.screens.first { $0.frame.contains(inside) } ?? screen
    }
}
