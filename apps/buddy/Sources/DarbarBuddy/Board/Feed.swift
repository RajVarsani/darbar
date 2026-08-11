import Foundation
import SwiftUI

// MARK: - Where the API lives
//
// No port is hardcoded in the app. build-app.sh reads PORT out of the repo's .env (the one source
// of config, per the root CLAUDE.md) and stamps the resolved base into Info.plist; DARBAR_API in
// the environment overrides it for a dev run. The literal at the end is the same default
// packages/core/src/config.ts falls back to, and exists only so `swift run` works with no bundle.
enum API {
    static let base: URL = {
        if let s = ProcessInfo.processInfo.environment["DARBAR_API"], let u = URL(string: s) { return u }
        if let s = Bundle.main.object(forInfoDictionaryKey: "DarbarAPIBase") as? String,
           let u = URL(string: s) { return u }
        return URL(string: "http://127.0.0.1:4899/api")!
    }()
}

// Mongo writes fractional seconds; a few older rows do not have them. Outside the actor because a
// decoder closure is Sendable. ISO8601DateFormatter's date(from:) is thread-safe for parsing.
enum ISO {
    nonisolated(unsafe) private static let full: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    static func parse(_ s: String) -> Date? { full.date(from: s) ?? plain.date(from: s) }
}

// MARK: - Feed
//
// There is no push channel a client can subscribe to across projects. /api/p/:capId/stream is
// per-board (sse.ts keys subscribers by capId; the '*' fan-out key has no HTTP route), so live
// across every project would mean one EventSource per board or a new server endpoint. The board
// itself treats its stream as a bare nudge (es.onmessage just calls load()), so a poll is the
// same architecture with a coarser trigger, and it costs one loopback request every 10 seconds.
//
// The poll interval is therefore part of what this surface can honestly claim: everything on
// screen is up to POLL seconds old at best, and if a poll fails it is older than that and must
// SAY so rather than keep showing the last good numbers as though they were current.

@MainActor
final class Feed: ObservableObject {
    static let poll: TimeInterval = 10
    /// After this long with no successful read, the numbers stop being presented as current.
    /// Overridable only so the stale treatment can be rendered on demand:
    /// DARBAR_STALE_AFTER=0 swift run DarbarNotch --snapshot /tmp/notch
    static let staleAfter: TimeInterval =
        ProcessInfo.processInfo.environment["DARBAR_STALE_AFTER"].flatMap(Double.init) ?? 30
    /// paging guard: 10 pages of 1000 is far past any real board, and stopping is reported
    private static let pageSize = 1000
    private static let maxPages = 10

    @Published private(set) var snap = Snapshot.empty
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var lastError: String?
    /// re-published on a short tick so every age on screen re-cuts itself. A quiet board emits
    /// nothing; the ages still have to move, which is the whole point of showing them.
    @Published private(set) var now = Date()

    private var loop: Task<Void, Never>?
    private var ticker: Task<Void, Never>?

    var isStale: Bool {
        guard let last = lastSyncedAt else { return true }
        return now.timeIntervalSince(last) > Self.staleAfter
    }

    var hasEverLoaded: Bool { lastSyncedAt != nil }

    /// what the header says about the connection, in plain words
    var syncLabel: String {
        guard let last = lastSyncedAt else { return lastError == nil ? "connecting" : "no data yet" }
        let age = relTime(last, now: now)
        return isStale ? "last read \(age)" : "read \(age)"
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(Self.poll))
            }
        }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                await MainActor.run { self?.now = Date() }
            }
        }
    }

    func stop() {
        loop?.cancel(); loop = nil
        ticker?.cancel(); ticker = nil
    }

    func refresh() async {
        do {
            async let projects = get([Project].self, "/projects")
            async let tasks = openTasks()
            let (ps, ts) = try await (projects, tasks)
            snap = Snapshot(projects: ps, tasks: ts.0, openTotal: ts.1, partial: ts.2)
            lastSyncedAt = Date()
            now = Date()
            lastError = nil
        } catch {
            // the previous snapshot stays on screen, but lastSyncedAt does not move, so it ages
            // into the stale treatment instead of passing for current
            lastError = short(error)
            now = Date()
        }
    }

    /// Pages GET /api/tasks?open=true until `truncated` is false. Returns what was read, the
    /// server's total, and whether paging gave up before the end.
    private func openTasks() async throws -> ([BoardTask], Int, Bool) {
        var all: [BoardTask] = []
        var offset = 0
        var total = 0
        for _ in 0 ..< Self.maxPages {
            let page = try await get(TaskPage.self, "/tasks?open=true&limit=\(Self.pageSize)&offset=\(offset)")
            all.append(contentsOf: page.tasks)
            total = page.total
            guard page.truncated, let next = page.nextOffset, next > offset else {
                return (all, total, false)
            }
            offset = next
        }
        return (all, total, all.count < total)
    }

    private func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
        var req = URLRequest(url: URL(string: API.base.absoluteString + path)!)
        req.timeoutInterval = 5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            throw Err.http((resp as? HTTPURLResponse)?.statusCode ?? 0)
        }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .custom { d in
            let s = try d.singleValueContainer().decode(String.self)
            guard let date = ISO.parse(s) else { throw Err.badDate(s) }
            return date
        }
        return try dec.decode(T.self, from: data)
    }

    enum Err: Error {
        case http(Int)
        case badDate(String)
    }

    private func short(_ e: Error) -> String {
        if let e = e as? Err {
            switch e {
            case let .http(code): return "server said http \(code)"
            case .badDate: return "unreadable timestamp from the server"
            }
        }
        let ns = e as NSError
        if ns.domain == NSURLErrorDomain {
            return ns.code == NSURLErrorCannotConnectToHost || ns.code == NSURLErrorNetworkConnectionLost
                ? "darbar is not answering on \(API.base.host ?? "localhost"):\(API.base.port ?? 80)"
                : "cannot reach darbar"
        }
        return "cannot read the board"
    }
}
