// The widget's seam to the daemon — a THIN CLIENT (OpenClaw gateway pattern): it discovers the
// live port, GETs the session projection, and subscribes to the SSE /events stream
// so changes land instantly. The poll is the heartbeat (covers SSE gaps + offline→online); the SSE
// frame is just a "refetch now" nudge, so the GET path stays the single source of shape.

import AppKit
import Combine
import Foundation

@MainActor
final class DaemonClient: ObservableObject {
    static let shared = DaemonClient()

    typealias DiscoverGateway = @Sendable () -> Discovery?
    typealias FetchData = @Sendable (_ path: String, _ discovery: Discovery) async throws -> Data
    typealias PostData = @Sendable (_ path: String, _ body: Data, _ discovery: Discovery) async throws -> Void

    private let discover: DiscoverGateway
    private let fetchData: FetchData
    private let postData: PostData

    nonisolated init(
        discover: @escaping DiscoverGateway = { DaemonClient.discoverGateway() },
        fetchData: @escaping FetchData = { path, discovery in
            try await DaemonClient.data(path, discovery: discovery)
        },
        postData: @escaping PostData = { path, body, discovery in
            try await DaemonClient.post(path, body: body, discovery: discovery)
        }
    ) {
        self.discover = discover
        self.fetchData = fetchData
        self.postData = postData
    }

    @Published var snapshot = WidgetSnapshot()
    @Published var online = false
    @Published var setupRequired = false
    @Published var port = defaultPort

    nonisolated static let defaultPort = 47711

    nonisolated static func harnessHome(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let configured = environment["OO_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines), !configured.isEmpty {
            return configured
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".owner-operator")
    }

    private var pollTimer: Timer?
    private var sseTask: Task<Void, Never>?
    private var started = false
    private var refreshInFlight = false
    private var refreshDirty = false
    private var refreshWaiters: [CheckedContinuation<Void, Never>] = []

    // The last payload the daemon gave us (the truth we render), plus the rows hidden while an
    // owner write (done, snooze, wake) is in flight, counted per id so overlapping writes nest.
    private var lastRows: [SessionStateRow] = []
    private var pendingWrites: [String: Int] = [:]
    private var pendingRenames: [String: String] = [:]

    var needsYou: Int { snapshot.count(.needsYou) }
    var working: Int { snapshot.count(.working) }

    /// Threads whose turn JUST completed — in the needs-you section and entered needs-you within
    /// `window` seconds. Most-recently-finished first. The set the collapsed HUD softly pulses
    /// through; a snoozed row is never in it.
    func freshNeedsYou(window: TimeInterval = 300) -> [SessionStateRow] {
        let now = Date()
        return snapshot.section(.needsYou).rows
            .filter { $0.state == .needsYou }
            .filter {
                guard let since = parseISODate($0.stateSince) else { return false }
                let age = now.timeIntervalSince(since)
                return age >= 0 && age <= window
            }
            .sorted { $0.stateSince > $1.stateSince }
    }

    func start() {
        guard !started else { return }
        started = true
        Task { await refresh() }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        startSSE()
    }

    nonisolated struct Discovery: Sendable {
        let port: Int
        let authToken: String
    }

    nonisolated struct Readiness: Decodable {
        let setupRequired: Bool
    }

    /// <OO_HOME>/daemon.json → the authenticated local Gateway discovery record.
    nonisolated static func discoverGateway() -> Discovery? {
        let path = (harnessHome() as NSString).appendingPathComponent("daemon.json")
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = obj["port"] as? Int,
              let authToken = obj["authToken"] as? String,
              !authToken.isEmpty else { return nil }
        return Discovery(port: port, authToken: authToken)
    }

    nonisolated static func discoverPort() -> Int {
        discoverGateway()?.port ?? defaultPort
    }

