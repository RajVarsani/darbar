import SwiftUI

// The board surface, carried over from apps/notch/Sources/DarbarNotch/NotchView.swift.
//
// Everything that made that file worth keeping is unchanged here: the buckets and their order, the
// 15-minute dispatch threshold, the rule that a DISPATCHED badge is never drawn without its age,
// the stale dimming and banner, and the reasoning behind the distribution strip. What changed is
// only what the host changed: this hangs off a desktop pet instead of a hardware cutout, so it has
// its own card, its own reveal, and a fixed body height (a notch panel could grow into empty
// screen; a card sitting on top of the pet cannot move without looking like it flinched).

// MARK: - Palette

enum Ink {
    static let live = Color(red: 0.35, green: 0.85, blue: 0.55)
    static let late = Color(red: 1.0, green: 0.42, blue: 0.42)
    static let review = Color(red: 0.62, green: 0.60, blue: 0.98)
    static let blocked = Color(red: 0.98, green: 0.74, blue: 0.36)
    static let dim = Color.white.opacity(0.45)
    static let faint = Color.white.opacity(0.20)
    static let row = Color.white.opacity(0.05)
    static let rowHot = Color.white.opacity(0.11)
    /// the picker popover's fill, so the two panels the pet can produce look like siblings
    static let card = Color(red: 0.14, green: 0.14, blue: 0.17)
}

extension Bucket {
    var tint: Color {
        switch self {
        case .lateDispatch: Ink.late
        case .running: Ink.live
        case .dispatched: Ink.live.opacity(0.5) // a claim by the orchestrator, not a report by a builder
        case .review: Ink.review
        case .blocked: Ink.blocked
        case .waiting: Color.white.opacity(0.22)
        }
    }
}

// MARK: - Navigation
//
// Projects is the home surface, not a tab. There is no global Running view: the only thing it
// answered that a project list does not is "is anything on fire anywhere", and the header chip
// answers that in one line. Running work is reached THROUGH a project, which is also where it
// belongs, since a running row is meaningless without knowing whose board it is on.

enum Route: Equatable {
    case home
    case project(String) // project _id
}

enum Filter: String, CaseIterable {
    case inFlight = "In flight"
    case allOpen = "All open"
}

@MainActor
final class UIState: ObservableObject {
    @Published var route: Route = .home
    /// the card's own transform: false is folded away inside the pet's head
    @Published var carded = false
    /// false while the card is still growing; the content waits for it to land
    @Published var revealed = false
    @Published var filter: Filter = .inFlight
    /// render-mode only: the row id to draw as hovered, since a PNG has no pointer
    @Published var forceHotRow: String?

    func reset() {
        route = .home
        filter = .inFlight
    }
}

// MARK: - Geometry
//
// One width, one header height and ONE BODY HEIGHT for both levels. The body height is the whole
// no-jump rule: drilling into a project swaps the contents of a box that does not move, so the
// header, the card edges and the seam pointing at the pet's head all stay exactly where they were.
enum Metrics {
    static let width: CGFloat = 470
    static let headerH: CGFloat = 20
    static let projectRowH: CGFloat = 42
    static let taskRowH: CGFloat = 32
    static let gap: CGFloat = 5
    static let projectCap = 5
    static let taskCap = 6
    /// the filter segmented control that sits above the task list, inside the body
    static let filterH: CGFloat = 18
    /// the one footnote line at the bottom of both levels, always reserved even when it is empty
    static let footerH: CGFloat = 14
    /// Tallest level wins and BOTH levels then reserve it. Computed rather than typed, because a
    /// hardcoded number here would silently start clipping the day a cap or a row height changes,
    /// and the thing it clips is the last row of a full list.
    static let bodyH: CGFloat = max(
        CGFloat(projectCap) * projectRowH + CGFloat(projectCap - 1) * gap,
        filterH + gap + CGFloat(taskCap) * taskRowH + CGFloat(taskCap - 1) * gap)
        + gap + footerH
    static let strip: CGFloat = 96
    static let actions: CGFloat = 54 // reserved on every row, so hover reveals rather than shoves
    /// the tail at the bottom of the card that points back at the pet
    static let seam: CGFloat = 9
    /// transparent margin around the card so its own drop shadow is not clipped by the window
    static let shadowPad: CGFloat = 8
}

// MARK: - The card

struct BoardCard: View {
    @ObservedObject var feed: Feed
    @ObservedObject var ui: UIState
    /// where the pet's head is, as a fraction of the card width, so the seam points at it
    var seamAt: CGFloat = 0.5

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header.stageIn(ui.revealed, order: 0)

