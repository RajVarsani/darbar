import AppKit
import Combine
import SwiftUI

// MARK: - Motion
//
// The buddy already had two ways of showing more of itself, and the brief was to study them before
// inventing a third. They are: the hover pill, which scales up from its bottom edge over the pet's
// head, and the avatar picker, which is a popover in its OWN window so a 250pt grid can escape a
// tiny panel. The board is the second of those two: a separate window, anchored to the pet, so the
// pet's panel stays the size of the pet. It is not a popover only because AppKit's popover owns its
// own fade and this reveal is the part Raj asked for.
//
// The gesture: the card pours up out of the pet's head, settles with a little weight, and only then
// does the content arrive, row behind row. The spring numbers are the ones tuned on the notch build
// rather than new guesses:
//
//  - opening: response 0.42 is slow enough to read as liquid rather than a popup, and damping 0.72
//    leaves one soft overshoot so it looks like it has mass. Anything tighter snaps, and a snap
//    reads as broken.
//  - closing: faster and critically damped. An exit that bounces looks indecisive, and you are
//    already looking somewhere else by then.
//  - the content stage is a separate spring in StageIn, starting 0.10s in, which is roughly when
//    the card has stopped moving.
//
// The one thing added here that the notch could not have: the card is anchored to the pet's head
// and carries a tail pointing at it, and the pet hops as it opens. A panel that merely appears near
// a cartoon is a panel; a panel the cartoon visibly produced is the buddy.
enum Motion {
    static let open: Animation = .spring(response: 0.42, dampingFraction: 0.72)
    static let close: Animation = .spring(response: 0.26, dampingFraction: 1.0)
    static let stageDelay: TimeInterval = 0.06
    /// how long the closing spring needs before the window can be ordered out unseen
    static let closeSettle: TimeInterval = 0.30
    /// gap between the top of the hover pill and the tip of the card's tail
    static let petGap: CGFloat = 4
    static let screenMargin: CGFloat = 10
}

/// Where the top of the buddy actually is.
///
/// The pet's panel is fixed at the LARGEST preset so cycling sizes never moves the window, which
/// means at any smaller size the panel's top edge is well above the pet's head and pointing a tail
/// at it would point at nothing. The hover pill already solves this with the same expression, so
/// the card reuses it rather than inventing a second answer that can drift from the first.
enum PetAnchor {
    static func pillDrop(_ scale: CGFloat) -> CGFloat { 110 * (DragHandle.sizes.last! - scale) }
}

// MARK: - The hosted card
//
// `shown` drives the card's own transform, `ui.revealed` drives the rows. Two flags rather than one
// because the whole point of the reveal is that they are not simultaneous.

struct BoardShell: View {
    @ObservedObject var feed: Feed
    @ObservedObject var ui: UIState
    var seamAt: CGFloat
    var onSize: (CGSize) -> Void

    var body: some View {
        let shown = ui.carded
        BoardCard(feed: feed, ui: ui, seamAt: seamAt)
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { onSize(g.size) }
                    .onChange(of: g.size) { _, new in onSize(new) }
            })
            .scaleEffect(shown ? 1 : 0.90, anchor: .bottom)
            .offset(y: shown ? 0 : 22)
            .opacity(shown ? 1 : 0)
            .blur(radius: shown ? 0 : 7)
            .animation(shown ? Motion.open : Motion.close, value: shown)
            // level changes animate the swap, never the box: Metrics.bodyH is fixed, so this
            // spring only ever moves the contents of a stationary card
            .animation(.spring(response: 0.36, dampingFraction: 0.88), value: ui.route)
            .animation(.spring(response: 0.30, dampingFraction: 0.9), value: ui.filter)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }
}

private final class BoardWindow: NSPanel {
    override var canBecomeKey: Bool { true }
}

// MARK: - Controller

@MainActor
final class BoardPanelController {
    private let feed: Feed
    private let ui: UIState
    private unowned let pet: NSPanel

    private var window: BoardWindow!
    private var cardSize: CGSize = .zero
    private var seamAt: CGFloat = 0.5
    private var escMonitor: Any?
    private var outsideMonitor: Any?
    private var closeTask: Task<Void, Never>?
    private var bag = Set<AnyCancellable>()

    private(set) var isOpen = false

    init(feed: Feed, ui: UIState, pet: NSPanel) {
        self.feed = feed
        self.ui = ui
        self.pet = pet
        build()

        // Escape is wired to the route rather than to a view callback, so every way into a project
        // (row click, chevron) arms it identically. At home, escape closes the board.
        ui.$route
            .removeDuplicates()
            .sink { [weak self] _ in self?.refreshEscape() }
            .store(in: &bag)
    }

