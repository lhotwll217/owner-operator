// `oo-widget --once` — a headless render of the current sidebar to stdout (mirrors `oo --json`'s
// spirit). The same join + ordering the GUI uses, so it doubles as the widget's smoke test:
// run it and you see exactly what the menu bar would show.

import Foundation

/// ANSI helper: wrap `s` in SGR code(s).
private func sgr(_ code: Int, _ s: String) -> String { "\u{1b}[\(code)m\(s)\u{1b}[0m" }

private func glyphColored(_ st: ThreadState) -> String {
    switch st {
    case .needsYou: return sgr(33, st.glyph) // yellow
    case .working:  return sgr(32, st.glyph) // green
    default:        return sgr(90, st.glyph) // grey
    }
}

func renderText(snapshot: Snapshot, triage: [String: TriageInfo], port: Int) -> String {
    let (groups, counts) = buildSidebar(snapshot: snapshot, triage: triage)
    let total = groups.reduce(0) { $0 + $1.rows.count }

    let stats: [String] = [
        (counts[.needsYou] ?? 0) > 0 ? sgr(33, "◐ \(counts[.needsYou]!)") : nil,
        (counts[.working] ?? 0) > 0 ? sgr(32, "● \(counts[.working]!)") : nil,
        (counts[.idle] ?? 0) > 0 ? sgr(90, "○ \(counts[.idle]!)") : nil,
    ].compactMap { $0 }

    var lines: [String] = []
    lines.append(sgr(1, "Threads") + "  \(total)    " + stats.joined(separator: "  "))
    lines.append("")
    if groups.isEmpty { lines.append(sgr(90, "(no active threads)")) }
    for g in groups {
        lines.append(sgr(36, "▾ \(g.repo)") + sgr(90, "  \(g.rows.count)"))
        for r in g.rows {
            let badge = r.priority.map { sgr(33, "P\($0)") + " " } ?? ""
            let age = sgr(90, shortAge(r.thread.lastActive))
            lines.append("  \(glyphColored(r.state)) \(badge)\(r.title)  \(age)")
            if let next = r.nextSteps, !next.isEmpty { lines.append(sgr(90, "      → \(next)")) }
        }
    }
    lines.append("")
    lines.append(sgr(2, "127.0.0.1:\(port) · polled \(snapshot.polledAt)"))
    return lines.joined(separator: "\n")
}

/// Fetch + render once, synchronously (blocks on a semaphore so `main` can exit cleanly).
func runOnce() -> Int32 {
    let port = DaemonClient.discoverPort()
    let sem = DispatchSemaphore(value: 0)
    var output = ""
    var code: Int32 = 0
    Task {
        defer { sem.signal() }
        do {
            let snapshot = try await DaemonClient.get(Snapshot.self, "/snapshot", port: port)
            let triage = try await DaemonClient.get([String: TriageInfo].self, "/triage", port: port)
            output = renderText(snapshot: snapshot, triage: triage, port: port)
        } catch {
            output = "oo-widget: daemon offline on 127.0.0.1:\(port)\nstart it with:  oo daemon"
            code = 1
        }
    }
    sem.wait()
    print(output)
    return code
}