            if feed.isStale {
                staleBanner.stageIn(ui.revealed, order: 1)
            }

            content
                .frame(width: Metrics.width - 32, height: Metrics.bodyH, alignment: .top)
                .opacity(feed.isStale ? 0.55 : 1) // stale numbers must not read as current
                .clipped()
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 12)
        .frame(width: Metrics.width, alignment: .leading)
        .foregroundStyle(.white)
        .background(
            CardShape(seamAt: seamAt)
                .fill(Ink.card.opacity(0.96))
                .overlay(CardShape(seamAt: seamAt).stroke(Color.white.opacity(0.09), lineWidth: 1))
                .shadow(color: .black.opacity(0.45), radius: 18, y: 6)
        )
        .padding(Metrics.shadowPad)
    }

    @ViewBuilder
    private var content: some View {
        switch ui.route {
        case .home:
            HomeLevel(feed: feed, ui: ui)
                .transition(.asymmetric(
                    insertion: .move(edge: .leading).combined(with: .opacity),
                    removal: .move(edge: .leading).combined(with: .opacity)))
        case let .project(id):
            ProjectLevel(feed: feed, ui: ui, projectId: id)
                .transition(.asymmetric(
                    insertion: .move(edge: .trailing).combined(with: .opacity),
                    removal: .move(edge: .trailing).combined(with: .opacity)))
        }
    }

    // MARK: header
    //
    // Same height and same first-baseline at both levels. At home it is the wordmark; inside a
    // project the wordmark demotes itself to a breadcrumb crumb and the prefix takes the emphasis,
    // so "where am I" is answered by weight and colour rather than by the row moving.

    private var header: some View {
        HStack(spacing: 9) {
            switch ui.route {
            case .home:
                Text("DARBAR")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .kerning(1.6)
                    .foregroundStyle(Ink.dim)
                attention
            case let .project(id):
                BackButton { ui.route = .home }
                Text("DARBAR")
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .kerning(1.4)
                    .foregroundStyle(Ink.faint)
                Text("/")
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .foregroundStyle(Ink.faint)
                Text(feed.snap.project(id)?.prefix ?? "?")
                    .font(.system(size: 11, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white)
                Text(feed.snap.project(id)?.name ?? "")
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(Ink.dim)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)
            syncChip
        }
        .frame(height: Metrics.headerH)
    }

    /// Trouble wins: an overdue dispatch anywhere is the only thing worth saying before "how much
    /// is moving".
    @ViewBuilder
    private var attention: some View {
        let late = feed.snap.dispatched().filter { $0.isDispatchLate(feed.now) }
        let running = feed.snap.running().count
        if let oldest = late.compactMap(\.dispatchedAt).min() {
            Chip("\(late.count) overdue, oldest \(ageShort(oldest, now: feed.now))", Ink.late)
                .help(dispatchWhy(oldest, now: feed.now, late: true))
        } else if running > 0 {
            Chip("\(running) running", Ink.live)
        }
    }

    private var syncChip: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(feed.isStale ? Ink.late : Ink.live)
                .frame(width: 6, height: 6)
            Text(feed.syncLabel)
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(Ink.dim)
        }
    }

    private var staleBanner: some View {
        Text(feed.hasEverLoaded
            ? "Showing what darbar said \(relTime(feed.lastSyncedAt ?? feed.now, now: feed.now)), not what is true now. \(feed.lastError ?? "No fresh read since.")"
            : (feed.lastError ?? "Waiting for the first read."))
            .font(.system(size: 10.5, design: .rounded))
            .foregroundStyle(Ink.late)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Ink.late.opacity(0.12)))
    }
}

/// A rounded card with a tail on the bottom edge, aimed at the pet's head. Without it the card is
/// just a window that appeared near a cartoon; with it, the pet produced it.
///
/// One continuous outline rather than a rectangle with a triangle stuck under it, because the card
/// is stroked as well as filled and a two-subpath version draws a seam across the join, which
/// reads as two shapes that happen to touch.
struct CardShape: Shape {
    var seamAt: CGFloat
    var radius: CGFloat = 16

