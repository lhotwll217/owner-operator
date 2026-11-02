// `oo-widget --once` — a headless render of the current session state to stdout. It reads the
// same /session-state payload as the GUI, so it doubles as the widget's smoke test.

import Foundation

/// ANSI helper: wrap `s` in SGR code(s).
private func sgr(_ code: Int, _ s: String) -> String { "\u{1b}[\(code)m\(s)\u{1b}[0m" }

/// The right column, as the panel shows it: age (yellow when it needs you, a green dot while
/// working), or the wake time of a snoozed row; then the diff.
private func rightColumn(_ r: SessionStateRow, now: Date) -> String {
    let age = shortAge(r.lastActive)
    let when: String
    switch r.section {
    case .needsYou: when = sgr(33, age)
    case .working: when = sgr(32, "●") + " " + sgr(90, age)
    case .idle: when = sgr(90, age)
    case .snoozed: when = sgr(90, r.snooze.map { "until \(snoozeLabel($0, now: now))" } ?? age)
    }
    guard r.depth == 0, r.diffAdded != nil || r.diffDeleted != nil else { return when }
    return when + "  " + sgr(32, "+\(r.diffAdded ?? 0)") + " " + sgr(31, "−\(r.diffDeleted ?? 0)")
}

func renderText(rows: [SessionStateRow], port: Int, now: Date = Date()) -> String {
    let snapshot = buildSnapshot(rows: rows)
    var lines: [String] = []
    for section in snapshot.sections where section.kind == .needsYou || !section.rows.isEmpty {
        lines.append(sgr(1, section.kind.title) + sgr(90, "  \(section.count)"))
        if section.rows.isEmpty { lines.append(sgr(90, "  Nothing needs you")) }
        for r in section.rows {
            let indent = String(repeating: "  ", count: r.depth)
            lines.append("  \(indent)\(r.title)  \(rightColumn(r, now: now))")
            if r.depth == 0 {
                lines.append("    " + sgr(34, r.repo) + (r.displayStatusSummary.map { sgr(90, "  \($0)") } ?? ""))
            }
        }
        lines.append("")
    }
    lines.append(sgr(2, "127.0.0.1:\(port)"))
    return lines.joined(separator: "\n")
}

/// Fetch + render once, synchronously (blocks on a semaphore so `main` can exit cleanly).
func runOnce() -> Int32 {
    let discovery = DaemonClient.discoverGateway()
    let port = discovery?.port ?? DaemonClient.defaultPort
    let sem = DispatchSemaphore(value: 0)
    var output = ""
    var code: Int32 = 0
    Task {
        defer { sem.signal() }
        do {
            guard let discovery else { throw URLError(.cannotConnectToHost) }
            let rows = try await DaemonClient.get([SessionStateRow].self, "/session-state", discovery: discovery)
            output = renderText(rows: rows, port: port)
        } catch {
            output = "oo-widget: daemon offline on 127.0.0.1:\(port)\nstart it with:  oo daemon"
            code = 1
        }
    }
    sem.wait()
    print(output)
    return code
}
