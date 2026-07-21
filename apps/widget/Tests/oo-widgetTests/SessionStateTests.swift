// Unit tests for the widget's Gateway contracts, refetch behavior, presentation order,
// session grouping, optimistic local state, and the 5-min fresh-completion rule.

import Testing
import Foundation
@testable import oo_widget

private actor StubWidgetGateway {
    private var agentStateData: Data
    private var sessionStateData: Data
    private var unavailable = false
    private var agentStateUnavailable = false
    private var paths: [String] = []
    private var holdNextAgentState = false
    private var heldAgentState: CheckedContinuation<Data, Error>?

    init(agentStateData: Data, sessionStateData: Data = Data("[]".utf8)) {
        self.agentStateData = agentStateData
        self.sessionStateData = sessionStateData
    }

    func fetch(_ path: String) async throws -> Data {
        paths.append(path)
        if unavailable { throw URLError(.cannotConnectToHost) }
        switch path {
        case "/ready":
            return Data(#"{"setupRequired":false}"#.utf8)
        case "/session-state":
            return sessionStateData
        case "/agent-state":
            if agentStateUnavailable { throw URLError(.badServerResponse) }
            if holdNextAgentState {
                holdNextAgentState = false
                return try await withCheckedThrowingContinuation { heldAgentState = $0 }
            }
            return agentStateData
        default:
            throw URLError(.badURL)
        }
    }

    func setAgentState(_ data: Data) { agentStateData = data }
    func setUnavailable(_ value: Bool) { unavailable = value }
    func setAgentStateUnavailable(_ value: Bool) { agentStateUnavailable = value }
    func requestCount(_ path: String) -> Int { paths.filter { $0 == path }.count }
    func holdNextAgentStateRequest() { holdNextAgentState = true }
    func hasHeldAgentStateRequest() -> Bool { heldAgentState != nil }
    func releaseHeldAgentState(with data: Data) {
        heldAgentState?.resume(returning: data)
        heldAgentState = nil
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
        state: String = "idle",
        topic: String = "topic",
        generatedTopic: String? = nil,
        ownerTitle: String? = nil,
        nextSteps: String? = nil,
        priority: Int? = nil,
        parentThreadId: String? = nil,
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
        if let parentThreadId { d["parentThreadId"] = parentThreadId }
        if let diffAdded { d["diffAdded"] = diffAdded }
        return d
    }

    private func rows(_ rows: [[String: Any]]) throws -> [SessionStateRow] {
        let data = try JSONSerialization.data(withJSONObject: rows)
        return try JSONDecoder().decode([SessionStateRow].self, from: data)
    }

    private func agentStateFixture() throws -> AgentStateView {
        let payload = try Data(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/agent-state.gateway.json"))
        return try JSONDecoder().decode(AgentStateView.self, from: payload)
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
        #expect(decoded[0].nextSteps == "Implement the state seam")
        #expect(decoded[0].priority == 4)
        #expect(decoded[0].state == .needsYou)
    }

    @Test func agentStateGatewayContractPreservesSharedVocabularyAndOrder() throws {
        let decoded = try agentStateFixture()

        #expect(decoded.footer == "Agent state: 1 queued · 1 running · 3 need attention")
        #expect(decoded.runs.map(\.status.text) == [
            .failed, .interrupted, .lost, .running, .queued, .completed, .cancelled,
        ])
        #expect(decoded.runs.map(\.category) == [
            .attention, .attention, .attention, .active, .active, .recent, .recent,
        ])
        #expect(decoded.runs.map(\.canResume) == [true, true, true, false, false, false, false])
        #expect(decoded.runs[3].status.glyph == "●")
    }

    @Test func agentStateMockRendersTimelineRailVocabularyAndOrder() throws {
        let rendered = renderText(rows: [], agentState: try agentStateFixture(), port: 47711)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        #expect(rendered.contains("! failed  Investigate startup"))
        #expect(rendered.contains("! interrupted  Continue migration"))
        #expect(rendered.contains("· resumable"))
        #expect(rendered.contains("■ cancelled  Superseded audit"))
        let failed = try #require(rendered.range(of: "Investigate startup"))
        let running = try #require(rendered.range(of: "Research widget behavior"))
        let completed = try #require(rendered.range(of: "Map the Gateway seam"))
        #expect(failed.lowerBound < running.lowerBound && running.lowerBound < completed.lowerBound)
    }

    @Test func unknownAgentStatusAndCategoryStillRender() throws {
        let payload = Data("""
        {"counts":{"queued":0,"running":1,"attention":0},"footer":"Agent state: 1 running","runs":[{"id":"run-1","harness":"codex","task":"Future lifecycle","status":{"glyph":"◆","text":"paused"},"category":"future","elapsedMs":1000,"latestActivity":"waiting","canCancel":false,"canResume":false}]}
        """.utf8)

        let decoded = try JSONDecoder().decode(AgentStateView.self, from: payload)
        let rendered = renderText(rows: [], agentState: decoded, port: 47711)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)

        #expect(rendered.contains("◆ unknown  Future lifecycle"))
    }

    @Test @MainActor func agentStateFailureLeavesSessionsOnlineWithEmptyAgentState() async throws {
        let sessionData = try JSONSerialization.data(withJSONObject: [row(id: "thread-1", state: "needs-you")])
        let stub = StubWidgetGateway(agentStateData: Data("{}".utf8), sessionStateData: sessionData)
        await stub.setAgentStateUnavailable(true)
        let client = DaemonClient(
            discover: { DaemonClient.Discovery(port: 47711, authToken: "test") },
            fetchData: { path, _ in try await stub.fetch(path) }
        )

        await client.refresh()

        #expect(client.online)
        #expect(client.groups.flatMap(\.rows).map(\.id) == ["thread-1"])
        #expect(client.agentState.runs.isEmpty)
    }

    @Test @MainActor func agentRunInvalidationAndReconnectRefetchDurableTruth() async throws {
        func view(status: String, glyph: String, category: String, footer: String?) -> Data {
            let footerJSON = footer.map { "\"\($0)\"" } ?? "null"
            return Data("""
            {
              "counts":{"queued":0,"running":\(status == "running" ? 1 : 0),"attention":\(category == "attention" ? 1 : 0)},
              "footer":\(footerJSON),
              "runs":[{"id":"run-1","harness":"codex","task":"Audit state","status":{"glyph":"\(glyph)","text":"\(status)"},"category":"\(category)","elapsedMs":1000,"latestActivity":"bounded","canCancel":\(status == "running"),"canResume":\(status == "interrupted")}]
            }
            """.utf8)
        }

        let stub = StubWidgetGateway(agentStateData: view(
            status: "running", glyph: "●", category: "active", footer: "Agent state: 1 running"
        ))
        let client = DaemonClient(
            discover: { DaemonClient.Discovery(port: 47711, authToken: "test") },
            fetchData: { path, _ in try await stub.fetch(path) }
        )

        await client.refresh()
        #expect(client.agentState.runs[0].status.text == .running)

        await stub.setAgentState(view(
            status: "interrupted", glyph: "!", category: "attention", footer: "Agent state: 1 needs attention"
        ))
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        #expect(client.agentState.runs[0].status.text == .interrupted)
        #expect(client.agentState.runs[0].canResume)
        #expect(await stub.requestCount("/agent-state") == 2)

        await stub.setUnavailable(true)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        #expect(!client.online)
        #expect(client.agentState.runs.isEmpty, "a dropped daemon cannot leave a stale running indicator")

        await stub.setUnavailable(false)
        await stub.setAgentState(view(status: "completed", glyph: "✓", category: "recent", footer: nil))
        await client.refresh()
        #expect(client.online)
        #expect(client.agentState.runs[0].status.text == .completed)
        #expect(client.agentState.footer == nil)
    }

    @Test @MainActor func invalidationDuringRefetchRequiresAnotherDurableRead() async throws {
        func view(_ status: String, _ glyph: String, _ category: String) -> Data {
            Data("""
            {"counts":{"queued":0,"running":0,"attention":0},"footer":null,"runs":[{"id":"run-1","harness":"codex","task":"Audit state","status":{"glyph":"\(glyph)","text":"\(status)"},"category":"\(category)","elapsedMs":1000,"latestActivity":"","canCancel":false,"canResume":false}]}
            """.utf8)
        }

        let initial = view("running", "●", "active")
        let interrupted = view("interrupted", "!", "attention")
        let completed = view("completed", "✓", "recent")
        let stub = StubWidgetGateway(agentStateData: initial)
        let client = DaemonClient(
            discover: { DaemonClient.Discovery(port: 47711, authToken: "test") },
            fetchData: { path, _ in try await stub.fetch(path) }
        )
        await client.refresh()

        await stub.holdNextAgentStateRequest()
        let first = Task { await client.receive(WidgetGatewayEvent(kind: .agentRunChanged)) }
        for _ in 0..<100 where !(await stub.hasHeldAgentStateRequest()) { await Task.yield() }
        #expect(await stub.hasHeldAgentStateRequest())

        await stub.setAgentState(completed)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        await stub.releaseHeldAgentState(with: interrupted)
        await first.value

        #expect(client.agentState.runs[0].status.text == .completed)
        #expect(await stub.requestCount("/agent-state") == 3)
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

    @Test func delegatedChildrenNestImmediatelyAfterTheirParent() throws {
        let input = try rows([
            row(id: "other", repo: "repo", state: "needs-you"),
            row(id: "child", repo: "child-repo", state: "working", parentThreadId: "parent"),
            row(id: "parent", repo: "repo", state: "idle"),
        ])
        let (groups, _) = buildSessionState(rows: input)
        #expect(groups.count == 1)
        #expect(groups[0].repo == "repo")
        #expect(groups[0].rows.map(\.id) == ["other", "parent", "child"])
        #expect(groups[0].rows.map(\.nestingDepth) == [0, 0, 1])
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

    @Test(arguments: [
        (3000, "3s"), (62000, "1m"), (3660000, "1h 1m"),
    ])
    func shortDurationCompacts(_ c: (milliseconds: Int, expected: String)) {
        #expect(shortDuration(milliseconds: c.milliseconds) == c.expected)
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
