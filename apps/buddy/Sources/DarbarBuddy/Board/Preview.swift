import AppKit
import SwiftUI

// Renders the board to PNG against LIVE data, the same dev loop the avatars use. It exists because
// the real thing only appears above a floating pet on a desktop, so there is otherwise no way to
// look at a layout without taking over the screen.
//
//   swift run DarbarBuddy --board /tmp/buddy-board
//
// The staged reveal is forced settled here: these are pictures of the landed state, not of the
// animation, which has to be watched on the real thing.

@MainActor
enum BoardPreview {
    static func writeAll(to dir: URL, feed: Feed, ui: UIState) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        ui.carded = true
        ui.revealed = true

        ui.route = .home
        write(card(feed, ui), dir.appendingPathComponent("home.png"))

        // the hover state: whole row lit, both actions revealed in their reserved slot
        ui.forceHotRow = feed.snap.rows(now: feed.now).first?.id
        write(card(feed, ui), dir.appendingPathComponent("home-hover.png"))
        ui.forceHotRow = nil

        // drill into whichever project has the most going on, so the picture is not of an empty list
        if let busiest = feed.snap.rows(now: feed.now).first {
            ui.route = .project(busiest.project._id)
            ui.filter = .inFlight
            write(card(feed, ui), dir.appendingPathComponent("project-inflight.png"))
            ui.filter = .allOpen
            write(card(feed, ui), dir.appendingPathComponent("project-allopen.png"))
            ui.filter = .inFlight
        }

        ui.route = .home
        write(RestingStatus(feed: feed).padding(10), dir.appendingPathComponent("resting.png"))

        // The whole surface as it sits on a desktop: the pet, and the card hanging off its head.
        // These are ImageRenderer renders of the SAME views the panels host, not screenshots, so
        // they are honest about layout and colour and say nothing about the reveal, which only
        // exists in motion and has to be watched on the real thing.
        ui.route = .home
        AppState.shared.boardOpen = false
        // the avatars play an entrance on appear; a still frame has to be told it is over
        RenderMode.snapshot = true
        RenderMode.entranceAge = 6
        write(scene(feed, ui, board: false, hover: false), dir.appendingPathComponent("scene-resting.png"))
        write(scene(feed, ui, board: false, hover: true), dir.appendingPathComponent("scene-hover.png"))
        AppState.shared.boardOpen = true
        write(scene(feed, ui, board: true, hover: true), dir.appendingPathComponent("scene-home.png"))
        if let busiest = feed.snap.rows(now: feed.now).first {
            ui.route = .project(busiest.project._id)
            write(scene(feed, ui, board: true, hover: true), dir.appendingPathComponent("scene-project.png"))
            ui.route = .home
        }
        AppState.shared.boardOpen = false

        print("wrote \((try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.sorted().joined(separator: ", ") ?? "") to \(dir.path)")
    }

    /// pet panel is 320 wide, card is 470, so the pet's head sits at 0.5 of a centred card. The
    /// negative padding is the same expression BoardPanelController.place() uses, so the picture
    /// and the real window agree about how far the card hangs over the pet's panel.
    private static func scene(_ feed: Feed, _ ui: UIState, board: Bool, hover: Bool) -> some View {
        let drop = PetAnchor.pillDrop(AppState.shared.petScale) - Motion.petGap
        return VStack(spacing: 0) {
            if board {
                BoardCard(feed: feed, ui: ui, seamAt: 0.5)
                    .padding(.bottom, -(drop + Metrics.shadowPad))
            } else {
                Color.clear.frame(width: Metrics.width, height: 1)
            }
            RootView(feed: feed, forceHover: hover)
                .frame(width: 200 * 1.2 + 80, height: 220 * 1.2 + 58)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 20)
    }

    private static func card(_ feed: Feed, _ ui: UIState) -> some View {
        BoardCard(feed: feed, ui: ui, seamAt: 0.5).padding(14)
    }

    private static func write(_ view: some View, _ url: URL) {
        let renderer = ImageRenderer(content: view.background(Color(white: 0.09)))
        renderer.scale = 2
        guard let cg = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
        else {
            print("could not render \(url.lastPathComponent)")
            return
        }
        try? png.write(to: url)
    }
}