    private func build() {
        window = BoardWindow(contentRect: NSRect(x: 0, y: 0, width: Metrics.width, height: 320),
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false // the card draws its own, so the shadow can follow the tail
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hidesOnDeactivate = false
        window.contentView = NSHostingView(rootView: shell())
    }

    private func shell() -> BoardShell {
        BoardShell(feed: feed, ui: ui, seamAt: seamAt) { [weak self] size in
            guard let self, size != self.cardSize else { return }
            self.cardSize = size
            self.place()
        }
    }

    // MARK: open / close

    func toggle() { isOpen ? close() : open() }

    func open() {
        guard !isOpen else { return }
        closeTask?.cancel()
        isOpen = true
        ui.revealed = false // content starts hidden so it can arrive after the card lands
        place()
        pet.addChildWindow(window, ordered: .above)
        window.orderFrontRegardless()
        // A nonactivating panel can hold key focus without the app becoming frontmost, which is the
        // only way escape can reach us; addChildWindow hands key to the PARENT, so it is taken back
        // here, after the ordering has settled.
        window.makeKeyAndOrderFront(nil)
        ui.carded = true
        refreshEscape()
        watchOutsideClicks()
        Task {
            try? await Task.sleep(for: .seconds(Motion.stageDelay))
            guard isOpen else { return }
            ui.revealed = true
        }
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        ui.revealed = false
        ui.carded = false
        dropEscape()
        dropOutsideWatch()
        closeTask = Task {
            try? await Task.sleep(for: .seconds(Motion.closeSettle))
            guard !Task.isCancelled, !isOpen else { return }
            pet.removeChildWindow(window)
            window.orderOut(nil)
            // coming back to a board you drilled into an hour ago and left open on someone else's
            // project is worse than always starting at home
            ui.reset()
        }
    }

    // MARK: placement
    //
    // The card hangs above the pet's panel with its tail aimed at the pet's head. When the pet is
    // near a screen edge the card slides to stay on screen, and the tail slides the other way
    // inside it, so it keeps pointing at the pet rather than at where the pet would have been.

    func place() {
        guard cardSize.width > 1, cardSize.height > 1 else { return }
        let petFrame = pet.frame
        let screen = pet.screen ?? NSScreen.main ?? NSScreen.screens[0]
        let vis = screen.visibleFrame

        var x = petFrame.midX - cardSize.width / 2
        x = min(max(x, vis.minX + Motion.screenMargin), vis.maxX - cardSize.width - Motion.screenMargin)
        // the tail tip sits just above where the hover pill sits, and the window's bottom edge is
        // one shadow margin below the tip
        let tailTip = petFrame.maxY - PetAnchor.pillDrop(AppState.shared.petScale) + Motion.petGap
        var y = tailTip - Metrics.shadowPad
        y = min(y, vis.maxY - cardSize.height - Motion.screenMargin)
        y = max(y, vis.minY + Motion.screenMargin)

        window.setFrame(NSRect(x: x, y: y, width: cardSize.width, height: cardSize.height),
                        display: true)

        let want = (petFrame.midX - x) / cardSize.width
        let clamped = min(max(want, 0.10), 0.90)
        if abs(clamped - seamAt) > 0.004 {
            seamAt = clamped
            rehost()
        }
    }

    /// The seam position is a plain value on the shape, not state, so moving it means re-rooting
    /// the hosting view. It only happens when the pet is dragged across an edge, so the cost is a
    /// non-issue and the alternative is another ObservableObject for one CGFloat.
    private func rehost() {
        (window.contentView as? NSHostingView<BoardShell>)?.rootView = shell()
    }

    /// One line of ground truth about the live window, for checking the panel from a terminal.
    func report() {
        let s = pet.screen ?? NSScreen.main
        // stderr, not stdout: an LSUIElement launched into a pipe block-buffers stdout, so a
        // diagnostic printed there never arrives while the app is still running
        FileHandle.standardError.write(Data("""
        board open=\(isOpen) visible=\(window.isVisible) key=\(window.isKeyWindow) \
        card=\(Int(window.frame.width))x\(Int(window.frame.height)) \
        at=(\(Int(window.frame.minX)),\(Int(window.frame.minY))) seamAt=\(String(format: "%.2f", seamAt))
        pet at=(\(Int(pet.frame.minX)),\(Int(pet.frame.minY))) size=\(Int(pet.frame.width))x\(Int(pet.frame.height)) \
        visible=\(pet.isVisible) screen=\(s.map { "\(Int($0.visibleFrame.width))x\(Int($0.visibleFrame.height))" } ?? "none")
        card sits fully on screen: \(s.map { $0.visibleFrame.contains(window.frame) } ?? false)

        """.utf8))
    }

    // MARK: keyboard
    //
    // The board panel is non-activating and asks for key focus, which costs nothing: it never makes
    // the app frontmost, so it cannot steal typing from whatever is in front. It also does not
    // reliably GET keystrokes for the same reason. Checked live: with the app inactive the card
    // opens with isKeyWindow false, and a local monitor only sees events routed to this app.
    //
    // So escape is a bonus, not the affordance. Every level has a visible way out (the back button,
    // a click anywhere else, the pill button that opened it), and the back button is labelled
    // "back" rather than "esc" because a key hint that works sometimes is worse than none.

    private func refreshEscape() {
        guard isOpen else { return dropEscape() }
        guard escMonitor == nil else { return }
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, e.keyCode == 53 else { return e } // 53 = escape
            if case .project = self.ui.route {
                self.ui.route = .home
            } else {
                self.close()
            }
            return nil
        }
    }

    private func dropEscape() {
        if let m = escMonitor { NSEvent.removeMonitor(m); escMonitor = nil }
    }

    /// Same dismissal as the avatar picker: a click anywhere else puts it away. Without this the
    /// board is the only thing on the desktop you have to go back and switch off.
    private func watchOutsideClicks() {
        guard outsideMonitor == nil else { return }
        outsideMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                guard let self else { return }
                let p = NSEvent.mouseLocation
                if !self.window.frame.contains(p), !self.pet.frame.contains(p) { self.close() }
            }
    }

    private func dropOutsideWatch() {
        if let m = outsideMonitor { NSEvent.removeMonitor(m); outsideMonitor = nil }
    }
}