    func path(in rect: CGRect) -> Path {
        let r = radius
        let bottom = rect.maxY - Metrics.seam
        let half = Metrics.seam + 2
        let x = min(max(rect.minX + rect.width * seamAt, rect.minX + r + half),
                    rect.maxX - r - half)

        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY + r))
        p.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY),
                 tangent2End: CGPoint(x: rect.minX + r, y: rect.minY), radius: r)
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY),
                 tangent2End: CGPoint(x: rect.maxX, y: rect.minY + r), radius: r)
        p.addLine(to: CGPoint(x: rect.maxX, y: bottom - r))
        p.addArc(tangent1End: CGPoint(x: rect.maxX, y: bottom),
                 tangent2End: CGPoint(x: rect.maxX - r, y: bottom), radius: r)
        p.addLine(to: CGPoint(x: x + half, y: bottom))
        p.addQuadCurve(to: CGPoint(x: x, y: rect.maxY),
                       control: CGPoint(x: x + half * 0.34, y: bottom + Metrics.seam * 0.62))
        p.addQuadCurve(to: CGPoint(x: x - half, y: bottom),
                       control: CGPoint(x: x - half * 0.34, y: bottom + Metrics.seam * 0.62))
        p.addLine(to: CGPoint(x: rect.minX + r, y: bottom))
        p.addArc(tangent1End: CGPoint(x: rect.minX, y: bottom),
                 tangent2End: CGPoint(x: rect.minX, y: bottom - r), radius: r)
        p.closeSubpath()
        return p
    }
}

// MARK: - Level 1: projects

struct HomeLevel: View {
    @ObservedObject var feed: Feed
    @ObservedObject var ui: UIState

    var body: some View {
        let rows = feed.snap.rows(now: feed.now)
        VStack(alignment: .leading, spacing: Metrics.gap) {
            if rows.isEmpty {
                Text(feed.hasEverLoaded ? "No projects." : "")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(Ink.dim)
                    .frame(height: Metrics.projectRowH)
            }
            ForEach(Array(rows.prefix(Metrics.projectCap).enumerated()), id: \.element.id) { i, row in
                ProjectRow(row: row, now: feed.now, forceHot: ui.forceHotRow == row.id) {
                    ui.route = .project(row.project._id)
                }
                .stageIn(ui.revealed, order: i + 2)
            }

            Spacer(minLength: 0)

            // The slack under a short project list is where the totals go, so the box is never
            // padded with nothing and the two footnotes below have somewhere to sit.
            HStack(spacing: 6) {
                Footnote(rows.count > Metrics.projectCap
                    ? "+\(rows.count - Metrics.projectCap) more projects"
                    : totals(rows))
                if feed.snap.partial {
                    Footnote("read \(feed.snap.tasks.count) of \(feed.snap.openTotal) open, so these counts are not the whole set", Ink.late)
                }
            }
            .frame(height: Metrics.footerH)
            .stageIn(ui.revealed, order: Metrics.projectCap + 2)
        }
    }

    private func totals(_ rows: [Snapshot.Row]) -> String {
        let open = rows.reduce(0) { $0 + $1.open }
        let running = rows.reduce(0) { $0 + $1.running }
        if open == 0 { return "Nothing open anywhere." }
        return "\(open) open across \(rows.count) project\(rows.count == 1 ? "" : "s"), \(running) running"
    }
}

struct ProjectRow: View {
    let row: Snapshot.Row
    let now: Date
    /// forced on only by the PNG render mode, which has no pointer to hover with
    var forceHot = false
    let open: () -> Void

