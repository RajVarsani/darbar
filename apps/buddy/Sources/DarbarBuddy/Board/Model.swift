import Foundation

// Wire shapes, decoded from the Darbar API. Only the fields this surface actually renders are
// declared; Codable ignores the rest, so a new server field never breaks the widget.

struct Project: Decodable, Identifiable {
    let _id: String
    let name: String
    let prefix: String
    let capId: String
    let boardUrl: String?
    let counts: Counts?

    struct Counts: Decodable {
        let tasks: Int
        let done: Int
        let pendingFb: Int
    }

    var id: String { _id }
}

// Named BoardTask, not Task: a model called `Task` shadows Swift concurrency's `Task` in every
// file that can see it, and every `Task { }` in the module silently becomes this type.
struct BoardTask: Decodable, Identifiable {
    let shortId: String
    let projectId: String
    let title: String
    let status: String
    let type: String?
    let assignee: String?
    let lane: String?
    let dispatchedAt: Date?
    let updatedAt: Date?

    var id: String { shortId }
}

// GET /api/tasks is paged and says so. `truncated` is the field that must be read: a page is not
// the set, and a widget that renders one page as "everything running" is lying in the same way a
// dispatch badge without an age lies.
struct TaskPage: Decodable {
    let total: Int
    let returned: Int
    let offset: Int
    let limit: Int
    let truncated: Bool
    let nextOffset: Int?
    let tasks: [BoardTask]
}

// MARK: - Derived state

// Mirrors apps/server/web/board.html exactly. The orchestrator knows a task was handed out; only
// the agent knows it started. Neither surface may upgrade a dispatch into "in progress".
let dispatchStale: TimeInterval = 15 * 60

extension BoardTask {
    var isRunning: Bool { status == "in_progress" }

    /// Handed to an agent, not yet self-reported as started.
    var isDispatchPending: Bool {
        dispatchedAt != nil && (status == "todo" || status == "backlog")
    }

    func dispatchAge(_ now: Date) -> TimeInterval? {
        guard isDispatchPending, let d = dispatchedAt else { return nil }
        return now.timeIntervalSince(d)
    }

    func isDispatchLate(_ now: Date) -> Bool {
        (dispatchAge(now) ?? 0) > dispatchStale
    }
}

// MARK: - Work buckets
//
// The six states a project's open work can be in, most urgent first. This order is the order the
// distribution strip draws in, so the eye always finds trouble on the left. A late dispatch is its
// own bucket rather than a shade of "dispatched": it is the one state that means something may be
// broken, and it must never dissolve into a neighbouring colour.
enum Bucket: Int, CaseIterable {
    case lateDispatch, running, dispatched, review, blocked, waiting

    var label: String {
        switch self {
        case .lateDispatch: "overdue dispatch"
        case .running: "running"
        case .dispatched: "dispatched"
        case .review: "in review"
        case .blocked: "blocked"
        case .waiting: "waiting"
        }
    }
}

extension BoardTask {
    func bucket(_ now: Date) -> Bucket {
        if isDispatchPending { return isDispatchLate(now) ? .lateDispatch : .dispatched }
        switch status {
        case "in_progress": return .running
        case "in_review", "qa": return .review
        case "blocked": return .blocked
        default: return .waiting
        }
    }
}

/// One poll's worth of truth, including what it failed to read.
struct Snapshot {
    var projects: [Project] = []
    var tasks: [BoardTask] = []
    /// total open tasks the server reported, which may exceed what we loaded
    var openTotal: Int = 0
    /// true when paging stopped before the set was exhausted; the UI must say so
    var partial: Bool = false

    static let empty = Snapshot()

    func running() -> [BoardTask] {
        tasks.filter { $0.isRunning }.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
    }

    /// oldest dispatch first: the one most likely to be a dead builder leads the list
    func dispatched() -> [BoardTask] {
        tasks.filter { $0.isDispatchPending }
            .sorted { ($0.dispatchedAt ?? .distantFuture) < ($1.dispatchedAt ?? .distantFuture) }
    }

    /// Per-project rollup, computed from the same page of open tasks the drill-down renders, so
    /// the two levels can never disagree with each other.
    struct Row: Identifiable {
        let project: Project
        let running: Int
        let dispatched: Int
        let oldestDispatch: Date?
        let oldestLate: Bool
        let open: Int
        /// counts per bucket, in Bucket order, zeroes included so the strip has a stable vocabulary
        let spread: [(Bucket, Int)]
        var id: String { project._id }

        /// the strip in words, for the row tooltip
        var spreadWhy: String {
            let parts = spread.filter { $0.1 > 0 }.map { "\($0.1) \($0.0.label)" }
            return parts.isEmpty ? "nothing open" : parts.joined(separator: ", ")
        }
    }

    func row(for project: Project, now: Date) -> Row {
        let mine = tasks.filter { $0.projectId == project._id }
        let disp = mine.filter(\.isDispatchPending)
        let oldest = disp.compactMap(\.dispatchedAt).min()
        var counts = [Int](repeating: 0, count: Bucket.allCases.count)
        for t in mine { counts[t.bucket(now).rawValue] += 1 }
        return Row(
            project: project,
            running: mine.filter(\.isRunning).count,
            dispatched: disp.count,
            oldestDispatch: oldest,
            oldestLate: oldest.map { now.timeIntervalSince($0) > dispatchStale } ?? false,
            open: mine.count,
            spread: Bucket.allCases.map { ($0, counts[$0.rawValue]) })
    }

    /// Home order: anything overdue first, then whatever is actually moving, then size. A project
    /// with a possibly-dead builder should never sit below a bigger quiet one.
    func rows(now: Date) -> [Row] {
        projects.map { row(for: $0, now: now) }
            .sorted {
                ($0.oldestLate ? 1 : 0, $0.running + $0.dispatched, $0.open)
                    > ($1.oldestLate ? 1 : 0, $1.running + $1.dispatched, $1.open)
            }
    }

    func tasks(in projectId: String, now: Date) -> [BoardTask] {
        tasks.filter { $0.projectId == projectId }
            .sorted { a, b in
                let (x, y) = (a.bucket(now).rawValue, b.bucket(now).rawValue)
                if x != y { return x < y }
                return (a.updatedAt ?? .distantPast) > (b.updatedAt ?? .distantPast)
            }
    }

    func project(_ id: String) -> Project? { projects.first { $0._id == id } }
}
