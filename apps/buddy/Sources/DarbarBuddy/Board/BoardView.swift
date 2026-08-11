import SwiftUI

// The board surface, carried over from apps/notch/Sources/DarbarNotch/NotchView.swift.
//
// Everything that made that file worth keeping is unchanged: the buckets and their order, the
// 15-minute dispatch threshold, the rule that a DISPATCHED badge is never drawn without its age,
// the stale dimming and banner, and the resolution change from pips to a bar once the items stop
// being countable. Model.swift, Age.swift and Feed.swift are byte-identical to the deleted notch
// app and stay that way.
//
// What changed here is the composition, after looking at the surfaces that do this well:
//
//  - Height follows content, with the change animated (Raycast's palette resizes itself as its
//    result list changes; it does not reserve its tallest state). The old fixed body height was
//    there to stop the card flinching on a level change. A spring on the height keeps that promise
//    without paying two thirds of the card in empty space to keep it.
//  - One column band on the right, declared once in a header row, so the counts form a column
//    (Linear's list views; Darbar's own board draws its pip strip with a single `.plbl` label
//    rather than a label per pip). The per-row word "open" is gone.
//  - One accent. Darbar's board is lime #d8ff7c on ink and uses it for in_progress; this surface
//    now uses the same lime for running instead of inventing a second green. Colour is punctuation
//    (Raycast keeps its chrome monochrome and reserves saturated accents; Geist calls restraint a
//    feature), so review, dispatched and waiting are steps on a white ramp rather than three more
//    hues competing with the two that mean something.
//  - Depth from a surface ladder plus hairlines rather than from one big blur (Raycast documents
//    "no drop shadows" and gets depth from a four-step surface ladder and 1px hairlines;
//    Superhuman likewise avoids heavy shadows on UI surfaces). The card keeps ONE shadow because
//    it genuinely floats over a desktop, and gains a top-lit hairline so it reads as lit.
//  - Four type sizes, not nine. macOS's own scale bottoms out at 10pt; this file used to carry
//    8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5 and 13. Emphasis is carried by weight and opacity.
//  - Tabular digits on every number that sits in a column (Vercel's interface guidelines call for
//    tabular-nums on anything compared; Geist uses mono for counts, ids and timestamps).

// MARK: - Palette
//
// Three hues and a white ramp. The hues are the two alarms and the one live state; everything else
// is a step on the ramp, which is how a dark UI carries structure without carrying colour.

enum Ink {
    /// Darbar's one accent, lifted from the board's --lime. The board already paints in_progress
    /// with it, so the two surfaces now agree rather than each keeping its own green.
    static let live = Color(red: 0.847, green: 1.0, blue: 0.486) // #d8ff7c
    /// the alarm: a dispatch nobody picked up, which may mean a dead builder
    static let late = Color(red: 1.0, green: 0.42, blue: 0.42)
    /// the other alarm, kept a separate hue on purpose: Model.swift's rule is that a late dispatch
    /// must never dissolve into a neighbour, and the board paints blocked red too, so red for both
    /// would merge exactly the two states that must stay apart on this surface.
    static let block = Color(red: 0.98, green: 0.74, blue: 0.36)

    static let text = Color.white.opacity(0.92)
    static let dim = Color.white.opacity(0.45)
    static let faint = Color.white.opacity(0.28)
    static let ghost = Color.white.opacity(0.16)

    static let row = Color.white.opacity(0.045)
    static let rowHot = Color.white.opacity(0.10)
    static let hairline = Color.white.opacity(0.075)

    /// the card, and the picker popover, so the two panels the pet can produce look like siblings
    static let card = Color(red: 0.086, green: 0.090, blue: 0.106)
}