    @State private var hovering = false
    private var hot: Bool { hovering || forceHot }

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.project.prefix)
                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.9))
                Text(row.project.name)
                    .font(.system(size: 11.5, design: .rounded))
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(width: 132, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                WorkStrip(spread: row.spread, total: row.open)
                    .frame(width: Metrics.strip, alignment: .leading)
                // the decaying claim, preserved from the board and from the notch
                if row.dispatched > 0, let oldest = row.oldestDispatch {
                    Text("oldest dispatch \(ageShort(oldest, now: now))")
                        .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(row.oldestLate ? Ink.late : Ink.dim)
                        .help(dispatchWhy(oldest, now: now, late: row.oldestLate))
                }
            }
            // wider than the strip itself: the dispatch age underneath it is a sentence, and it
            // must not run out from under its own column into the count
            .frame(width: Metrics.strip + 30, alignment: .leading)
            .help(row.spreadWhy)

            Spacer(minLength: 6)

            // labelled, because a bare number next to a coloured strip is a number of what
            HStack(spacing: 3) {
                Text("\(row.open)")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(row.open == 0 ? Ink.faint : .white.opacity(0.85))
                Text("open")
                    .font(.system(size: 9, design: .rounded))
                    .foregroundStyle(Ink.faint)
            }
            .frame(width: 48, alignment: .trailing)
            .help("\(row.open) open now, \(row.project.counts?.tasks ?? 0) all time")

            // reserved width whether or not the actions are showing, so hover reveals and never shoves
            HStack(spacing: 4) {
                IconButton("arrow.up.forward.app", "open this board in a browser") {
                    NSWorkspace.shared.open(boardURL)
                }
                IconButton("chevron.right", "open this project here, in the buddy", action: open)
            }
            .frame(width: Metrics.actions, alignment: .trailing)
            .opacity(hot ? 1 : 0)
        }
        .padding(.horizontal, 10)
        .frame(height: Metrics.projectRowH)
        .background(RoundedRectangle(cornerRadius: 8).fill(hot ? Ink.rowHot : Ink.row))
        .overlay(alignment: .leading) {
            if row.oldestLate {
                RoundedRectangle(cornerRadius: 2).fill(Ink.late).frame(width: 3).padding(.vertical, 7)
            }
        }
        .contentShape(Rectangle()) // the whole row is the hover and click target, not the chevron
        .onHover { h in withAnimation(.easeOut(duration: 0.13)) { hovering = h } }
        .onTapGesture(perform: open)
    }

    /// The local board, deliberately, and not the `boardUrl` on the payload: that one is built from
    /// BASE_URL, which is the ngrok domain when the tunnel is configured, so it dies whenever the
    /// tunnel is down. This app only ever talks to loopback, where the board always answers.
    /// The payload URL is still the fallback, so a machine where the API base is not loopback gets
    /// something rather than nothing.
    private var boardURL: URL {
        let origin = API.base.absoluteString.replacingOccurrences(of: "/api", with: "")
        return URL(string: "\(origin)/p/\(row.project.capId)")
            ?? URL(string: row.project.boardUrl ?? "http://127.0.0.1:4899")!
    }
}

// MARK: - The distribution strip
//
// Raj asked for a ring. A ring is the wrong instrument here and this is why.
//
// A ring encodes PROPORTION, which only carries information once there are enough items for a
// proportion to mean something. DAR has 4 open and MRF has 6. At n=3 every slice of a donut is
// 120 degrees and the eye reads "a third" when the fact is "one task". That is decoration wearing
// the costume of data, and it costs more pixels than the number it replaces.
//
// The two honest instruments at these sizes are different from each other:
//   - while the items are COUNTABLE, draw the items. One pip per task, coloured by state. At n=4
//     you read it exactly: three green, one red. No estimation, no legend.
//   - once they are not countable, proportion is the only thing left worth showing, so the pips
//     fuse into one proportional bar.
// So the strip changes RESOLUTION at 12 rather than changing chart. Same colours, same slot, same
// width, same left-to-right urgency order, so it never reads as two different widgets. MRF's 439
// all-time rows would be a smear as pips and are a shape as a bar; its 6 open are four pips and a
// gap. Both are right, which is the whole test.

struct WorkStrip: View {
    let spread: [(Bucket, Int)]
    let total: Int

    private static let pipMax = 12
    private static let pip: CGFloat = 7
    private static let gap: CGFloat = 3

    var body: some View {
        HStack(spacing: 0) {
            if total == 0 {
                Capsule().fill(Ink.faint).frame(width: 22, height: 3)
            } else if total <= Self.pipMax {
                pips
            } else {
                bar
            }
            Spacer(minLength: 0)
        }
        .frame(height: Self.pip)
    }

    private var pips: some View {
        HStack(spacing: Self.gap) {
            ForEach(Array(expanded.enumerated()), id: \.offset) { _, b in
                RoundedRectangle(cornerRadius: 2)
                    .fill(b.tint)
                    .frame(width: Self.pip, height: Self.pip)
            }
        }
    }

    private var bar: some View {
        HStack(spacing: 1) {
            ForEach(spread.filter { $0.1 > 0 }, id: \.0) { b, n in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(b.tint)
                    // every present bucket keeps at least 3pt, so one overdue dispatch in 400 rows
                    // is still visible rather than rounded out of existence
                    .frame(width: max(3, (Metrics.strip - 6) * CGFloat(n) / CGFloat(total)), height: 6)
            }
        }
    }

    private var expanded: [Bucket] {
        spread.flatMap { b, n in Array(repeating: b, count: n) }
    }
}

// MARK: - Level 2: one project

struct ProjectLevel: View {
    @ObservedObject var feed: Feed
    @ObservedObject var ui: UIState
    let projectId: String

