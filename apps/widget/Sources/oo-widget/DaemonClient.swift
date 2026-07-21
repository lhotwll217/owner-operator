// The widget's seam to the daemon — a THIN CLIENT (OpenClaw gateway pattern): it discovers the
// live port, GETs the session and agent-state projections, and subscribes to the SSE /events stream
// so changes land instantly. The poll is the heartbeat (covers SSE gaps + offline→online); the SSE
// frame is just a "refetch now" nudge, so the GET path stays the single source of shape.

import Foundation
import Combine

@MainActor
final class DaemonClient: ObservableObject {
    static let shared = DaemonClient()

    typealias DiscoverGateway = @Sendable () -> Discovery?
    typealias FetchData = @Sendable (_ path: String, _ discovery: Discovery) async throws -> Data

    private let discover: DiscoverGateway
    private let fetchData: FetchData

    nonisolated init(
        discover: @escaping DiscoverGateway = { DaemonClient.discoverGateway() },
        fetchData: @escaping FetchData = { path, discovery in
            try await DaemonClient.data(path, discovery: discovery)
        }
    ) {
        self.discover = discover
        self.fetchData = fetchData
    }

    @Published var groups: [RepoGroup] = []
    @Published var counts: [ThreadState: Int] = [:]
    @Published var online = false
    @Published var setupRequired = false
    @Published var port = defaultPort
    @Published var agentState = AgentStateView.empty

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

    // The last payload the daemon gave us (the truth we render), plus ids the owner marked done
    // locally but the daemon hasn't confirmed yet — hidden until it does.
    private var lastRows: [SessionStateRow] = []
    private var pendingDone: Set<String> = []
    private var pendingRenames: [String: String] = [:]

    var needsYou: Int { counts[.needsYou] ?? 0 }
    var working: Int { counts[.working] ?? 0 }
    var activeTotal: Int { groups.reduce(0) { $0 + $1.rows.count } }

    /// Threads whose turn JUST completed — now needs-you and entered that state within `window`
    /// seconds. Most-recently-finished first. The set the collapsed HUD softly pulses through.
    func freshNeedsYou(window: TimeInterval = 300) -> [SessionStateRow] {
        let now = Date()
        return groups.flatMap { $0.rows }
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
    }

    private func refreshOnce() async {
        guard let discovery = discover() else {
            clearDisconnectedState()
            return
        }
        do {
            let readiness = try decode(Readiness.self, from: await fetchData("/ready", discovery))
            let rows = try decode([SessionStateRow].self, from: await fetchData("/session-state", discovery))
            let delegated = try decode(AgentStateView.self, from: await fetchData("/agent-state", discovery))
            lastRows = rows
            agentState = delegated
            port = discovery.port
            setupRequired = readiness.setupRequired
            online = true
            rebuild()
        } catch {
            clearDisconnectedState()
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }

    private func clearDisconnectedState() {
        online = false
        setupRequired = false
        lastRows = []
        agentState = .empty
        rebuild()
    }

    /// SSE carries invalidations only. Relevant events reconcile both durable widget snapshots.
    func receive(_ event: WidgetGatewayEvent) async {
        switch event.kind {
        case .stateChanged, .agentRunChanged:
            await refresh()
        }
    }

    /// Mark a thread done: hide it immediately (optimistic), then tell the daemon. The daemon owns
    /// the truth — its next state payload confirms it; a failed POST un-hides it so we never lie.
    func markDone(_ id: String) {
        pendingDone.insert(id)
        rebuild()
        Task { await postDone(id) }
    }

    private func postDone(_ id: String) async {
        guard let discovery = Self.discoverGateway() else { pendingDone.remove(id); rebuild(); return }
        do {
            try await Self.postJSON("/done", discovery: discovery, body: ["ids": [id]])
            await refresh()
        } catch {
            pendingDone.remove(id)
            rebuild()
        }
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
        guard let discovery = Self.discoverGateway() else {
            if pendingRenames[id] == title { pendingRenames.removeValue(forKey: id) }
            rebuild()
            return
        }
        do {
            try await Self.postJSON("/rename", discovery: discovery, body: ["id": id, "title": title])
            await refresh()
        } catch {
            if pendingRenames[id] == title { pendingRenames.removeValue(forKey: id) }
            rebuild()
        }
    }

    /// Re-render groups/counts from the last daemon payload, hiding still-pending dones. Pending ids
    /// the daemon no longer reports active are confirmed → dropped from the pending set.
    private func rebuild() {
        let active = Set(lastRows.map { $0.id })
        pendingDone.formIntersection(active)
        // A pending rename the daemon now reports back (or a cleared one it reports gone) is
        // confirmed → dropped, so the gateway title takes over seamlessly.
        for r in lastRows {
            let confirmed = pendingRenames[r.id] == (r.ownerTitle ?? "")
            let cleared = pendingRenames[r.id] == "" && (r.ownerTitle ?? "").isEmpty
            if confirmed || cleared { pendingRenames.removeValue(forKey: r.id) }
        }
        let built = buildSessionState(rows: lastRows, hidden: pendingDone, renames: pendingRenames)
        groups = built.groups
        counts = built.counts
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
    nonisolated static func postJSON(_ path: String, discovery: Discovery, body: [String: Any]) async throws {
        let url = URL(string: "http://127.0.0.1:\(discovery.port)\(path)")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 4
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(discovery.authToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    }

    /// Subscribe to /events; any `data:` frame means "something changed" → refetch. Reconnects
    /// on drop. Runs off the main actor; the long request timeout keeps an idle stream open.
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
