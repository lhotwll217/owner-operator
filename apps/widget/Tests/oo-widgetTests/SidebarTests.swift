// Unit tests for the widget's pure logic — the join + ordering the render depends on, the lenient
// decode, and the 5-min fresh-completion rule. Swift Testing (Xcode 16 / Swift 6), the current
// standard for new Swift tests. No daemon, no GUI; runs via `swift test`.

import Testing
import Foundation
@testable import oo_widget

@Suite("rail")
struct RailTests {

    // ThreadStatus only has a JSON decoder, so build threads as JSON.
    private func thread(
        id: String, repo: String = "repo", state: String = "idle", topic: String = "topic",
        lastMessageAt: String = "2026-01-01T00:00:00.000Z",
        stateSince: String = "2026-01-01T00:00:00.000Z",
        diffAdded: Int? = nil
    ) -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "source": "claude", "repo": repo, "app": "App", "topic": topic,
            "state": state, "lastActive": "now", "createdAt": "2026-01-01T00:00:00.000Z",
            "lastMessageAt": lastMessageAt, "stateSince": stateSince,
        ]
        if let diffAdded { d["diffAdded"] = diffAdded }
        return d
    }

    private func snapshot(_ threads: [[String: Any]]) throws -> Snapshot {
        let data = try JSONSerialization.data(withJSONObject: ["polledAt": "2026-01-01T00:00:00.000Z", "threads": threads])
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    private func isoNow(_ offset: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(offset))
    }

    // MARK: - ordering

    @Test func loudestFirstWithinGroup() throws {
        let snap = try snapshot([
            thread(id: "i", state: "idle"),
            thread(id: "n", state: "needs-you"),
            thread(id: "w", state: "working"),
        ])
        let (groups, _) = buildRail(snapshot: snap, triage: [:])
        #expect(groups.count == 1)
        #expect(groups[0].rows.map(\.id) == ["n", "w", "i"])   // needs-you → working → idle
    }

    @Test func recencyTiebreak() throws {
        let snap = try snapshot([
            thread(id: "old", state: "needs-you", lastMessageAt: "2026-01-01T00:00:00.000Z"),
            thread(id: "new", state: "needs-you", lastMessageAt: "2026-01-02T00:00:00.000Z"),
        ])
        let (groups, _) = buildRail(snapshot: snap, triage: [:])
        #expect(groups[0].rows.map(\.id) == ["new", "old"])    // most recent first
    }

    @Test func groupsOrderedByLoudestRow() throws {
        let snap = try snapshot([
            thread(id: "a", repo: "alpha", state: "idle"),
            thread(id: "b", repo: "beta", state: "needs-you"),
        ])
        let (groups, _) = buildRail(snapshot: snap, triage: [:])
        #expect(groups.map(\.repo) == ["beta", "alpha"])       // beta has the needs-you → first
    }

    // MARK: - hidden (optimistic mark-done) + counts

    @Test func hiddenDroppedFromBodyButCountedDone() throws {
        let snap = try snapshot([
            thread(id: "x", state: "needs-you"),
            thread(id: "y", state: "working"),
        ])
        let (groups, counts) = buildRail(snapshot: snap, triage: [:], hidden: ["x"])
        let ids = groups.flatMap { $0.rows.map(\.id) }
        #expect(!ids.contains("x"))
        #expect(ids.contains("y"))
        #expect(counts[.needsYou] == 0)   // x moved out of needs-you...
        #expect(counts[.done] == 1)        // ...counted as done
        #expect(counts[.working] == 1)
    }

    @Test func doneExcludedFromBody() throws {
        let snap = try snapshot([
            thread(id: "d", state: "done"),
            thread(id: "w", state: "working"),
        ])
        let (groups, counts) = buildRail(snapshot: snap, triage: [:])
        #expect(groups.flatMap { $0.rows.map(\.id) } == ["w"])
        #expect(counts[.done] == 1)
    }

    // MARK: - triage join

    @Test func triageEnrichmentWins() throws {
        let snap = try snapshot([thread(id: "t", state: "needs-you", topic: "raw topic")])
        let triage = ["t": TriageInfo(topic: "nice title", summary: nil, nextSteps: "do the thing", priority: 4)]
        let row = buildRail(snapshot: snap, triage: triage).groups[0].rows[0]
        #expect(row.title == "nice title")
        #expect(row.nextSteps == "do the thing")
        #expect(row.priority == 4)
    }

    @Test func titleFallsBackToTopic() throws {
        let snap = try snapshot([thread(id: "t", state: "needs-you", topic: "raw topic")])
        #expect(buildRail(snapshot: snap, triage: [:]).groups[0].rows[0].title == "raw topic")
    }

    // MARK: - lenient decode

    @Test func unknownStateBecomesIdle() throws {
        let snap = try snapshot([thread(id: "z", state: "totally-bogus")])
        #expect(snap.threads[0].state == .idle)
    }

    @Test func missingDiffIsNil() throws {
        let snap = try snapshot([thread(id: "z", state: "idle")])
        #expect(snap.threads[0].diffAdded == nil)
    }

    // MARK: - formatters (parameterized)

    @Test(arguments: [
        ("just now", "now"), ("10 minutes ago", "10m"), ("3 hours ago", "3h"), ("2 days ago", "2d"),
    ])
    func shortAgeCompacts(_ c: (input: String, expected: String)) {
        #expect(shortAge(c.input) == c.expected)
    }

    @Test func parsesISOWithAndWithoutFractionalSeconds() {
        #expect(parseISODate("2026-06-23T09:19:51.214Z") != nil)
        #expect(parseISODate("2026-06-23T09:19:51Z") != nil)
        #expect(parseISODate("not a date") == nil)
    }

    // MARK: - the 5-min fresh-completion rule

    @Test @MainActor func freshNeedsYouWindow() throws {
        let snap = try snapshot([
            thread(id: "fresh", state: "needs-you", stateSince: isoNow(-60)),    // 1 min ago
            thread(id: "stale", state: "needs-you", stateSince: isoNow(-600)),   // 10 min ago
            thread(id: "busy", state: "working", stateSince: isoNow(-60)),       // working, not needs-you
        ])
        let client = DaemonClient()
        client.groups = buildRail(snapshot: snap, triage: [:]).groups
        #expect(client.freshNeedsYou(window: 300).map(\.id) == ["fresh"])
    }
}
