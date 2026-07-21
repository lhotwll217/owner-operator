// Mirrors the gateway's /session-state rows. The widget is only a renderer; the gateway owns
// state, title precedence, triage enrichment, and ordering fields.

import Foundation
import SwiftUI

enum WidgetGatewayEventKind: String, Decodable {
    case stateChanged = "state.changed"
    case agentRunChanged = "agent-run.changed"
}

struct WidgetGatewayEvent: Decodable {
    let kind: WidgetGatewayEventKind
}

/// Surface-independent delegated-run projection returned by `GET /agent-state`.
/// Lifecycle meaning, attention ordering, bounded text, and controls are derived in core.
struct AgentStateView: Decodable {
    let counts: AgentStateCounts
    let footer: String?
    let runs: [AgentRunView]

    static let empty = AgentStateView(
        counts: AgentStateCounts(queued: 0, running: 0, attention: 0),
        footer: nil,
        runs: []
    )
}

struct AgentStateCounts: Decodable {
    let queued: Int
    let running: Int
    let attention: Int
}

enum AgentRunViewCategory: String, Decodable {
    case attention
    case active
    case recent
}

struct AgentRunStatusView: Decodable {
    let glyph: String
    let text: AgentRunStatusText
}

enum AgentRunStatusText: String, Decodable {
    case queued
    case running
    case completed
    case failed
    case cancelled
    case interrupted
    case lost
}

enum AgentRunTone {
    case attention
    case positive
    case muted
}

struct AgentRunView: Decodable, Identifiable {
    let id: String
    let harness: String
    let task: String
    let status: AgentRunStatusView
    let category: AgentRunViewCategory
    let elapsedMs: Int
    let latestActivity: String
    let canCancel: Bool
    let canResume: Bool

    var tone: AgentRunTone {
        if category == .attention { return .attention }
        if status.text == .running || status.text == .completed { return .positive }
        return .muted
    }
}

/// Compact elapsed time for the widget; lifecycle timing itself is computed in core.
func shortDuration(milliseconds: Int) -> String {
    let seconds = max(0, milliseconds / 1_000)
    let minutes = seconds / 60
    let hours = minutes / 60
    if hours > 0 { return "\(hours)h \(minutes % 60)m" }
    if minutes > 0 { return "\(minutes)m" }
    return "\(seconds)s"
}

/// Lifecycle state — matches core/status.ts ThreadState. Lenient decode happens in SessionStateRow.
enum ThreadState: String, Decodable {
    case needsYou = "needs-you"
    case working
    case idle
    case done

    /// Loudest-first ordering, == core STATE_RANK.
    var rank: Int {
        switch self {
        case .needsYou: return 0
        case .working: return 1
        case .idle: return 2
        case .done: return 3
        }
    }

    /// Glyphs match the core thread-state model.
    var glyph: String {
        switch self {
        case .needsYou: return "◐"
        case .working: return "●"
        case .idle: return "○"
        case .done: return "✓"
        }
    }

