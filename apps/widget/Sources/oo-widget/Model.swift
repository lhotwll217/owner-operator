// Mirrors the gateway's /session-state rows. The widget is only a renderer; the gateway owns
// state, title precedence, triage enrichment, sections, and display order.

import Foundation

enum WidgetGatewayEventKind: String, Decodable {
    case stateChanged = "state.changed"
    case agentRunChanged = "agent-run.changed"
}

struct WidgetGatewayEvent: Decodable {
    let kind: WidgetGatewayEventKind
}

/// Lifecycle state — matches core/status.ts ThreadState. Lenient decode happens in SessionStateRow.
enum ThreadState: String, Decodable {
    case needsYou = "needs-you"
    case working
    case idle
    case done
}

/// The panel's sections, in display order — matches core/session-state.ts SESSION_SECTIONS.
enum SessionSection: String, CaseIterable, Identifiable {
    case needsYou = "needs-you"
    case working
    case idle
    case snoozed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .idle: return "Idle"
        case .snoozed: return "Snoozed"
        }
    }
}

/// The owner's snooze while it holds.
enum Snooze: Equatable {
    case until(Date)
    case nextMessage

    struct Wire: Decodable { let kind: String; let until: String? }

    /// `{kind:"until",until}` or `{kind:"next-message"}`; anything else is no snooze.
    init?(wire: Wire) {
        switch wire.kind {
        case "next-message": self = .nextMessage
        case "until":
            guard let until = wire.until.flatMap(parseISODate) else { return nil }
            self = .until(until)
        default: return nil
        }
    }
}

/// Parse an ISO-8601 timestamp, with or without fractional seconds.
func parseISODate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

func isoString(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
}

/// One gateway-owned session-state row. Decodes leniently so an unexpected field never drops
/// the whole widget payload.
struct SessionStateRow: Decodable, Identifiable {
    let id: String
    let source: String
    let repo: String
    let project: String?
    let app: String
    let topic: String
    let generatedTopic: String?
    let ownerTitle: String?
    let statusSummary: String?
    let state: ThreadState
    let lastActive: String
    let lastActiveAt: String
    let createdAt: String
    let lastMessageAt: String
    let stateSince: String
    let diffAdded: Int?
    let diffDeleted: Int?
    let parentThreadId: String?
    let section: SessionSection
    let depth: Int
    let snooze: Snooze?
    let link: URL?
    /// Optimistic owner rename not yet confirmed by the daemon ("" = a pending clear).
    var pendingTitle: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, source, repo, project, app, topic, generatedTopic, ownerTitle, statusSummary
        case state, lastActive, lastActiveAt, createdAt, lastMessageAt, stateSince
        case diffAdded, diffDeleted, parentThreadId, section, depth, snooze, link
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = (try? c.decode(String.self, forKey: .source)) ?? "?"
        repo = (try? c.decode(String.self, forKey: .repo)) ?? "?"
        project = try? c.decode(String.self, forKey: .project)
        app = (try? c.decode(String.self, forKey: .app)) ?? "?"
        topic = (try? c.decode(String.self, forKey: .topic)) ?? "(untitled)"
        generatedTopic = try? c.decode(String.self, forKey: .generatedTopic)
        ownerTitle = try? c.decode(String.self, forKey: .ownerTitle)
        statusSummary = try? c.decode(String.self, forKey: .statusSummary)
        let raw = (try? c.decode(String.self, forKey: .state)) ?? "idle"
        state = ThreadState(rawValue: raw) ?? .idle
        lastActive = (try? c.decode(String.self, forKey: .lastActive)) ?? ""
        lastActiveAt = (try? c.decode(String.self, forKey: .lastActiveAt)) ?? ""
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        lastMessageAt = (try? c.decode(String.self, forKey: .lastMessageAt)) ?? ""
        stateSince = (try? c.decode(String.self, forKey: .stateSince)) ?? ""
        diffAdded = try? c.decode(Int.self, forKey: .diffAdded)
        diffDeleted = try? c.decode(Int.self, forKey: .diffDeleted)
        parentThreadId = try? c.decode(String.self, forKey: .parentThreadId)
        section = SessionSection(rawValue: (try? c.decode(String.self, forKey: .section)) ?? "") ?? .idle
        depth = max(0, (try? c.decode(Int.self, forKey: .depth)) ?? 0)
        snooze = (try? c.decode(Snooze.Wire.self, forKey: .snooze)).flatMap(Snooze.init(wire:))
        link = (try? c.decode(String.self, forKey: .link)).flatMap { URL(string: $0) }.flatMap { $0.scheme == nil ? nil : $0 }
    }

    /// A pending rename previews immediately; a pending clear falls through to the generated title.
    var title: String {
        if let pending = pendingTitle {
            return pending.isEmpty ? (generatedTopic ?? topic) : pending
        }
        return topic
    }

    /// The status summary a widget surface shows. Every visible row carries one, including a
    /// working row: that is where the owner reads what is happening right now.
    var displayStatusSummary: String? {
        guard let statusSummary, !statusSummary.isEmpty else { return nil }
        return statusSummary
    }

    /// A delegated child's status summary stays folded until the owner opens it, so a parent's
    /// children read as a list of runs rather than a wall of nested prose.
    var statusSummaryStartsCollapsed: Bool { depth > 0 }

    /// The title is owner-pinned (generated titles keep landing underneath but don't show).
    var isRenamed: Bool {
        if let pending = pendingTitle { return !pending.isEmpty }
        return !(ownerTitle ?? "").isEmpty
    }
}