extension Bucket {
    var tint: Color {
        switch self {
        case .lateDispatch: Ink.late
        case .running: Ink.live
        // NOT a faded green. A dispatch is a claim by the orchestrator, not a report by a builder,
        // and painting it as a dimmer version of running is the exact upgrade Model.swift forbids.
        // On the ramp it reads as queued, which is what it is; its age is what carries the risk.
        case .dispatched: Color.white.opacity(0.42)
        case .review: Color.white.opacity(0.30)
        case .blocked: Ink.block
        case .waiting: Color.white.opacity(0.13)
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

/// What "in flight" means on this surface: someone or something is supposed to be acting on it
/// now. Lives here rather than in Model.swift, which is held byte-identical to the notch build.
extension BoardTask {
    func isInFlight(_ now: Date) -> Bool {
        switch bucket(now) {
        case .lateDispatch, .running, .dispatched, .review: true
        case .blocked, .waiting: false
        }
    }
}

// MARK: - Geometry
//
// One width and one right-hand column band, shared by the column header and every row so the
// numbers line up under their label instead of drifting.
//
// The body height is COMPUTED FROM THE ROWS, not reserved at the tallest case. The old fixed
// height existed so drilling into a project could not make the card flinch; a spring on the height
// keeps that promise, because a change you can watch is a transition rather than a jump, and the
// window is anchored by its bottom edge at the pet's head so the tail never moves while it
// resizes. The cost of the old rule was two thirds of the card being empty on a three-project
// board, which is most days.
enum Metrics {
    static let width: CGFloat = 470
    /// card width less its 16pt gutters: everything below is laid out inside this
    static let inner: CGFloat = width - 32

    static let headerH: CGFloat = 22
    /// the one-line column header over the project list. The unit is said here, ONCE.
    static let colHeadH: CGFloat = 14
    static let projectRowH: CGFloat = 40
    static let taskRowH: CGFloat = 30
    static let filterH: CGFloat = 20
    static let footerH: CGFloat = 15
    static let rowGap: CGFloat = 4
    static let blockGap: CGFloat = 7

    static let projectCap = 5
    static let taskCap = 6

    // the column band, right to left. Every one of these is reserved whether or not it has
    // something in it, which is what makes it a column.
    static let strip: CGFloat = 100 // exactly 12 pips at 6pt on a 2.5pt gap, the resolution limit
    /// glyph plus an age, on one line: "52m" must never wrap to "52 / m"
    static let dispatchCol: CGFloat = 42
    /// wide enough for the OPEN label above it, not just for the digits under it
    static let countCol: CGFloat = 34
    static let actions: CGFloat = 36
    static let colGap: CGFloat = 7
    static let padLead: CGFloat = 12
    static let padTrail: CGFloat = 8

    /// gap, hairline, gap, footnote. The card always ends on a line of text over a rule, so a
    /// short list closes on structure rather than trailing off into fill.
    static let footerBlock: CGFloat = blockGap + 1 + 6 + footerH

    // Both levels lay out as: one lead row, n body rows, a zero-height Spacer, the footer block.
    // That is n+3 children and therefore n+2 stack gaps, which is the arithmetic to get right:
    // undercount it and the footnote is clipped off the bottom of the card.
    static func homeBody(rows: Int) -> CGFloat {
        let n = CGFloat(max(1, min(rows, projectCap)))
        return colHeadH + n * projectRowH + footerBlock + (n + 2) * rowGap
    }

    static func projectBody(rows: Int) -> CGFloat {
        let n = CGFloat(max(1, min(rows, taskCap)))
        return filterH + n * taskRowH + footerBlock + (n + 2) * rowGap
    }

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
                .frame(width: Metrics.inner, height: bodyHeight, alignment: .top)
                .opacity(feed.isStale ? 0.55 : 1) // stale numbers must not read as current
                .clipped()
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        // the shape's bottom edge is one seam above the frame's, so an even 12 here leaves the
        // last line 3pt off the card. Pay the seam back.
        .padding(.bottom, 12 + Metrics.seam)
        .frame(width: Metrics.width, alignment: .leading)
        .foregroundStyle(Ink.text)
        .background(
            CardShape(seamAt: seamAt)
                .fill(Ink.card.opacity(0.97))
                // top-lit hairline rather than a flat outline: the one trick that makes a dark
                // card read as a lit object instead of a hole (Raycast's inset-white card edge)
                .overlay(CardShape(seamAt: seamAt).stroke(
                    LinearGradient(colors: [.white.opacity(0.20), .white.opacity(0.05)],
                                   startPoint: .top, endPoint: .bottom),
                    lineWidth: 1))
                .shadow(color: .black.opacity(0.50), radius: 20, y: 8)
        )
        .padding(Metrics.shadowPad)
        // the height is content-driven, so it has to be watchable. Same family of spring as the
        // level swap, so a drill-in reads as one gesture rather than a slide plus a resize.
        .animation(.spring(response: 0.34, dampingFraction: 0.9), value: bodyHeight)
    }

    /// How tall the body actually needs to be for what is in it right now.
    private var bodyHeight: CGFloat {
        switch ui.route {
        case .home:
            return Metrics.homeBody(rows: feed.snap.rows(now: feed.now).count)
        case let .project(id):
            let all = feed.snap.tasks(in: id, now: feed.now)
            let shown = ui.filter == .allOpen ? all : all.filter { $0.isInFlight(feed.now) }
            return Metrics.projectBody(rows: shown.count)
        }
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
    //
    // The wordmark is the one lime thing that is always on screen: it is what stops this reading
    // as a dark debug panel and makes it Darbar's.

    private var header: some View {
        HStack(spacing: 8) {
            switch ui.route {
            case .home:
                Text("DARBAR")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .kerning(1.7)
                    .foregroundStyle(Ink.live.opacity(0.85))
                attention
            case let .project(id):
                BackButton { ui.route = .home }
                Text("DARBAR")
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .kerning(1.4)
                    .foregroundStyle(Ink.live.opacity(0.40))
                Text("/")
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .foregroundStyle(Ink.ghost)
                Text(feed.snap.project(id)?.prefix ?? "?")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(Ink.text)
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
            Chip("\(late.count) overdue · oldest \(ageShort(oldest, now: feed.now))", Ink.late)
                .help(dispatchWhy(oldest, now: feed.now, late: true))
        } else if running > 0 {
            Chip("\(running) running", Ink.live)
        }
    }

    /// The dot is only coloured when it is bad. A green "everything is fine" light is decoration,
    /// and the label next to it already says when the last read was.
    private var syncChip: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(feed.isStale ? Ink.late : Ink.faint)
                .frame(width: 5, height: 5)
            Text(feed.syncLabel)
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(feed.isStale ? Ink.late.opacity(0.9) : Ink.faint)
        }
    }

    private var staleBanner: some View {
        Text(feed.hasEverLoaded
            ? "Showing what darbar said \(relTime(feed.lastSyncedAt ?? feed.now, now: feed.now)), not what is true now. \(feed.lastError ?? "No fresh read since.")"
            : (feed.lastError ?? "Waiting for the first read."))
            .font(.system(size: 10, design: .rounded))
            .foregroundStyle(Ink.late)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 7).fill(Ink.late.opacity(0.13)))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Ink.late.opacity(0.22), lineWidth: 1))
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
        VStack(alignment: .leading, spacing: Metrics.rowGap) {
            columnHeader.stageIn(ui.revealed, order: 1)

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

            FooterRule {
                Footnote(rows.count > Metrics.projectCap
                    ? "+\(rows.count - Metrics.projectCap) more projects"
                    : totals(rows))
                if feed.snap.partial {
                    Footnote("read \(feed.snap.tasks.count) of \(feed.snap.openTotal) open, so these counts are not the whole set", Ink.late)
                }
            }
            .stageIn(ui.revealed, order: Metrics.projectCap + 2)
        }
    }

    /// The unit, said once. Three rows each captioning their own number with a tiny "open" never
    /// formed a column; a label over the column does, and costs a third of the ink.
    private var columnHeader: some View {
        HStack(spacing: Metrics.colGap) {
            Eyebrow("PROJECT").frame(maxWidth: .infinity, alignment: .leading)
            Eyebrow("WORK").frame(width: Metrics.strip, alignment: .leading)
            Color.clear.frame(width: Metrics.dispatchCol)
            Eyebrow("OPEN").frame(width: Metrics.countCol, alignment: .trailing)
            Color.clear.frame(width: Metrics.actions)
        }
        .padding(.leading, Metrics.padLead)
        .padding(.trailing, Metrics.padTrail)
        .frame(height: Metrics.colHeadH)
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
        HStack(spacing: Metrics.colGap) {
            // The name is what you read, so it gets the size and the weight, and it gets the
            // row's slack: everything to its right is a fixed column, so the only thing that
            // flexes is the thing that was truncating with empty room beside it.
            VStack(alignment: .leading, spacing: 0) {
                Text(row.project.prefix)
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .kerning(0.6)
                    .foregroundStyle(Ink.faint)
                Text(row.project.name)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(Ink.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            WorkStrip(spread: row.spread, total: row.open)
                .frame(width: Metrics.strip, alignment: .leading)
                .help(row.spreadWhy)

            // The decaying claim, preserved from the board and from the notch. It used to be a
            // sentence stacked under the strip, which is what left the pips floating with nothing
            // on their line; as a glyph plus its age it sits in the band with everything else.
            dispatchCell
                .frame(width: Metrics.dispatchCol, alignment: .trailing)

            Text("\(row.open)")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(row.open == 0 ? Ink.ghost : Ink.text)
                .frame(width: Metrics.countCol, alignment: .trailing)
                .help("\(row.open) open now, \(row.project.counts?.tasks ?? 0) all time")

            // reserved width whether or not the action is showing, so hover reveals rather than
            // shoves. The chevron stays faintly on at rest: it is what says the row goes somewhere.
            HStack(spacing: 2) {
                IconButton("arrow.up.forward.app", "open this board in a browser") {
                    NSWorkspace.shared.open(boardURL)
                }
                .opacity(hot ? 1 : 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(hot ? Ink.text : Ink.ghost)
                    .frame(width: 14)
            }
            .frame(width: Metrics.actions, alignment: .trailing)
        }
        .padding(.leading, Metrics.padLead)
        .padding(.trailing, Metrics.padTrail)
        .frame(height: Metrics.projectRowH)
        .background(RoundedRectangle(cornerRadius: 8).fill(hot ? Ink.rowHot : Ink.row))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Ink.hairline, lineWidth: 1))
        .overlay(alignment: .leading) {
            if row.oldestLate {
                RoundedRectangle(cornerRadius: 2).fill(Ink.late).frame(width: 3).padding(.vertical, 7)
            }
        }
        .contentShape(Rectangle()) // the whole row is the hover and click target, not the chevron
        .onHover { h in withAnimation(.easeOut(duration: 0.13)) { hovering = h } }
        .onTapGesture(perform: open)
    }

    /// The decaying claim, preserved from the board and from the notch. It used to be a sentence
    /// stacked under the strip, which is what left the pips floating with nothing on their line;
    /// as a glyph plus its age it sits in the band with everything else.
    ///
    /// The empty case is a real Color.clear and not a bare `if` with no else: an HStack drops an
    /// EmptyView child AND its spacing, so the frame around it silently stops reserving the column
    /// and every row's strip slides out from under its own header.
    @ViewBuilder
    private var dispatchCell: some View {
        if row.dispatched > 0, let oldest = row.oldestDispatch {
            HStack(spacing: 3) {
                Image(systemName: "paperplane.fill").font(.system(size: 7.5, weight: .bold))
                Text(ageShort(oldest, now: now))
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }
            .foregroundStyle(row.oldestLate ? Ink.late : Ink.dim)
            .lineLimit(1)
            .fixedSize()
            .help(dispatchWhy(oldest, now: now, late: row.oldestLate))
        } else {
            Color.clear.frame(height: 1)
        }
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
//     you read it exactly: three lime, one red. No estimation, no legend.
//   - once they are not countable, proportion is the only thing left worth showing, so the pips
//     fuse into one proportional bar.
// So the strip changes RESOLUTION at 12 rather than changing chart. Same colours, same slot, same
// width, same left-to-right urgency order, so it never reads as two different widgets.
//
// The slot is now exactly wide enough for the resolution limit: 12 pips at 6pt on a 3pt gap is
// 105pt, and the old 7pt-on-3pt strip needed 117 in a 96pt frame, so a full pip run was clipping.

struct WorkStrip: View {
    let spread: [(Bucket, Int)]
    let total: Int

    private static let pipMax = 12
    private static let pip: CGFloat = 6
    private static let gap: CGFloat = 2.5

    var body: some View {
        HStack(spacing: 0) {
            if total == 0 {
                Capsule().fill(Ink.ghost).frame(width: 20, height: 3)
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
                RoundedRectangle(cornerRadius: 1.5)
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
                    .frame(width: max(3, (Metrics.strip - 6) * CGFloat(n) / CGFloat(total)),
                           height: Self.pip)
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
        let shown = ui.filter == .allOpen ? all : all.filter { $0.isInFlight(feed.now) }
        VStack(alignment: .leading, spacing: Metrics.rowGap) {
            HStack(spacing: 8) {
                Eyebrow(shown.isEmpty ? "" : "\(shown.count) OF \(all.count) OPEN")
                Spacer(minLength: 8)
                Segmented(selection: $ui.filter)
            }
            .padding(.leading, Metrics.padLead)
            .padding(.trailing, Metrics.padTrail)
            .frame(height: Metrics.filterH)

            if shown.isEmpty {
                Text(ui.filter == .inFlight
                    ? "Nothing in flight here. \(all.count) open."
                    : "Nothing open here.")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(Ink.dim)
                    .padding(.leading, Metrics.padLead)
                    .frame(height: Metrics.taskRowH)
            }

            ForEach(Array(shown.prefix(Metrics.taskCap).enumerated()), id: \.element.id) { i, t in
                TaskRow(task: t, now: feed.now)
                    .stageIn(ui.revealed, order: i + 2)
            }

            Spacer(minLength: 0)

            FooterRule {
                Footnote(shown.count > Metrics.taskCap
                    ? "+\(shown.count - Metrics.taskCap) more, the board has them all"
                    : "\(all.count) open on this board")
            }
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
                // subordinate to the title, but this is the string that gets copied into a curl,
                // so it does not go down to eyebrow contrast
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(Ink.dim)
                .frame(width: 70, alignment: .leading)

            Text(task.title)
                .font(.system(size: 12, design: .rounded))
                .foregroundStyle(Ink.text)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let who = task.assignee, !who.isEmpty {
                Text(who)
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(Ink.ghost)
                    .lineLimit(1)
            }

            badge(b)
        }
        .padding(.leading, Metrics.padLead)
        .padding(.trailing, Metrics.padTrail)
        .frame(height: Metrics.taskRowH)
        .background(RoundedRectangle(cornerRadius: 7).fill(Ink.row))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Ink.hairline, lineWidth: 1))
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
                    .fill(feed.isStale ? Ink.ghost : Ink.live)
                    .frame(width: 5, height: 5)
                Text(feed.hasEverLoaded ? "\(feed.snap.running().count)" : "–")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(feed.isStale ? Ink.dim : Ink.text)
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
        .background(
            Capsule().fill(Ink.card.opacity(0.94))
                .overlay(Capsule().stroke(Color.white.opacity(0.10), lineWidth: 1))
                .shadow(color: .black.opacity(0.35), radius: 7, y: 2))
        .help(feed.isStale
            ? "\(feed.syncLabel). \(feed.lastError ?? "")"
            : "\(feed.snap.running().count) running. Click to open the board.")
    }

    private func label(_ symbol: String, _ text: String, _ tint: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 8, weight: .bold))
            Text(text).font(.system(size: 10, weight: .bold, design: .rounded)).monospacedDigit()
        }
        .foregroundStyle(tint)
    }
}