    var body: some View {
        let all = feed.snap.tasks(in: projectId, now: feed.now)
        let shown = ui.filter == .allOpen ? all : all.filter { inFlight($0) }
        VStack(alignment: .leading, spacing: Metrics.gap) {
            HStack(spacing: 8) {
                Text(shown.isEmpty ? "" : "\(shown.count) shown of \(all.count) open")
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(Ink.faint)
                Spacer(minLength: 8)
                Segmented(selection: $ui.filter)
            }
            .frame(height: Metrics.filterH)

            if shown.isEmpty {
                Text(ui.filter == .inFlight
                    ? "Nothing in flight here. \(all.count) open."
                    : "Nothing open here.")
                    .font(.system(size: 11.5, design: .rounded))
                    .foregroundStyle(Ink.dim)
                    .frame(height: Metrics.taskRowH)
            }

            ForEach(Array(shown.prefix(Metrics.taskCap).enumerated()), id: \.element.id) { i, t in
                TaskRow(task: t, now: feed.now)
                    .stageIn(ui.revealed, order: i + 2)
            }

            Spacer(minLength: 0)

            // reserved at both levels whether or not it says anything, so a full task list keeps
            // its sixth row instead of losing it to the footnote
            Footnote(shown.count > Metrics.taskCap
                ? "+\(shown.count - Metrics.taskCap) more, the board has them all"
                : "")
                .frame(height: Metrics.footerH)
        }
    }

    /// what "in flight" means here: someone or something is supposed to be acting on it now
    private func inFlight(_ t: BoardTask) -> Bool {
        switch t.bucket(feed.now) {
        case .lateDispatch, .running, .dispatched, .review: true
        case .blocked, .waiting: false
        }
    }
}

struct TaskRow: View {
    let task: BoardTask
    let now: Date

    var body: some View {
        let b = task.bucket(now)
        HStack(spacing: 9) {
            Text(task.shortId)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 76, alignment: .leading)

            Text(task.title)
                .font(.system(size: 11.5, design: .rounded))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let who = task.assignee, !who.isEmpty {
                Text(who)
                    .font(.system(size: 9.5, design: .rounded))
                    .foregroundStyle(Ink.dim)
                    .lineLimit(1)
            }

            badge(b)
        }
        .padding(.horizontal, 10)
        .frame(height: Metrics.taskRowH)
        .background(RoundedRectangle(cornerRadius: 8).fill(Ink.row))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2).fill(b.tint).frame(width: 3).padding(.vertical, 6)
        }
        .help(helpText)
    }

    // A dispatch badge is only honest because it ages. It is never drawn without one.
    @ViewBuilder
    private func badge(_ b: Bucket) -> some View {
        switch b {
        case .lateDispatch, .dispatched:
            if let d = task.dispatchedAt {
                Chip("DISPATCHED \(ageShort(d, now: now))", b.tint)
            }
        case .running:
            // the row's own stripe already says it is running, so the badge spends its width on
            // what that cannot say: how long since anything happened. No colour rule, because the
            // board defines no threshold for a quiet in_progress and this surface must not invent
            // a second opinion.
            if let u = task.updatedAt { Chip(ageShort(u, now: now), Ink.dim) }
        case .review, .blocked, .waiting:
            Chip(task.status.replacingOccurrences(of: "_", with: " ").uppercased(), b.tint)
        }
    }

    private var helpText: String {
        if let d = task.dispatchedAt, task.isDispatchPending {
            return dispatchWhy(d, now: now, late: task.isDispatchLate(now))
        }
        if task.isRunning {
            let age = task.updatedAt.map { relTime($0, now: now) } ?? "unknown"
            return "the builder reported in_progress itself. Last board update \(age)"
        }
        return task.title
    }
}

// MARK: - Resting status
//
// The notch had two compact slots either side of the cutout; the pet has this, a small pill under
// its feet. Same constraint, so the same rule: too small to caption anything, which CONSTRAINS
// what it may claim. Never a bare count of dispatches, because a count with no age is the
// stale-claim problem in miniature.
//
// It only appears when there is something to say. A pill that reads "0" at all times is furniture,
// and the point of putting it on a pet is that the pet is quiet until it is not.

struct RestingStatus: View {
    @ObservedObject var feed: Feed

    var hasSomethingToSay: Bool {
        feed.isStale || feed.snap.running().count > 0 || feed.snap.dispatched().first != nil
    }

