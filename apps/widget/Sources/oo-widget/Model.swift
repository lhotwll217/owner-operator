// Mirrors @owner-operator/core (status.ts + sidebar.ts): the daemon's ThreadStatus and
// TriageInfo, joined into a loudest-first sidebar. The widget NEVER computes state — it renders
// what the daemon owns. Keep the glyphs/ranks in lockstep with sidebar.ts.

import Foundation
import SwiftUI

/// Lifecycle state — matches core/status.ts ThreadState. Lenient decode (unknown → idle).
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

    /// Glyphs == the TUI sidebar (harness/src/sidebar.ts GLYPH).
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

/// One polled thread (the subset the sidebar renders). Decodes leniently so an unexpected
/// field never drops the whole snapshot.
struct ThreadStatus: Decodable, Identifiable {
    let id: String
    let source: String
    let repo: String
    let app: String
    let topic: String
    /// Owner-set title (rename). Wins over every generated topic; nil = model titles.
    let ownerTitle: String?
    let state: ThreadState
    let lastActive: String
    let createdAt: String
    let lastMessageAt: String
    /// ISO of when the thread entered its current state — for needs-you, when the turn completed.
    let stateSince: String
    let diffAdded: Int?
    let diffDeleted: Int?

    enum CodingKeys: String, CodingKey {
        case id, source, repo, app, topic, ownerTitle, state, lastActive, createdAt, lastMessageAt, stateSince, diffAdded, diffDeleted
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = (try? c.decode(String.self, forKey: .source)) ?? "?"
        repo = (try? c.decode(String.self, forKey: .repo)) ?? "?"
        app = (try? c.decode(String.self, forKey: .app)) ?? "?"
        topic = (try? c.decode(String.self, forKey: .topic)) ?? "(untitled)"
        ownerTitle = try? c.decode(String.self, forKey: .ownerTitle)
        let raw = (try? c.decode(String.self, forKey: .state)) ?? "idle"
        state = ThreadState(rawValue: raw) ?? .idle
        lastActive = (try? c.decode(String.self, forKey: .lastActive)) ?? ""
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        lastMessageAt = (try? c.decode(String.self, forKey: .lastMessageAt)) ?? ""
        stateSince = (try? c.decode(String.self, forKey: .stateSince)) ?? ""
        diffAdded = try? c.decode(Int.self, forKey: .diffAdded)
        diffDeleted = try? c.decode(Int.self, forKey: .diffDeleted)
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

/// The triage enrichment, joined by id == core/sidebar.ts TriageInfo.
struct TriageInfo: Decodable {
    let topic: String?
    let summary: String?
    let nextSteps: String?
    let priority: Int?
}

/// A full poll result == core StatusSnapshot.
struct Snapshot: Decodable {
    let polledAt: String
    let threads: [ThreadStatus]
}

/// A sidebar row: live thread + optional cached triage (the enrichment overlay).
struct SidebarRow: Identifiable {
    let thread: ThreadStatus
    let triage: TriageInfo?
    /// Optimistic owner rename not yet confirmed by the daemon ("" = a pending clear).
    var pendingTitle: String? = nil
    var id: String { thread.id }
    /// displayTopic == core: owner rename first, then the triaged title, else the raw scan topic.
    /// A pending rename previews immediately; a pending clear skips the (stale) owner title.
    var title: String {
        if let pending = pendingTitle {
            if !pending.isEmpty { return pending }
        } else if let t = thread.ownerTitle, !t.isEmpty {
            return t
        }
        if let t = triage?.topic, !t.isEmpty { return t }
        return thread.topic
    }
    /// The title is owner-pinned (so the AI has stopped retitling it).
    var isRenamed: Bool {
        if let pending = pendingTitle { return !pending.isEmpty }
        return !(thread.ownerTitle ?? "").isEmpty
    }
    var nextSteps: String? { triage?.nextSteps }
    var priority: Int? { triage?.priority }
    var state: ThreadState { thread.state }
}

/// Rows grouped under one repo == core RepoGroup.
struct RepoGroup: Identifiable {
    let repo: String
    let rows: [SidebarRow]
    var id: String { repo }
}

/// Join snapshot + triage into the grouped, loudest-first sidebar — the exact ordering of
/// core/sidebar.ts (groupByRepo + sortByAttention). Counts include done; the sidebar body omits it.
/// `hidden` are ids marked done locally but not yet confirmed by the daemon — counted as done,
/// dropped from the body, so the row vanishes the instant you click without lying about state.
/// `renames` are owner titles POSTed but not yet confirmed — shown immediately, same idea.
func buildSidebar(snapshot: Snapshot, triage: [String: TriageInfo], hidden: Set<String> = [], renames: [String: String] = [:]) -> (groups: [RepoGroup], counts: [ThreadState: Int]) {
    var counts: [ThreadState: Int] = [.needsYou: 0, .working: 0, .idle: 0, .done: 0]
    for t in snapshot.threads {
        if hidden.contains(t.id) { counts[.done, default: 0] += 1; continue }
        counts[t.state, default: 0] += 1
    }

    let rows = snapshot.threads
        .filter { $0.state != .done && !hidden.contains($0.id) }
        .map { SidebarRow(thread: $0, triage: triage[$0.id], pendingTitle: renames[$0.id]) }

    // attention sort: state rank asc, then most-recent message first.
    func attention(_ a: [SidebarRow]) -> [SidebarRow] {
        a.sorted { l, r in
            l.state.rank != r.state.rank
                ? l.state.rank < r.state.rank
                : l.thread.lastMessageAt > r.thread.lastMessageAt
        }
    }

    var byRepo: [String: [SidebarRow]] = [:]
    for r in rows { byRepo[r.thread.repo, default: []].append(r) }

    var groups = byRepo.map { RepoGroup(repo: $0.key, rows: attention($0.value)) }
    // Groups ordered by their loudest row, then recency, then repo name.
    groups.sort { a, b in
        let la = a.rows[0], lb = b.rows[0]
        if la.state.rank != lb.state.rank { return la.state.rank < lb.state.rank }
        if la.thread.lastMessageAt != lb.thread.lastMessageAt { return la.thread.lastMessageAt > lb.thread.lastMessageAt }
        return a.repo < b.repo
    }
    return (groups, counts)
}

/// "10 minutes ago" → "10m", "just now" → "now" (== sidebar.ts shortAge).
func shortAge(_ s: String) -> String {
    if s.lowercased().contains("just now") { return "now" }
    let parts = s.split(separator: " ")
    if let n = parts.first, let unit = parts.dropFirst().first?.first { return "\(n)\(unit)" }
    return s
}

/// Priority badge color == sidebar.ts prio(): P5 red · P4 yellow · P3 cyan · else dim.
func priorityColor(_ p: Int) -> Color {
    p >= 5 ? .red : p == 4 ? .yellow : p == 3 ? .cyan : .secondary
}