    func refresh() async {
        if refreshInFlight {
            refreshDirty = true
            return
        }
        refreshInFlight = true
        repeat {
            refreshDirty = false
            await refreshOnce()
        } while refreshDirty
        refreshInFlight = false
        let waiters = refreshWaiters
        refreshWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    /// A refetch that reads after this call, even when a read is already in flight: an owner
    /// write must not un-hide its row on a payload fetched before the write landed.
    private func refetch() async {
        guard refreshInFlight else { return await refresh() }
        refreshDirty = true
        await withCheckedContinuation { refreshWaiters.append($0) }
    }

    private func refreshOnce() async {
        guard let discovery = discover() else {
            clearDisconnectedState()
            return
        }
        do {
            let readiness = try decode(Readiness.self, from: await fetchData("/ready", discovery))
            let rows = try decode([SessionStateRow].self, from: await fetchData("/session-state", discovery))
            lastRows = rows
            port = discovery.port
            setupRequired = readiness.setupRequired
            online = true
            rebuild()
        } catch {
            clearDisconnectedState()
            return
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }

    private func clearDisconnectedState() {
        online = false
        setupRequired = false
        lastRows = []
        rebuild()
    }

    /// Agent-run events also invalidate the session projection's parent state.
    func receive(_ event: WidgetGatewayEvent) async {
        switch event.kind {
        case .stateChanged, .agentRunChanged:
            await refresh()
        }
    }

    /// Open the thread in its own app; a row without a verified link is inert.
    func open(_ row: SessionStateRow) {
        guard let link = row.link else { return }
        NSWorkspace.shared.open(link)
    }

    func markDone(_ id: String) {
        hideThenWrite(id, "/done", ["ids": [id]])
    }

    /// Snooze until `wake`, or until the next message when nil.
    func snooze(_ id: String, until wake: Date?) {
        let snooze: [String: Any] = wake.map { ["kind": "until", "until": isoString($0)] } ?? ["kind": "next-message"]
        hideThenWrite(id, "/snooze", ["id": id, "snooze": snooze])
    }

    func wake(_ id: String) {
        hideThenWrite(id, "/snooze", ["id": id, "snooze": NSNull()])
    }

    /// Done, snooze, and wake share one mechanism: hide the row and its subtree while the request
    /// runs, then refetch and let the daemon place it — gone, snoozed, woken, or where it was if
    /// the write failed. Nothing is moved or matched on the client.
    func write(_ id: String, _ path: String, _ body: [String: Any]) async {
        hide(id)
        await send(id, path, body)
    }

    /// The hide happens synchronously so a caller's animation covers it.
    private func hideThenWrite(_ id: String, _ path: String, _ body: [String: Any]) {
        hide(id)
        Task { await send(id, path, body) }
    }

    private func hide(_ id: String) {
        pendingWrites[id, default: 0] += 1
        rebuild()
    }

    private func send(_ id: String, _ path: String, _ body: [String: Any]) async {
        if let discovery = discover(), let data = try? JSONSerialization.data(withJSONObject: body) {
            try? await postData(path, data, discovery)
        }
        await refetch()
        pendingWrites[id, default: 1] -= 1
        if pendingWrites[id] == 0 { pendingWrites.removeValue(forKey: id) }
        rebuild()
    }

    /// Rename a thread: show the new title immediately (optimistic), then tell the daemon. An
    /// empty title clears the rename — the AI resumes titling. A failed POST reverts the preview.
    func rename(_ id: String, to title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        pendingRenames[id] = trimmed
        rebuild()
        Task { await postRename(id, to: trimmed) }
    }

    private func postRename(_ id: String, to title: String) async {
        guard let discovery = discover(),
              let body = try? JSONSerialization.data(withJSONObject: ["id": id, "title": title]) else {
            if pendingRenames[id] == title { pendingRenames.removeValue(forKey: id) }
            rebuild()
            return
        }
        do {
            try await postData("/rename", body, discovery)
            await refresh()
        } catch {
            if pendingRenames[id] == title { pendingRenames.removeValue(forKey: id) }
            rebuild()
        }
    }

    /// Re-render the snapshot from the last daemon payload, hiding rows with a write in flight.
    private func rebuild() {
        // A pending rename the daemon now reports back (or a cleared one it reports gone) is
        // confirmed → dropped, so the gateway title takes over seamlessly.
        for r in lastRows {
            let confirmed = pendingRenames[r.id] == (r.ownerTitle ?? "")
            let cleared = pendingRenames[r.id] == "" && (r.ownerTitle ?? "").isEmpty
            if confirmed || cleared { pendingRenames.removeValue(forKey: r.id) }
        }
        snapshot = buildSnapshot(rows: lastRows, hidden: Set(pendingWrites.keys), renames: pendingRenames)
    }

    /// A short-lived GET against the loopback daemon.
    nonisolated static func get<T: Decodable>(_ type: T.Type, _ path: String, discovery: Discovery) async throws -> T {
        return try JSONDecoder().decode(type, from: await data(path, discovery: discovery))
    }

    nonisolated static func data(_ path: String, discovery: Discovery) async throws -> Data {
        let url = URL(string: "http://127.0.0.1:\(discovery.port)\(path)")!
        var req = URLRequest(url: url)
        req.timeoutInterval = 4
        req.setValue("Bearer \(discovery.authToken)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }

    /// A short-lived POST of a JSON body against the loopback daemon.
    nonisolated static func post(_ path: String, body: Data, discovery: Discovery) async throws {
        let url = URL(string: "http://127.0.0.1:\(discovery.port)\(path)")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 4
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(discovery.authToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = body
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    }

    /// Subscribe to /events; known widget invalidations trigger a refetch, while unknown or
    /// malformed kinds are ignored. Reconnects on drop; the long timeout keeps an idle stream open.
    private func startSSE() {
        sseTask = Task.detached { [weak self] in
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = 3600
            let session = URLSession(configuration: cfg)
            while !Task.isCancelled {
                guard let self else { return }
                guard let discovery = DaemonClient.discoverGateway() else {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                let url = URL(string: "http://127.0.0.1:\(discovery.port)/events")!
                var req = URLRequest(url: url)
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.setValue("Bearer \(discovery.authToken)", forHTTPHeaderField: "Authorization")
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    await self.refresh()
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard line.hasPrefix("data:"),
                              let data = line.dropFirst(5).trimmingCharacters(in: .whitespaces).data(using: .utf8),
                              let event = try? JSONDecoder().decode(WidgetGatewayEvent.self, from: data)
                        else { continue }
                        await self.receive(event)
                    }
                } catch {
                    // stream dropped or daemon down — reconnect after a beat
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }
}