    var color: Color {
        switch self {
        case .needsYou: return .yellow
        case .working: return .green
        case .idle, .done: return .secondary
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

/// One gateway-owned session-state row. Decodes leniently so an unexpected field never drops
/// the whole widget payload.
struct SessionStateRow: Decodable, Identifiable {
    let id: String
    let source: String
    let repo: String
    let app: String
    let topic: String
    let generatedTopic: String?
    let ownerTitle: String?
    let summary: String?
    let nextSteps: String?
    let priority: Int?
    let state: ThreadState
    let stateReason: String?
    let lastActive: String
    let lastActiveAt: String
    let createdAt: String
    let lastMessageAt: String
    let stateSince: String
    let diffAdded: Int?
    let diffDeleted: Int?
    let parentThreadId: String?
    /// Optimistic owner rename not yet confirmed by the daemon ("" = a pending clear).
    var pendingTitle: String? = nil
    /// Presentation-only depth assigned after parent identities are joined.
    var nestingDepth: Int = 0

    enum CodingKeys: String, CodingKey {
        case id, source, repo, app, topic, generatedTopic, ownerTitle, summary, nextSteps, priority
        case state, stateReason, lastActive, lastActiveAt, createdAt, lastMessageAt, stateSince
        case diffAdded, diffDeleted, parentThreadId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = (try? c.decode(String.self, forKey: .source)) ?? "?"
        repo = (try? c.decode(String.self, forKey: .repo)) ?? "?"
        app = (try? c.decode(String.self, forKey: .app)) ?? "?"
        topic = (try? c.decode(String.self, forKey: .topic)) ?? "(untitled)"
        generatedTopic = try? c.decode(String.self, forKey: .generatedTopic)
        ownerTitle = try? c.decode(String.self, forKey: .ownerTitle)
        summary = try? c.decode(String.self, forKey: .summary)
        nextSteps = try? c.decode(String.self, forKey: .nextSteps)
        priority = try? c.decode(Int.self, forKey: .priority)
        let raw = (try? c.decode(String.self, forKey: .state)) ?? "idle"
        state = ThreadState(rawValue: raw) ?? .idle
        stateReason = try? c.decode(String.self, forKey: .stateReason)
        lastActive = (try? c.decode(String.self, forKey: .lastActive)) ?? ""
        lastActiveAt = (try? c.decode(String.self, forKey: .lastActiveAt)) ?? ""
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        lastMessageAt = (try? c.decode(String.self, forKey: .lastMessageAt)) ?? ""
        stateSince = (try? c.decode(String.self, forKey: .stateSince)) ?? ""
        diffAdded = try? c.decode(Int.self, forKey: .diffAdded)
        diffDeleted = try? c.decode(Int.self, forKey: .diffDeleted)
        parentThreadId = try? c.decode(String.self, forKey: .parentThreadId)
    }

    /// A pending rename previews immediately; a pending clear falls through to the generated title.
    var title: String {
        if let pending = pendingTitle {
            return pending.isEmpty ? (generatedTopic ?? topic) : pending
        }
        return topic
    }

    /// The title is owner-pinned (generated titles keep landing underneath but don't show).
    var isRenamed: Bool {
        if let pending = pendingTitle { return !pending.isEmpty }
        return !(ownerTitle ?? "").isEmpty
    }
}

/// Rows grouped under one repo.
struct RepoGroup: Identifiable {
    let repo: String
    let rows: [SessionStateRow]
    var id: String { repo }
}

/// Group the gateway rows for rendering. State, title precedence, enrichment, and parent identity
/// are already in the payload; this applies optimistic state and nests delegated children.
func buildSessionState(rows input: [SessionStateRow], hidden: Set<String> = [], renames: [String: String] = [:]) -> (groups: [RepoGroup], counts: [ThreadState: Int]) {
    let rows = input.map { row -> SessionStateRow in
        var r = row
        r.pendingTitle = renames[row.id]
        return r
    }

    var counts: [ThreadState: Int] = [.needsYou: 0, .working: 0, .idle: 0, .done: 0]
    for r in rows {
        if hidden.contains(r.id) { counts[.done, default: 0] += 1; continue }
        counts[r.state, default: 0] += 1
    }

    let visible = rows.filter { $0.state != .done && !hidden.contains($0.id) }

    func attentionBefore(_ l: SessionStateRow, _ r: SessionStateRow) -> Bool {
        l.state.rank != r.state.rank
            ? l.state.rank < r.state.rank
            : l.lastMessageAt > r.lastMessageAt
    }

    func attention(_ rows: [SessionStateRow]) -> [SessionStateRow] {
        rows.sorted(by: attentionBefore)
    }

    let visibleIds = Set(visible.map(\.id))
    var rootsByRepo: [String: [SessionStateRow]] = [:]
    var childrenByParent: [String: [SessionStateRow]] = [:]
    for row in visible {
        if let parent = row.parentThreadId, parent != row.id, visibleIds.contains(parent) {
            childrenByParent[parent, default: []].append(row)
        } else {
            rootsByRepo[row.repo, default: []].append(row)
        }
    }

    func loudestInTree(_ root: SessionStateRow) -> SessionStateRow {
        attention([root] + (childrenByParent[root.id] ?? [])).first ?? root
    }

    var groups = rootsByRepo.map { repo, roots -> RepoGroup in
        let orderedRoots = roots.sorted { attentionBefore(loudestInTree($0), loudestInTree($1)) }
        var flattened: [SessionStateRow] = []
        for root in orderedRoots {
            flattened.append(root)
            flattened.append(contentsOf: attention(childrenByParent[root.id] ?? []).map { child in
                var nested = child
                nested.nestingDepth = 1
                return nested
            })
        }
        return RepoGroup(repo: repo, rows: flattened)
    }
    groups.sort { a, b in
        let la = attention(a.rows)[0], lb = attention(b.rows)[0]
        if attentionBefore(la, lb) { return true }
        if attentionBefore(lb, la) { return false }
        return a.repo < b.repo
    }
    return (groups, counts)
}

/// "10 minutes ago" -> "10m", "just now" -> "now".
func shortAge(_ s: String) -> String {
    if s.lowercased().contains("just now") { return "now" }
    let parts = s.split(separator: " ")
    if let n = parts.first, let unit = parts.dropFirst().first?.first { return "\(n)\(unit)" }
    return s
}

/// Priority badge color: P5 red · P4 yellow · P3 cyan · else dim.
func priorityColor(_ p: Int) -> Color {
    p >= 5 ? .red : p == 4 ? .yellow : p == 3 ? .cyan : .secondary
}
