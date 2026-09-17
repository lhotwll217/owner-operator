// Unit tests for the widget's Gateway contracts, refetch behavior, presentation order,
// session grouping, optimistic local state, and the 5-min fresh-completion rule.

import Testing
import Foundation
@testable import oo_widget

private actor StubWidgetGateway {
    private var sessionStateData: Data
    private var unavailable = false
    private var paths: [String] = []
    private var holdNextSessionState = false
    private var heldSessionState: CheckedContinuation<Data, Error>?

    init(sessionStateData: Data = Data("[]".utf8)) {
        self.sessionStateData = sessionStateData
    }

    func fetch(_ path: String) async throws -> Data {
        paths.append(path)
        if unavailable { throw URLError(.cannotConnectToHost) }
        switch path {
        case "/ready":
            return Data(#"{"setupRequired":false}"#.utf8)
        case "/session-state":
            if holdNextSessionState {
                holdNextSessionState = false
                return try await withCheckedThrowingContinuation { heldSessionState = $0 }
            }
            return sessionStateData
        default:
            throw URLError(.badURL)
        }
    }

    func setSessionState(_ data: Data) { sessionStateData = data }
    func setUnavailable(_ value: Bool) { unavailable = value }
    func requestCount(_ path: String) -> Int { paths.filter { $0 == path }.count }
    func holdNextSessionStateRequest() { holdNextSessionState = true }
    func hasHeldSessionStateRequest() -> Bool { heldSessionState != nil }
    func releaseHeldSessionState(with data: Data) {
        heldSessionState?.resume(returning: data)
        heldSessionState = nil
    }
}

@Suite("session-state")
struct SessionStateTests {

    @Test func customHarnessHomeDrivesDiscovery() {
        #expect(DaemonClient.harnessHome(environment: ["OO_HOME": "/tmp/custom-oo"]) == "/tmp/custom-oo")
    }

    private func row(
        id: String,
        repo: String = "repo",
        project: String? = nil,
        source: String = "claude",
        app: String = "App",
        state: String = "idle",
        topic: String = "topic",
        generatedTopic: String? = nil,
        ownerTitle: String? = nil,
        statusSummary: String? = nil,
        statusSummaryPending: Bool = false,
        priority: Int? = nil,
        parentThreadId: String? = nil,
        lastMessageAt: String = "2026-01-01T00:00:00.000Z",
        stateSince: String = "2026-01-01T00:00:00.000Z",
        diffAdded: Int? = nil
    ) -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "source": source, "repo": repo, "app": app, "topic": topic,
            "state": state, "lastActive": "now", "createdAt": "2026-01-01T00:00:00.000Z",
            "lastActiveAt": lastMessageAt, "lastMessageAt": lastMessageAt, "stateSince": stateSince,
        ]
        if let project { d["project"] = project }
        if let generatedTopic { d["generatedTopic"] = generatedTopic }
        if let ownerTitle { d["ownerTitle"] = ownerTitle }
        if let statusSummary { d["statusSummary"] = statusSummary }
        d["statusSummaryPending"] = statusSummaryPending
        if let priority { d["priority"] = priority }
        if let parentThreadId { d["parentThreadId"] = parentThreadId }
        if let diffAdded { d["diffAdded"] = diffAdded }
        return d
    }

    private func rows(_ rows: [[String: Any]]) throws -> [SessionStateRow] {
        let data = try JSONSerialization.data(withJSONObject: rows)
        return try JSONDecoder().decode([SessionStateRow].self, from: data)
    }

    @Test func oldAttentionWarningIsPresentationOnly() throws {
        let now = try #require(parseISODate("2026-01-04T00:00:00.000Z"));
        let input = try rows([
            row(id: "old", state: "needs-you", statusSummary: "Choose a policy"),
            row(id: "recent", state: "needs-you", lastMessageAt: "2026-01-01T00:00:01.000Z"),
            row(id: "working", state: "working"),
            row(id: "idle", state: "idle"),
            row(id: "invalid", state: "needs-you", lastMessageAt: "unknown"),
            row(id: "future", state: "needs-you", lastMessageAt: "2026-01-05T00:00:00.000Z"),
        ])
        #expect(input.map { $0.hasOldAttention(at: now) } == [true, false, false, false, false, false])
        #expect(input[0].state == .needsYou)
        #expect(input[0].statusSummary == "Choose a policy")
        #expect(input[0].title == "topic")
    }

    private func isoNow(_ offset: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(offset))
    }

    @Test func gatewayPayloadContract() throws {
        let payload = try Data(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/session-state.gateway.json"))
        let decoded = try JSONDecoder().decode([SessionStateRow].self, from: payload)
        #expect(decoded[0].id == "thread-1")
        #expect(decoded[0].title == "Daemon foundation")
        #expect(decoded[0].statusSummary == "Implement the state seam")
        #expect(decoded[0].priority == 4)
        #expect(decoded[0].state == .needsYou)
        #expect(decoded[0].repo == "owner-operator")
        #expect(decoded[0].project == "/worktrees/owner-operator/ticket-07")
        let fallback = try #require(rows([row(
            id: "thread-2", repo: "issue-132", project: "/tasks/issue-132", source: "pi", app: "Owner Operator"
        )]).first)
        #expect(fallback.repo == "issue-132")
        #expect(fallback.project == "/tasks/issue-132")
    }

    @Test @MainActor func agentRunInvalidationAndReconnectRefetchDurableTruth() async throws {
        let activeSessions = try JSONSerialization.data(withJSONObject: [
            row(id: "oo-root", repo: "issue-131", source: "pi", app: "Owner Operator", state: "working"),
            row(id: "child", repo: "issue-131", state: "working", parentThreadId: "oo-root"),
        ])
        let stub = StubWidgetGateway(sessionStateData: activeSessions)
        let client = DaemonClient(
            discover: { DaemonClient.Discovery(port: 47711, authToken: "test") },
            fetchData: { path, _ in try await stub.fetch(path) }
        )

        await client.refresh()
        #expect(client.groups.flatMap(\.rows).map(\.id) == ["oo-root", "child"])
        #expect(client.groups.flatMap(\.rows).map(\.nestingDepth) == [0, 1])
        #expect(client.groups.flatMap(\.rows).first?.state == .working)

        let terminalSessions = try JSONSerialization.data(withJSONObject: [
            row(id: "oo-root", repo: "issue-131", source: "pi", app: "Owner Operator", state: "needs-you"),
            row(id: "child", repo: "issue-131", state: "working", parentThreadId: "oo-root"),
        ])
        await stub.setSessionState(terminalSessions)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        #expect(client.groups.flatMap(\.rows).first?.state == .needsYou)
        #expect(client.groups.flatMap(\.rows).last?.nestingDepth == 1)
        #expect(await stub.requestCount("/agent-state") == 0)
        #expect(await stub.requestCount("/session-state") == 2)

        await stub.setUnavailable(true)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        #expect(!client.online)
        #expect(client.groups.isEmpty)

        await stub.setUnavailable(false)
        await client.refresh()
        #expect(client.online)
        #expect(client.groups.flatMap(\.rows).map(\.id) == ["oo-root", "child"])
        #expect(client.groups.flatMap(\.rows).first?.state == .needsYou)
    }

    @Test @MainActor func invalidationDuringRefetchRequiresAnotherDurableRead() async throws {
        let initial = try JSONSerialization.data(withJSONObject: [row(id: "root", state: "working")])
        let interrupted = try JSONSerialization.data(withJSONObject: [row(id: "root", state: "idle")])
        let completed = try JSONSerialization.data(withJSONObject: [row(id: "root", state: "needs-you")])
        let stub = StubWidgetGateway(sessionStateData: initial)
        let client = DaemonClient(
            discover: { DaemonClient.Discovery(port: 47711, authToken: "test") },
            fetchData: { path, _ in try await stub.fetch(path) }
        )
        await client.refresh()

        await stub.holdNextSessionStateRequest()
        let first = Task { await client.receive(WidgetGatewayEvent(kind: .agentRunChanged)) }
        for _ in 0..<100 where !(await stub.hasHeldSessionStateRequest()) { await Task.yield() }
        #expect(await stub.hasHeldSessionStateRequest())

        await stub.setSessionState(completed)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        await stub.releaseHeldSessionState(with: interrupted)
        await first.value

        #expect(client.groups.flatMap(\.rows).first?.state == .needsYou)
        #expect(await stub.requestCount("/session-state") == 3)
    }

    @Test func rowsKeepTheDaemonsOrderWhateverTheirState() throws {
        let input = try rows([
            row(id: "i", state: "idle"),
            row(id: "n", state: "needs-you", lastMessageAt: "2026-01-02T00:00:00.000Z"),
            row(id: "w", state: "working"),
        ])
        let (groups, _) = buildSessionState(rows: input)
        #expect(groups.count == 1)
        #expect(groups[0].rows.map(\.id) == ["i", "n", "w"])
    }

    @Test func groupsAreAlphabetical() throws {
        let input = try rows([
            row(id: "b", repo: "beta", state: "needs-you"),
            row(id: "a", repo: "alpha", state: "idle"),
        ])
        let (groups, _) = buildSessionState(rows: input)
        #expect(groups.map(\.repo) == ["alpha", "beta"])
    }

    @Test func delegatedChildrenNestImmediatelyAfterTheirParent() throws {
        let input = try rows([
            row(id: "other", repo: "repo", state: "needs-you"),
            row(id: "child", repo: "child-repo", state: "working", parentThreadId: "parent"),
            row(id: "parent", repo: "repo", state: "working"),
        ])
        let (groups, _) = buildSessionState(rows: input)
        #expect(groups.count == 1)
        #expect(groups[0].repo == "repo")
        #expect(groups[0].rows.map(\.id) == ["other", "parent", "child"])
        #expect(groups[0].rows.map(\.nestingDepth) == [0, 0, 1])
    }

    @Test func textRenderPreservesNestedChildrenAndThreadStates() throws {
        let input = try rows([
            row(id: "child", repo: "child-repo", state: "working", topic: "Child task", parentThreadId: "parent"),
            row(id: "parent", state: "needs-you", topic: "Parent task"),
            row(id: "idle", state: "idle", topic: "Idle task"),
        ])
        let rendered = renderText(rows: input, port: 47711)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        #expect(rendered == """
        Threads  3    ◐ 1  ● 1  ○ 1

        ▾ repo  3
          ◐ Parent task  now
            ● Child task  now
          ○ Idle task  now

        127.0.0.1:47711
        """)
    }

    @Test func ownerOperatorSessionRendersAsRoot() throws {
        let input = try rows([
            row(id: "oo-root", repo: "issue-131", source: "pi", app: "Owner Operator", state: "needs-you")
        ])
        let rendered = buildSessionState(rows: input).groups[0].rows[0]
        #expect(rendered.id == "oo-root")
        #expect(rendered.app == "Owner Operator")
        #expect(rendered.source == "pi")
        #expect(rendered.nestingDepth == 0)
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
        let input = try rows([row(id: "t", state: "needs-you", topic: "nice title", statusSummary: "do the thing", priority: 4)])
        let r = buildSessionState(rows: input).groups[0].rows[0]
        #expect(r.title == "nice title")
        #expect(r.statusSummary == "do the thing")
        #expect(r.priority == 4)
    }

    /// Every visible row shows its latest status summary, including a working one: the owner
    /// reads that row to see what is happening right now.
    @Test func everyVisibleRowShowsItsStatusSummary() throws {
        let input = try rows([
            row(id: "working", state: "working", topic: "Export test run", statusSummary: "Writing export tests."),
            row(id: "idle", state: "idle", statusSummary: "Export tests passed."),
            row(id: "decision", state: "needs-you", statusSummary: "Choose the retention policy."),
        ])
        let rendered = renderText(rows: input, port: 47711)
        #expect(rendered.contains("Writing export tests."))
        #expect(rendered.contains("Export test run"))
        #expect(input[0].displayStatusSummary == "Writing export tests.")
        #expect(rendered.contains("Export tests passed."))
        #expect(rendered.contains("Choose the retention policy."))
        #expect(input.map(\.state) == [.working, .idle, .needsYou])
    }

    /// The last status summary stays on screen while its replacement is generated, marked as
    /// pending rather than blanked or replaced by the opening prompt.
    @Test func pendingStatusSummaryKeepsTheLastOneWithAMark() throws {
        let input = try rows([row(id: "t", state: "idle", statusSummary: "Export tests passed.", statusSummaryPending: true)])
        let rendered = renderText(rows: input, port: 47711)
        #expect(input[0].statusSummaryPending)
        #expect(rendered.contains("Export tests passed. ·"))
    }

    /// A delegated child renders under its parent with its status summary folded away; the
    /// parent's own is open. The child's evidence is present either way.
    @Test func childStatusSummariesStartCollapsed() throws {
        let input = try rows([
            row(id: "parent", state: "idle", statusSummary: "Delegated the export work."),
            row(id: "child", state: "idle", statusSummary: "Export implemented and tested.", parentThreadId: "parent"),
        ])
        let rendered = buildSessionState(rows: input).groups[0].rows
        let parent = try #require(rendered.first { $0.id == "parent" })
        let child = try #require(rendered.first { $0.id == "child" })
        #expect(child.nestingDepth > 0)
        #expect(child.statusSummaryStartsCollapsed)
        #expect(!parent.statusSummaryStartsCollapsed)
        #expect(child.displayStatusSummary == "Export implemented and tested.")
    }

    /// A row with no generated status summary yet shows its title alone rather than prompt text.
    @Test func rowWithoutAStatusSummaryShowsOnlyItsTitle() throws {
        let input = try rows([row(id: "t", state: "idle", topic: "please have a look at the export thing")])
        #expect(input[0].displayStatusSummary == nil)
        #expect(input[0].title == "please have a look at the export thing")
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