    var body: some View {
        HStack(spacing: 7) {
            HStack(spacing: 4) {
                Circle()
                    .fill(feed.isStale ? Ink.faint : Ink.live)
                    .frame(width: 5, height: 5)
                Text(feed.hasEverLoaded ? "\(feed.snap.running().count)" : "–")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(feed.isStale ? Ink.dim : .white)
            }

            if feed.isStale {
                label("exclamationmark.triangle.fill",
                      feed.hasEverLoaded ? ageShort(feed.lastSyncedAt ?? feed.now, now: feed.now) : "?",
                      Ink.late)
            } else if let oldest = feed.snap.dispatched().first?.dispatchedAt {
                let late = feed.now.timeIntervalSince(oldest) > dispatchStale
                label("paperplane.fill", ageShort(oldest, now: feed.now), late ? Ink.late : Ink.dim)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(Capsule().fill(Ink.card.opacity(0.92))
            .shadow(color: .black.opacity(0.3), radius: 6, y: 2))
        .help(feed.isStale
            ? "\(feed.syncLabel). \(feed.lastError ?? "")"
            : "\(feed.snap.running().count) running. Click to open the board.")
    }

    private func label(_ symbol: String, _ text: String, _ tint: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 8, weight: .bold))
            Text(text).font(.system(size: 10.5, weight: .bold, design: .rounded))
        }
        .foregroundStyle(tint)
    }
}

// MARK: - Small parts

struct Chip: View {
    let text: String
    let tint: Color

    init(_ text: String, _ tint: Color) { self.text = text; self.tint = tint }

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2.5)
            .background(Capsule().fill(tint.opacity(0.15)))
            .fixedSize()
    }
}

struct Footnote: View {
    let text: String
    var tint: Color = Ink.dim
    init(_ text: String, _ tint: Color = Ink.dim) { self.text = text; self.tint = tint }
    var body: some View {
        Text(text)
            .font(.system(size: 10, design: .rounded))
            .foregroundStyle(tint)
            .lineLimit(1)
    }
}

struct IconButton: View {
    let symbol: String
    let hint: String
    let action: () -> Void
    @State private var hot = false

    init(_ symbol: String, _ hint: String, action: @escaping () -> Void) {
        self.symbol = symbol; self.hint = hint; self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(hot ? .white : Ink.dim)
                .frame(width: 22, height: 20)
                .background(RoundedRectangle(cornerRadius: 5).fill(hot ? Ink.rowHot : .clear))
        }
        .buttonStyle(.plain)
        .onHover { hot = $0 }
        .help(hint)
    }
}

/// Labelled "back" and not "esc". The notch could promise escape because it took key focus, and
/// this panel asks for it too, but an inactive accessory app is not routed keystrokes: verified
/// live, the card opens with isKeyWindow false. Escape still works when the app happens to be
/// active, so the monitor stays, but the button may only promise what always happens.
struct BackButton: View {
    let action: () -> Void
    @State private var hot = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Image(systemName: "chevron.left").font(.system(size: 9, weight: .heavy))
                Text("back").font(.system(size: 9, weight: .bold, design: .rounded))
            }
            .foregroundStyle(hot ? .white : Ink.dim)
            .padding(.horizontal, 6)
            .frame(height: 18)
            .background(Capsule().fill(hot ? Ink.rowHot : Ink.row))
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hot = h } }
        .help("back to all projects")
    }
}

struct Segmented: View {
    @Binding var selection: Filter

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Filter.allCases, id: \.self) { f in
                Button { withAnimation(.easeOut(duration: 0.16)) { selection = f } } label: {
                    Text(f.rawValue)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(selection == f ? Color.white.opacity(0.16) : .clear))
                        .foregroundStyle(selection == f ? .white : Ink.dim)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Staging
//
// The card grows out of the pet's head first; the content arrives after it has landed, one row
// behind the next. Driven by an explicit flag rather than onAppear, because the hosting view stays
// alive between states and onAppear does not fire again.

extension View {
    func stageIn(_ revealed: Bool, order: Int) -> some View {
        modifier(StageIn(revealed: revealed, order: order))
    }
}

struct StageIn: ViewModifier {
    let revealed: Bool
    let order: Int

    func body(content: Content) -> some View {
        content
            .opacity(revealed ? 1 : 0)
            .offset(y: revealed ? 0 : -7)
            .blur(radius: revealed ? 0 : 2.5)
            .animation(
                .spring(response: 0.34, dampingFraction: 0.86)
                    .delay(revealed ? 0.10 + Double(min(order, 8)) * 0.032 : 0),
                value: revealed)
    }
}
