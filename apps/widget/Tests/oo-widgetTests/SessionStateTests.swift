// Unit tests for the widget's pure logic: grouping/sorting gateway session-state rows, lenient
// decode, optimistic local state, and the 5-min fresh-completion rule.

import Testing
import Foundation
@testable import oo_widget

@Suite("session-state")
struct SessionStateTests {

    private func row(
        id: String,
        repo: String = "repo",
        state: String = "idle",
        topic: String = "topic",
        generatedTopic: String? = nil,
        ownerTitle: String? = nil,
        nextSteps: String? = nil,
        priority: Int? = nil,
        lastMessageAt: String = "2026-01-01T00:00:00.000Z",
        stateSince: String = "2026-01-01T00:00:00.000Z",
        diffAdded: Int? = nil
    ) -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "source": "claude", "repo": repo, "app": "App", "topic": topic,
            "state": state, "lastActive": "now", "createdAt": "2026-01-01T00:00:00.000Z",
            "lastActiveAt": lastMessageAt, "lastMessageAt": lastMessageAt, "stateSince": stateSince,
        ]
        if let generatedTopic { d["generatedTopic"] = generatedTopic }
        if let ownerTitle { d["ownerTitle"] = ownerTitle }
        if let nextSteps { d["nextSteps"] = nextSteps }
        if let priority { d["priority"] = priority }
        if let diffAdded { d["diffAdded"] = diffAdded }
        return d
    }

    private func rows(_ rows: [[String: Any]]) throws -> [SessionStateRow] {
        let data = try JSONSerialization.data(withJSONObject: rows)
        return try JSONDecoder().decode([SessionStateRow].self, from: data)
    }

    private func isoNow(_ offset: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(offset))
    }

    @Test func loudestFirstWithinGroup() throws {
        let input = try rows([
            row(id: "i", state: "idle"),
            row(id: "n", state: "needs-you"),
            row(id: "w", state: "working"),
        ])
        let (groups, _) = buildSessionState(rows: input)
        #expect(groups.count == 1)
        #expect(groups[0].rows.map(\.id) == ["n", "w", "i"])
    }

    @Test func recencyTiebreak() throws {
        let input = try rows([
            row(id: "old", state: "needs-you", lastMessageAt: "2026-01-01T00:00:00.000Z"),
            row(id: "new", state: "needs-you", lastMessageAt: "2026-01-02T00:00:00.000Z"),
        ])
        let (groups, _) = buildSessionState(rows: input)
        #expect(groups[0].rows.map(\.id) == ["new", "old"])
    }

    @Test func groupsOrderedByLoudestRow() throws {
        let input = try rows([
            row(id: "a", repo: "alpha", state: "idle"),
            row(id: "b", repo: "beta", state: "needs-you"),
        ])
        let (groups, _) = buildSessionState(rows: input)
        #expect(groups.map(\.repo) == ["beta", "alpha"])
    }

    @Test func hiddenDroppedFromBodyButCountedDone() throws {
        let input = try rows([
            row(id: "x", state: "needs-you"),
            row(id: "y", state: "working"),
        ])
        let (groups, counts) = buildSessionState(rows: input, hidden: ["x"])
        let ids = groups.flatMap { $0.rows.map(\.id) }
        #expect(!ids.contains("x"))
        #expect(ids.contains("y"))
        #expect(counts[.needsYou] == 0)
        #expect(counts[.done] == 1)
        #expect(counts[.working] == 1)
    }

    @Test func doneExcludedFromBody() throws {
        let input = try rows([
            row(id: "d", state: "done"),
            row(id: "w", state: "working"),
        ])
        let (groups, counts) = buildSessionState(rows: input)
        #expect(groups.flatMap { $0.rows.map(\.id) } == ["w"])
        #expect(counts[.done] == 1)
    }

    @Test func enrichedRowFieldsRenderDirectly() throws {
        let input = try rows([row(id: "t", state: "needs-you", topic: "nice title", nextSteps: "do the thing", priority: 4)])
        let r = buildSessionState(rows: input).groups[0].rows[0]
        #expect(r.title == "nice title")
        #expect(r.nextSteps == "do the thing")
        #expect(r.priority == 4)
    }

    @Test func titleFallsBackToTopic() throws {
        let input = try rows([row(id: "t", state: "needs-you", topic: "raw topic")])
        #expect(buildSessionState(rows: input).groups[0].rows[0].title == "raw topic")
    }

    @Test func ownerTitleMarksRenamed() throws {
        let input = try rows([row(id: "t", topic: "my name", generatedTopic: "generated", ownerTitle: "my name")])
        let r = buildSessionState(rows: input).groups[0].rows[0]
        #expect(r.title == "my name")
        #expect(r.isRenamed)
    }

    @Test func pendingRenamePreviewsImmediately() throws {
        let input = try rows([row(id: "t", topic: "raw topic")])
        let r = buildSessionState(rows: input, renames: ["t": "typed just now"]).groups[0].rows[0]
        #expect(r.title == "typed just now")
        #expect(r.isRenamed)
    }

    @Test func pendingClearSkipsStaleOwnerTitle() throws {
        let input = try rows([row(id: "t", topic: "old rename", generatedTopic: "generated", ownerTitle: "old rename")])
        let r = buildSessionState(rows: input, renames: ["t": ""]).groups[0].rows[0]
        #expect(r.title == "generated")
        #expect(!r.isRenamed)
    }

    @Test func unknownStateBecomesIdle() throws {
        let input = try rows([row(id: "z", state: "totally-bogus")])
        #expect(input[0].state == .idle)
    }

    @Test func missingDiffIsNil() throws {
        let input = try rows([row(id: "z", state: "idle")])
        #expect(input[0].diffAdded == nil)
    }

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

    @Test @MainActor func freshNeedsYouWindow() throws {
        let input = try rows([
            row(id: "fresh", state: "needs-you", stateSince: isoNow(-60)),
            row(id: "stale", state: "needs-you", stateSince: isoNow(-600)),
            row(id: "busy", state: "working", stateSince: isoNow(-60)),
        ])
        let client = DaemonClient()
        client.groups = buildSessionState(rows: input).groups
        #expect(client.freshNeedsYou(window: 300).map(\.id) == ["fresh"])
    }
}
