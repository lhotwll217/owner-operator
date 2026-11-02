// Unit tests for the widget's Gateway contracts, refetch behavior, the section split over the
// daemon's order, optimistic owner writes, snooze presets, and the 5-min fresh-completion rule.

import Testing
import Foundation
@testable import oo_widget

private actor StubWidgetGateway {
    private var sessionStateData: Data
    private var unavailable = false
    private var paths: [String] = []
    private var holdNextSessionState = false
    private var heldSessionState: CheckedContinuation<Data, Error>?
    private(set) var posts: [(path: String, body: [String: Any])] = []
    private var failPosts = false
    private var afterPost: Data?

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

    func post(_ path: String, _ body: Data) throws {
        posts.append((path, (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]))
        if failPosts { throw URLError(.badServerResponse) }
        if let afterPost { sessionStateData = afterPost }
    }

    func setSessionState(_ data: Data) { sessionStateData = data }
    func setAfterPost(_ data: Data) { afterPost = data }
    func setFailPosts(_ value: Bool) { failPosts = value }
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
        section: String? = nil,
        depth: Int = 0,
        snooze: [String: Any]? = nil,
        link: String? = nil,
        topic: String = "topic",
        generatedTopic: String? = nil,
        ownerTitle: String? = nil,
        statusSummary: String? = nil,
        parentThreadId: String? = nil,
        lastMessageAt: String = "2026-01-01T00:00:00.000Z",
        stateSince: String = "2026-01-01T00:00:00.000Z",
        diffAdded: Int? = nil
    ) -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "source": source, "repo": repo, "app": app, "topic": topic,
            "state": state, "section": section ?? (snooze == nil ? state : "snoozed"), "depth": depth,
            "lastActive": "now", "createdAt": "2026-01-01T00:00:00.000Z",
            "lastActiveAt": lastMessageAt, "lastMessageAt": lastMessageAt, "stateSince": stateSince,
        ]
        if let project { d["project"] = project }
        if let snooze { d["snooze"] = snooze }
        if let link { d["link"] = link }
        if let generatedTopic { d["generatedTopic"] = generatedTopic }
        if let ownerTitle { d["ownerTitle"] = ownerTitle }
        if let statusSummary { d["statusSummary"] = statusSummary }
        if let parentThreadId { d["parentThreadId"] = parentThreadId }
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

    private func ids(_ snapshot: WidgetSnapshot, _ kind: SessionSection) -> [String] {
        snapshot.section(kind).rows.map(\.id)
    }

    @MainActor private func client(_ stub: StubWidgetGateway) -> DaemonClient {
        DaemonClient(
            discover: { DaemonClient.Discovery(port: 47711, authToken: "test") },
            fetchData: { path, _ in try await stub.fetch(path) },
            postData: { path, body, _ in try await stub.post(path, body) }
        )
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
        #expect(decoded[0].state == .needsYou)
        #expect(decoded[0].section == .needsYou)
        #expect(decoded[0].depth == 0)
        #expect(decoded[0].snooze == nil)
        #expect(decoded[0].link == nil)
        #expect(decoded[0].repo == "owner-operator")
        #expect(decoded[0].project == "/worktrees/owner-operator/ticket-07")
        let fallback = try #require(rows([row(
            id: "thread-2", repo: "issue-132", project: "/tasks/issue-132", source: "pi", app: "Owner Operator"
        )]).first)
        #expect(fallback.repo == "issue-132")
        #expect(fallback.project == "/tasks/issue-132")
    }

    @Test func newFieldsDecodeLeniently() throws {
        var unknown = row(id: "unknown", state: "working", section: "elsewhere", link: "not a url")
        unknown["depth"] = "deep"
        unknown["snooze"] = ["kind": "until", "until": "whenever"]
        let decoded = try rows([
            unknown,
            row(id: "timed", snooze: ["kind": "until", "until": "2026-01-02T09:00:00.000Z"], link: "claude://claude.ai/epitaxy/local_x"),
            row(id: "next", snooze: ["kind": "next-message"], link: "codex://threads/next"),
            row(id: "bogus", snooze: ["kind": "forever"]),
        ])
        #expect(decoded[0].section == .idle)
        #expect(decoded[0].depth == 0)
        #expect(decoded[0].snooze == nil)
        #expect(decoded[0].link == nil)
        #expect(decoded[1].snooze == .until(try #require(parseISODate("2026-01-02T09:00:00.000Z"))))
        #expect(decoded[1].link?.absoluteString == "claude://claude.ai/epitaxy/local_x")
        #expect(decoded[2].snooze == .nextMessage)
        #expect(decoded[2].link?.scheme == "codex")
        #expect(decoded[3].snooze == nil)
    }

    @Test @MainActor func agentRunInvalidationAndReconnectRefetchDurableTruth() async throws {
        let activeSessions = try JSONSerialization.data(withJSONObject: [
            row(id: "oo-root", repo: "issue-131", source: "pi", app: "Owner Operator", state: "working"),
            row(id: "child", repo: "issue-131", state: "working", depth: 1, parentThreadId: "oo-root"),
        ])
        let stub = StubWidgetGateway(sessionStateData: activeSessions)
        let client = client(stub)

        await client.refresh()
        #expect(client.snapshot.rows.map(\.id) == ["oo-root", "child"])
        #expect(client.snapshot.rows.map(\.depth) == [0, 1])
        #expect(client.snapshot.rows.first?.state == .working)

        let terminalSessions = try JSONSerialization.data(withJSONObject: [
            row(id: "oo-root", repo: "issue-131", source: "pi", app: "Owner Operator", state: "needs-you"),
            row(id: "child", repo: "issue-131", state: "working", section: "needs-you", depth: 1, parentThreadId: "oo-root"),
        ])
        await stub.setSessionState(terminalSessions)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        #expect(ids(client.snapshot, .needsYou) == ["oo-root", "child"])
        #expect(client.snapshot.rows.last?.depth == 1)
        #expect(await stub.requestCount("/agent-state") == 0)
        #expect(await stub.requestCount("/session-state") == 2)

        await stub.setUnavailable(true)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        #expect(!client.online)
        #expect(client.snapshot.rows.isEmpty)

        await stub.setUnavailable(false)
        await client.refresh()
        #expect(client.online)
        #expect(client.snapshot.rows.map(\.id) == ["oo-root", "child"])
        #expect(client.snapshot.rows.first?.state == .needsYou)
    }

    @Test @MainActor func invalidationDuringRefetchRequiresAnotherDurableRead() async throws {
        let initial = try JSONSerialization.data(withJSONObject: [row(id: "root", state: "working")])
        let interrupted = try JSONSerialization.data(withJSONObject: [row(id: "root", state: "idle")])
        let completed = try JSONSerialization.data(withJSONObject: [row(id: "root", state: "needs-you")])
        let stub = StubWidgetGateway(sessionStateData: initial)
        let client = client(stub)
        await client.refresh()

        await stub.holdNextSessionStateRequest()
        let first = Task { await client.receive(WidgetGatewayEvent(kind: .agentRunChanged)) }
        for _ in 0..<100 where !(await stub.hasHeldSessionStateRequest()) { await Task.yield() }
        #expect(await stub.hasHeldSessionStateRequest())

        await stub.setSessionState(completed)
        await client.receive(WidgetGatewayEvent(kind: .agentRunChanged))
        await stub.releaseHeldSessionState(with: interrupted)
        await first.value

        #expect(client.snapshot.rows.first?.state == .needsYou)
        #expect(await stub.requestCount("/session-state") == 3)
    }

    /// The snapshot splits the daemon's rows on `section` and never re-sorts within one.
    @Test func rowsKeepTheDaemonsOrderWithinEachSection() throws {
        let input = try rows([
            row(id: "n2", state: "needs-you"),
            row(id: "n1", state: "needs-you"),
            row(id: "w", state: "working"),
            row(id: "i", state: "idle"),
            row(id: "s", state: "needs-you", snooze: ["kind": "next-message"]),
        ])
        let snapshot = buildSnapshot(rows: input)
        #expect(snapshot.sections.map(\.kind) == [.needsYou, .working, .idle, .snoozed])
        #expect(ids(snapshot, .needsYou) == ["n2", "n1"])
        #expect(ids(snapshot, .working) == ["w"])
        #expect(ids(snapshot, .idle) == ["i"])
        #expect(ids(snapshot, .snoozed) == ["s"])
        #expect(snapshot.count(.needsYou) == 2)
    }

    /// A child renders at its wire depth in its parent's section, whatever its own state.
    @Test func delegatedChildrenRenderAtTheirWireDepthInTheirParentsSection() throws {
        let input = try rows([
            row(id: "parent", state: "working"),
            row(id: "child", repo: "child-repo", state: "idle", section: "working", depth: 1, parentThreadId: "parent"),
            row(id: "grandchild", state: "needs-you", section: "working", depth: 2, parentThreadId: "child"),
            row(id: "other", state: "working"),
        ])
        let working = buildSnapshot(rows: input).section(.working)
        #expect(working.rows.map(\.id) == ["parent", "child", "grandchild", "other"])
        #expect(working.rows.map(\.depth) == [0, 1, 2, 0])
        #expect(working.count == 2, "a section counts its roots")
    }

    @Test func textRenderPrintsSectionsInWireOrderWithDepth() throws {
        let input = try rows([
            row(id: "parent", state: "needs-you", topic: "Parent task", statusSummary: "Pick a policy"),
            row(id: "child", repo: "child-repo", state: "working", section: "needs-you", depth: 1, topic: "Child task", parentThreadId: "parent"),
            row(id: "idle", state: "idle", topic: "Idle task"),
            row(id: "snoozed", state: "idle", snooze: ["kind": "next-message"], topic: "Snoozed task"),
        ])
        let rendered = renderText(rows: input, port: 47711)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        #expect(rendered == """
        Needs you  1
          Parent task  now
            repo  Pick a policy
            Child task  now

        Idle  1
          Idle task  now
            repo

        Snoozed  1
          Snoozed task  until next message
            repo

        127.0.0.1:47711
        """)
        let empty = renderText(rows: [], port: 47711)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        #expect(empty.hasPrefix("Needs you  0\n  Nothing needs you\n"))
    }

    @Test func ownerOperatorSessionRendersAsRoot() throws {
        let input = try rows([
            row(id: "oo-root", repo: "issue-131", source: "pi", app: "Owner Operator", state: "needs-you")
        ])
        let rendered = try #require(buildSnapshot(rows: input).section(.needsYou).rows.first)
        #expect(rendered.id == "oo-root")
        #expect(rendered.app == "Owner Operator")
        #expect(rendered.source == "pi")
        #expect(rendered.depth == 0)
    }

    /// A row with an owner write in flight leaves the panel with its subtree and its count.
    @Test func hiddenRowDropsWithItsSubtreeAndLeavesTheCount() throws {
        let input = try rows([
            row(id: "x", state: "needs-you"),
            row(id: "x-child", state: "working", section: "needs-you", depth: 1, parentThreadId: "x"),
            row(id: "x-grandchild", state: "working", section: "needs-you", depth: 2, parentThreadId: "x-child"),
            row(id: "z", state: "needs-you"),
            row(id: "y", state: "working"),
        ])
        let snapshot = buildSnapshot(rows: input, hidden: ["x"])
        #expect(snapshot.rows.map(\.id) == ["z", "y"])
        #expect(snapshot.count(.needsYou) == 1)
        #expect(snapshot.count(.working) == 1)
    }

    @Test @MainActor func ownerWriteHidesTheRowThenTheDaemonPlacesIt() async throws {
        let before = try JSONSerialization.data(withJSONObject: [row(id: "t", state: "needs-you")])
        let snoozed = try JSONSerialization.data(withJSONObject: [
            row(id: "t", state: "needs-you", snooze: ["kind": "until", "until": "2026-01-02T09:00:00.000Z"]),
        ])
        let stub = StubWidgetGateway(sessionStateData: before)
        let client = client(stub)
        await client.refresh()
        await stub.setAfterPost(snoozed)
        let wake = try #require(parseISODate("2026-01-02T09:00:00.000Z"))
        await client.write("t", "/snooze", ["id": "t", "snooze": ["kind": "until", "until": isoString(wake)]])
        #expect(ids(client.snapshot, .needsYou) == [])
        #expect(ids(client.snapshot, .snoozed) == ["t"])
        let post = try #require(await stub.posts.first)
        #expect(post.path == "/snooze")
        #expect((post.body["snooze"] as? [String: Any])?["until"] as? String == "2026-01-02T09:00:00.000Z")
    }

    /// A newer message can wake the row before the write's refetch lands; the client keeps no
    /// record of what it asked for, so the woken row shows where the daemon put it.
    @Test @MainActor func aNewerMessageWakeBeforeTheRefetchIsNotKeptHidden() async throws {
        let before = try JSONSerialization.data(withJSONObject: [row(id: "t", state: "idle")])
        let woken = try JSONSerialization.data(withJSONObject: [row(id: "t", state: "needs-you", lastMessageAt: "2026-01-01T00:05:00.000Z")])
        let stub = StubWidgetGateway(sessionStateData: before)
        let client = client(stub)
        await client.refresh()
        await stub.setAfterPost(woken)
        await client.write("t", "/snooze", ["id": "t", "snooze": ["kind": "next-message"]])
        #expect(ids(client.snapshot, .needsYou) == ["t"])
    }

    @Test @MainActor func aFailedWriteShowsTheRowWhereItWas() async throws {
        let stub = StubWidgetGateway(sessionStateData: try JSONSerialization.data(withJSONObject: [row(id: "t", state: "needs-you")]))
        let client = client(stub)
        await client.refresh()
        await stub.setFailPosts(true)
        await client.write("t", "/done", ["ids": ["t"]])
        #expect(ids(client.snapshot, .needsYou) == ["t"])
    }

    @Test func enrichedRowFieldsRenderDirectly() throws {
        let input = try rows([row(id: "t", state: "needs-you", topic: "nice title", statusSummary: "do the thing")])
        let r = try #require(buildSnapshot(rows: input).rows.first)
        #expect(r.title == "nice title")
        #expect(r.statusSummary == "do the thing")
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

    /// The last status summary stays on screen while its replacement is generated, with no mark.
    @Test func lastStatusSummaryStaysWithoutAPendingMark() throws {
        var pending = row(id: "t", state: "idle", statusSummary: "Export tests passed.")
        pending["statusSummaryPending"] = true
        let rendered = renderText(rows: try rows([pending]), port: 47711)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        #expect(rendered.contains("repo  Export tests passed.\n"))
    }

    /// A delegated child's status summary is folded away; the parent's own is open.
    @Test func childStatusSummariesStartCollapsed() throws {
        let input = try rows([
            row(id: "parent", state: "idle", statusSummary: "Delegated the export work."),
            row(id: "child", state: "idle", depth: 1, statusSummary: "Export implemented and tested.", parentThreadId: "parent"),
        ])
        let rendered = buildSnapshot(rows: input).rows
        let parent = try #require(rendered.first { $0.id == "parent" })
        let child = try #require(rendered.first { $0.id == "child" })
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
        #expect(buildSnapshot(rows: input).rows.first?.title == "raw topic")
    }

    @Test func ownerTitleMarksRenamed() throws {
        let input = try rows([row(id: "t", topic: "my name", generatedTopic: "generated", ownerTitle: "my name")])
        let r = try #require(buildSnapshot(rows: input).rows.first)
        #expect(r.title == "my name")
        #expect(r.isRenamed)
    }

    @Test func pendingRenamePreviewsImmediately() throws {
        let input = try rows([row(id: "t", topic: "raw topic")])
        let r = try #require(buildSnapshot(rows: input, renames: ["t": "typed just now"]).rows.first)
        #expect(r.title == "typed just now")
        #expect(r.isRenamed)
    }

    @Test func pendingClearSkipsStaleOwnerTitle() throws {
        let input = try rows([row(id: "t", topic: "old rename", generatedTopic: "generated", ownerTitle: "old rename")])
        let r = try #require(buildSnapshot(rows: input, renames: ["t": ""]).rows.first)
        #expect(r.title == "generated")
        #expect(!r.isRenamed)
    }

    @Test func unknownStateBecomesIdle() throws {
        let input = try rows([row(id: "z", state: "totally-bogus", section: "idle")])
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
            row(id: "snoozed", state: "needs-you", snooze: ["kind": "next-message"], stateSince: isoNow(-60)),
        ])
        let client = DaemonClient()
        client.snapshot = buildSnapshot(rows: input)
        #expect(client.freshNeedsYou(window: 300).map(\.id) == ["fresh"])
        #expect(client.needsYou == 2, "a snoozed needs-you row is not counted as needing the owner")
    }

    private func calendar(_ zone: String) throws -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: zone))
        return calendar
    }

    private func local(_ calendar: Calendar, _ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) throws -> Date {
        try #require(calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min)))
    }

    @Test func snoozePresetsResolveInTheOwnersCalendar() throws {
        let cal = try calendar("Europe/Helsinki")
        let beforeSix = try local(cal, 2026, 11, 2, 17, 59)
        #expect(SnoozePreset.available(at: beforeSix, calendar: cal) == [.twoHours, .thisEvening, .tomorrowMorning, .nextMessage])
        #expect(SnoozePreset.thisEvening.wake(from: beforeSix, calendar: cal) == (try local(cal, 2026, 11, 2, 18, 0)))
        #expect(SnoozePreset.twoHours.wake(from: beforeSix, calendar: cal) == beforeSix.addingTimeInterval(7200))
        #expect(SnoozePreset.tomorrowMorning.wake(from: beforeSix, calendar: cal) == (try local(cal, 2026, 11, 3, 9, 0)))
        #expect(SnoozePreset.nextMessage.wake(from: beforeSix, calendar: cal) == nil)

        let atSix = try local(cal, 2026, 11, 2, 18, 0)
        #expect(SnoozePreset.available(at: atSix, calendar: cal) == [.twoHours, .tomorrowMorning, .nextMessage])

        let lateNight = try local(cal, 2026, 11, 2, 23, 30)
        #expect(SnoozePreset.tomorrowMorning.wake(from: lateNight, calendar: cal) == (try local(cal, 2026, 11, 3, 9, 0)))
    }

    /// Helsinki moves its clocks forward at 03:00 on 2026-03-29: "tomorrow 9:00" is still 09:00
    /// local, and "2 hours" is still two elapsed hours.
    @Test func snoozePresetsHoldAcrossADaylightSavingChange() throws {
        let cal = try calendar("Europe/Helsinki")
        let evening = try local(cal, 2026, 3, 28, 20, 0)
        let tomorrow = try #require(SnoozePreset.tomorrowMorning.wake(from: evening, calendar: cal))
        #expect(cal.component(.hour, from: tomorrow) == 9)
        #expect(cal.component(.day, from: tomorrow) == 29)
        #expect(isoString(tomorrow) == "2026-03-29T06:00:00.000Z")
        let beforeJump = try local(cal, 2026, 3, 29, 2, 30)
        let twoHours = try #require(SnoozePreset.twoHours.wake(from: beforeJump, calendar: cal))
        #expect(twoHours.timeIntervalSince(beforeJump) == 7200)
        #expect(cal.component(.hour, from: twoHours) == 5)
    }

    @Test func snoozeLabelReadsAsTheMock() throws {
        let cal = try calendar("Europe/Helsinki")
        let now = try local(cal, 2026, 11, 2, 10, 0)
        #expect(snoozeLabel(.nextMessage, now: now, calendar: cal) == "next message")
        #expect(snoozeLabel(.until(try local(cal, 2026, 11, 2, 18, 0)), now: now, calendar: cal) == "18:00")
        #expect(snoozeLabel(.until(try local(cal, 2026, 11, 3, 9, 0)), now: now, calendar: cal) == "Tomorrow 9:00")
    }
}
