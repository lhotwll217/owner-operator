// Unit tests for the widget's pure logic — the join + ordering the whole render depends on, the
// lenient decode, and the 5-min fresh-completion rule. No daemon, no GUI; runs via `swift test`.

import XCTest
@testable import oo_widget

final class RailTests: XCTestCase {

    // MARK: - helpers (ThreadStatus only has a JSON decoder, so we build threads as JSON)

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
        let obj: [String: Any] = ["polledAt": "2026-01-01T00:00:00.000Z", "threads": threads]
        let data = try JSONSerialization.data(withJSONObject: obj)
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    private func isoNow(_ offset: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(offset))
    }

    // MARK: - ordering

    func testLoudestFirstWithinGroup() throws {
        let snap = try snapshot([
            thread(id: "i", state: "idle"),
            thread(id: "n", state: "needs-you"),
            thread(id: "w", state: "working"),
        ])
        let (groups, _) = buildRail(snapshot: snap, triage: [:])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].rows.map(\.id), ["n", "w", "i"])  // needs-you → working → idle
    }

    func testRecencyTiebreak() throws {
        let snap = try snapshot([
            thread(id: "old", state: "needs-you", lastMessageAt: "2026-01-01T00:00:00.000Z"),
            thread(id: "new", state: "needs-you", lastMessageAt: "2026-01-02T00:00:00.000Z"),
        ])
        let (groups, _) = buildRail(snapshot: snap, triage: [:])
        XCTAssertEqual(groups[0].rows.map(\.id), ["new", "old"])  // most recent first
    }

    func testGroupsOrderedByLoudestRow() throws {
        let snap = try snapshot([
            thread(id: "a", repo: "alpha", state: "idle"),
            thread(id: "b", repo: "beta", state: "needs-you"),
        ])
        let (groups, _) = buildRail(snapshot: snap, triage: [:])
        XCTAssertEqual(groups.map(\.repo), ["beta", "alpha"])  // beta has the needs-you → first
    }

    // MARK: - hidden (optimistic mark-done) + counts

    func testHiddenDroppedFromBodyButCountedDone() throws {
        let snap = try snapshot([
            thread(id: "x", state: "needs-you"),
            thread(id: "y", state: "working"),
        ])
        let (groups, counts) = buildRail(snapshot: snap, triage: [:], hidden: ["x"])
        let ids = groups.flatMap { $0.rows.map(\.id) }
        XCTAssertFalse(ids.contains("x"))
        XCTAssertTrue(ids.contains("y"))
        XCTAssertEqual(counts[.needsYou] ?? -1, 0)   // x moved out of needs-you
        XCTAssertEqual(counts[.done] ?? -1, 1)        // ...and counted as done
        XCTAssertEqual(counts[.working] ?? -1, 1)
    }

    func testDoneExcludedFromBody() throws {
        let snap = try snapshot([
            thread(id: "d", state: "done"),
            thread(id: "w", state: "working"),
        ])
        let (groups, counts) = buildRail(snapshot: snap, triage: [:])
        XCTAssertEqual(groups.flatMap { $0.rows.map(\.id) }, ["w"])
        XCTAssertEqual(counts[.done] ?? -1, 1)
    }

    // MARK: - triage join

    func testTriageEnrichmentWins() throws {
        let snap = try snapshot([thread(id: "t", state: "needs-you", topic: "raw topic")])
        let triage = ["t": TriageInfo(topic: "nice title", summary: nil, nextSteps: "do the thing", priority: 4)]
        let row = buildRail(snapshot: snap, triage: triage).groups[0].rows[0]
        XCTAssertEqual(row.title, "nice title")
        XCTAssertEqual(row.nextSteps, "do the thing")
        XCTAssertEqual(row.priority, 4)
    }

    func testTitleFallsBackToTopic() throws {
        let snap = try snapshot([thread(id: "t", state: "needs-you", topic: "raw topic")])
        XCTAssertEqual(buildRail(snapshot: snap, triage: [:]).groups[0].rows[0].title, "raw topic")
    }

    // MARK: - lenient decode

    func testUnknownStateBecomesIdle() throws {
        let snap = try snapshot([thread(id: "z", state: "totally-bogus")])
        XCTAssertEqual(snap.threads[0].state, .idle)
    }

    func testMissingDiffIsNil() throws {
        let snap = try snapshot([thread(id: "z", state: "idle")])
        XCTAssertNil(snap.threads[0].diffAdded)
    }

    // MARK: - small formatters

    func testShortAge() {
        XCTAssertEqual(shortAge("just now"), "now")
        XCTAssertEqual(shortAge("10 minutes ago"), "10m")
        XCTAssertEqual(shortAge("3 hours ago"), "3h")
        XCTAssertEqual(shortAge("2 days ago"), "2d")
    }

    func testParseISODate() {
        XCTAssertNotNil(parseISODate("2026-06-23T09:19:51.214Z"))  // fractional seconds
        XCTAssertNotNil(parseISODate("2026-06-23T09:19:51Z"))      // without
        XCTAssertNil(parseISODate("not a date"))
    }

    // MARK: - the 5-min fresh-completion rule

    @MainActor
    func testFreshNeedsYouWindow() throws {
        let snap = try snapshot([
            thread(id: "fresh", state: "needs-you", stateSince: isoNow(-60)),    // 1 min ago
            thread(id: "stale", state: "needs-you", stateSince: isoNow(-600)),   // 10 min ago
            thread(id: "busy", state: "working", stateSince: isoNow(-60)),       // working, not needs-you
        ])
        let client = DaemonClient()
        client.groups = buildRail(snapshot: snap, triage: [:]).groups
        XCTAssertEqual(client.freshNeedsYou(window: 300).map(\.id), ["fresh"])
    }
}
