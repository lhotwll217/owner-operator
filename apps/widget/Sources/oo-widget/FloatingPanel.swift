// The omnipresent shell: a borderless floating panel that sits ABOVE other windows and rides
// along to every Space / fullscreen app, so the widget is always on screen. Non-activating (it
// never steals focus), draggable by its background, and it keeps its top-left corner fixed as the
// SwiftUI content grows/shrinks (collapse ⇄ expand), so expanding never walks off the screen top.

import AppKit

final class FloatingPanel: NSPanel, NSWindowDelegate {
    // We pin the TOP-RIGHT corner: a top-right HUD should grow down-and-left as it expands, so it
    // never walks off the right/top edge — even if SwiftUI sizes the content a frame after we place it.
    private var anchorTopRight: NSPoint?

    init(contentViewController vc: NSViewController) {
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

    /// Park it in the top-right of the active screen and show it without activating the app.
    func showTopRight() {
        if let vf = NSScreen.main?.visibleFrame {
            setFrameOrigin(NSPoint(x: vf.maxX - frame.width - 16, y: vf.maxY - frame.height - 16))
        }
        anchorTopRight = NSPoint(x: frame.maxX, y: frame.maxY)
        orderFrontRegardless()
    }

    // Track the corner the user drags to…
    func windowDidMove(_ notification: Notification) {
        anchorTopRight = NSPoint(x: frame.maxX, y: frame.maxY)
    }

    // …and re-pin it when the content resizes, so the panel grows down-and-left from a fixed
    // top-right corner. Clamp to the visible screen so it's never pushed off an edge.
    func windowDidResize(_ notification: Notification) {
        guard let a = anchorTopRight else {
            anchorTopRight = NSPoint(x: frame.maxX, y: frame.maxY)
            return
        }
        var origin = NSPoint(x: a.x - frame.width, y: a.y - frame.height)
        if let vf = (screen ?? NSScreen.main)?.visibleFrame {
            origin.x = min(max(origin.x, vf.minX), max(vf.minX, vf.maxX - frame.width))
            origin.y = min(max(origin.y, vf.minY), max(vf.minY, vf.maxY - frame.height))
        }
        if abs(frame.minX - origin.x) > 0.5 || abs(frame.minY - origin.y) > 0.5 {
            setFrameOrigin(origin)
        }
    }
}
