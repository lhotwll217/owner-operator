import AppKit
import SwiftUI

@main
struct LiveSummaryProof {
    @MainActor static func main() throws {
        let arguments = CommandLine.arguments
        precondition(arguments.count == 3, "Pass the expected Gateway rows and screenshot prefix")
        let expected = try JSONDecoder().decode([SessionStateRow].self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1])))
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let client = DaemonClient.shared
        client.start()
        let host = NSHostingView(rootView: WidgetRoot().environmentObject(client))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 32), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFrontRegardless()
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            let rows = client.groups.flatMap(\.rows)
            if client.online && expected.allSatisfy({ want in rows.contains { $0.id == want.id && $0.summary == want.summary && $0.title == want.title && $0.state == want.state } }) { break }
        }
        let rows = client.groups.flatMap(\.rows)
        precondition(client.online, "Native DaemonClient must connect to the isolated Gateway")
        precondition(rows.count == expected.count, "Native client must receive every visible row")
        for want in expected {
            guard let row = rows.first(where: { $0.id == want.id }) else { fatalError("Missing native row \(want.id)") }
            precondition(row.summary == want.summary, "Native summary differs for \(want.id)")
            precondition(row.title == want.title && row.state == want.state, "Native presentation or lifecycle differs for \(want.id)")
            if row.parentThreadId != nil { precondition(row.nestingDepth > 0, "Child must render nested") }
            precondition(!row.title.isEmpty, "Every row carries a title while it is on screen")
            precondition(row.displayStatusSummary == row.summary, "Every visible row shows its status summary, for \(want.id)")
            print("NATIVE \(row.id) \(row.state.rawValue) pending=\(row.summaryPending) \(row.title) | \(row.displayStatusSummary ?? "(none yet)")")
        }
        func capture(_ suffix: String) throws {
            window.setContentSize(host.fittingSize)
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            let image = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
            host.cacheDisplay(in: host.bounds, to: image)
            try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: arguments[2] + suffix + ".png"))
        }
        try capture("-collapsed")
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: 284, y: host.bounds.midY), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
            window.sendEvent(event)
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        try capture("-expanded")
        precondition(host.bounds.height > 100, "Actual expand button must open native summary rows")
        func scrollView(in view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            for child in view.subviews {
                if let scroll = scrollView(in: child) { return scroll }
            }
            return nil
        }
        if let scroll = scrollView(in: host), let document = scroll.documentView {
            document.scroll(NSPoint(x: 0, y: document.bounds.height))
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            try capture("-expanded-bottom")
        }
        precondition(rows.contains { $0.displayStatusSummary?.isEmpty == false }, "The panel must carry generated status summaries, not titles alone")
        print("PASS native Gateway delivery and WidgetRoot rendering, \(rows.count) rows")
        window.orderOut(nil)
    }
}