// MARK: - Small parts
//
// Four type sizes across the whole surface: 13 for a row's subject, 11-12 for its prose, 10 for
// metadata, 9 for an eyebrow or a badge. Emphasis is weight and opacity, never a half point.

/// A column or section label. Uppercase, kerned, quiet: the pattern every dense list UI uses to
/// say a unit once instead of repeating it on every row.
struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .kerning(0.7)
            .foregroundStyle(Ink.ghost)
            .lineLimit(1)
    }
}

struct Chip: View {
    let text: String
    let tint: Color

    init(_ text: String, _ tint: Color) { self.text = text; self.tint = tint }

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2.5)
            .background(Capsule().fill(tint.opacity(0.14)))
            .fixedSize()
    }
}

struct Footnote: View {
    let text: String
    var tint: Color = Ink.faint
    init(_ text: String, _ tint: Color = Ink.faint) { self.text = text; self.tint = tint }
    var body: some View {
        Text(text)
            .font(.system(size: 10, design: .rounded))
            .foregroundStyle(tint)
            .lineLimit(1)
    }
}

/// The card's floor: a hairline and one line of footnote, reserved at both levels whether or not
/// there is anything to say. It is what a short list closes on now that the body no longer pads
/// itself out to the tallest case.
struct FooterRule<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Rectangle().fill(Ink.hairline).frame(height: 1)
            HStack(spacing: 6) { content }
                .frame(height: Metrics.footerH, alignment: .leading)
                .padding(.horizontal, Metrics.padLead)
        }
        .padding(.top, Metrics.blockGap)
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
                .foregroundStyle(hot ? Ink.text : Ink.dim)
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
            .foregroundStyle(hot ? Ink.text : Ink.dim)
            .padding(.horizontal, 7)
            .frame(height: 18)
            .background(Capsule().fill(hot ? Ink.rowHot : Ink.row))
            .overlay(Capsule().stroke(Ink.hairline, lineWidth: 1))
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
                        .background(Capsule().fill(selection == f ? Color.white.opacity(0.14) : .clear))
                        .foregroundStyle(selection == f ? Ink.text : Ink.faint)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Capsule().fill(Ink.row))
        .overlay(Capsule().stroke(Ink.hairline, lineWidth: 1))
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
