// `oo-widget --once` — a headless render of the current session state to stdout. It reads the
// same /session-state payload as the GUI, so it doubles as the widget's smoke test.

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

private func agentGlyphColored(_ run: AgentRunView) -> String {
    switch run.tone {
    case .attention: return sgr(33, run.status.glyph)
    case .positive: return sgr(32, run.status.glyph)
    case .muted: return sgr(90, run.status.glyph)
    }
}

func renderText(rows: [SessionStateRow], agentState: AgentStateView = .empty, port: Int) -> String {
    let (groups, counts) = buildSessionState(rows: rows)
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
            let age = sgr(90, shortAge(r.lastActive))
            let indent = String(repeating: "  ", count: r.nestingDepth)
            lines.append("  \(indent)\(glyphColored(r.state)) \(badge)\(r.title)  \(age)")
            if let next = r.nextSteps, !next.isEmpty { lines.append(sgr(90, "      \(indent)→ \(next)")) }
        }
    }
    if !agentState.runs.isEmpty {
        lines.append("")
        lines.append(sgr(1, "Agent state"))
        for run in agentState.runs {
            let resumable = run.canResume ? sgr(33, " · resumable") : ""
            lines.append("  \(agentGlyphColored(run)) \(run.status.text.rawValue)  \(run.task)  " + sgr(90, "\(run.harness) · \(shortDuration(milliseconds: run.elapsedMs))") + resumable)
            if !run.latestActivity.isEmpty { lines.append(sgr(90, "      \(run.latestActivity)")) }
        }
    }
    lines.append("")
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
            let agentState = try await DaemonClient.get(AgentStateView.self, "/agent-state", discovery: discovery)
            output = renderText(rows: rows, agentState: agentState, port: port)
        } catch {
            output = "oo-widget: daemon offline on 127.0.0.1:\(port)\nstart it with:  oo daemon"
            code = 1
        }
    }
    sem.wait()
    print(output)
    return code
}