/// One section's rows in daemon order, children following their parent.
struct SectionRows: Identifiable {
    let kind: SessionSection
    let rows: [SessionStateRow]
    var id: SessionSection { kind }
    /// Root rows only: a delegated child is part of its parent's line of work.
    var count: Int { rows.filter { $0.depth == 0 }.count }
}

/// What the panel renders: the daemon's rows split on `section`, every section present in order.
struct WidgetSnapshot {
    var sections: [SectionRows] = SessionSection.allCases.map { SectionRows(kind: $0, rows: []) }

    func section(_ kind: SessionSection) -> SectionRows { sections.first { $0.kind == kind }! }
    func count(_ kind: SessionSection) -> Int { section(kind).count }
    var rows: [SessionStateRow] { sections.flatMap(\.rows) }
}

/// The only arrangement left in Swift: hide rows with an owner write in flight (with their
/// subtree, the deeper rows that follow them), preview renames, and split on `section`.
func buildSnapshot(rows input: [SessionStateRow], hidden: Set<String> = [], renames: [String: String] = [:]) -> WidgetSnapshot {
    var visible: [SessionStateRow] = []
    var hiddenDepth: Int? = nil
    for row in input {
        if let depth = hiddenDepth, row.depth > depth { continue }
        hiddenDepth = nil
        if hidden.contains(row.id) { hiddenDepth = row.depth; continue }
        var r = row
        r.pendingTitle = renames[row.id]
        visible.append(r)
    }
    return WidgetSnapshot(sections: SessionSection.allCases.map { kind in
        SectionRows(kind: kind, rows: visible.filter { $0.section == kind })
    })
}

/// "10 minutes ago" -> "10m", "just now" -> "now".
func shortAge(_ s: String) -> String {
    if s.lowercased().contains("just now") { return "now" }
    let parts = s.split(separator: " ")
    if let n = parts.first, let unit = parts.dropFirst().first?.first { return "\(n)\(unit)" }
    return s
}

/// The snooze menu's choices. Each resolves to an absolute instant in the owner's calendar, so
/// the daemon only ever stores an instant (or "until the next message").
enum SnoozePreset: CaseIterable, Identifiable {
    case twoHours, thisEvening, tomorrowMorning, nextMessage

    var id: Self { self }

    var label: String {
        switch self {
        case .twoHours: return "For 2 hours"
        case .thisEvening: return "This evening"
        case .tomorrowMorning: return "Tomorrow"
        case .nextMessage: return "Until next message"
        }
    }

    /// The presets on offer at `now`: "this evening" leaves the menu at 18:00.
    static func available(at now: Date = Date(), calendar: Calendar = .current) -> [SnoozePreset] {
        allCases.filter { $0 != .thisEvening || calendar.component(.hour, from: now) < 18 }
    }

    /// The wake instant, or nil for until-the-next-message.
    func wake(from now: Date = Date(), calendar: Calendar = .current) -> Date? {
        switch self {
        case .twoHours:
            return now.addingTimeInterval(2 * 60 * 60)
        case .thisEvening:
            return calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now)
        case .tomorrowMorning:
            guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) else { return nil }
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow)
        case .nextMessage:
            return nil
        }
    }
}

/// When a snoozed row comes back, as the right column shows it: "18:00", "Tomorrow 9:00", "Fri 9:00".
func snoozeLabel(_ snooze: Snooze, now: Date = Date(), calendar: Calendar = .current) -> String {
    guard case .until(let date) = snooze else { return "next message" }
    let time = "\(calendar.component(.hour, from: date)):" + String(format: "%02d", calendar.component(.minute, from: date))
    if calendar.isDate(date, inSameDayAs: now) { return time }
    if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
        return "Tomorrow \(time)"
    }
    let weekday = calendar.shortWeekdaySymbols[calendar.component(.weekday, from: date) - 1]
    return "\(weekday) \(time)"
}
