import AppKit
import Combine
import ImageIO
import SwiftUI

// MARK: - Offline render modes (the art QA loop)
//
// Carried over from coplanner-buddy, minus the half of it that had nothing left to work on. The
// original also had --cutout / --head / --videoframes / --headframes / --toon / --measure / --bodies:
// a Vision face-landmark pipeline whose entire purpose was turning a photo of a colleague into the
// Stache avatar. Stache did not come across, so neither did the machine that made it, and with it
// went the AVFoundation and Vision imports and the resource bundle.
//
// What is left is the loop for the art that DID come across: render the vector cast to PNG, or one
// avatar's motion to a filmstrip or a GIF. There is deliberately no --demo: the notch build left a
// demo loop cycling its reveal on Raj's screen until someone killed it.

@MainActor
func renderAvatarFrame(_ avatar: AvatarID, tt: Double) -> CGImage? {
    RenderMode.snapshot = true
    RenderMode.entranceAge = tt // et tracks t so entrances play through the range
    let content = avatar.view(t: tt)
        .frame(width: 220, height: 240)
        .background(Color(red: 0.35, green: 0.35, blue: 0.4))
    let renderer = ImageRenderer(content: content)
    renderer.scale = 1
    return renderer.cgImage
}

@MainActor
func snapshotAvatars(to dir: URL, at sampleT: Double) {
    RenderMode.snapshot = true
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for avatar in AvatarID.allCases {
        // Sample a mid-animation moment so limbs and rings are not at rest pose
        let content = avatar.view(t: sampleT)
            .frame(width: 220, height: 240)
            .background(Color(red: 0.35, green: 0.35, blue: 0.4))
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        if let img = renderer.nsImage, let tiff = img.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent("\(avatar.rawValue).png"))
            print("rendered \(avatar.rawValue).png")
        } else {
            print("FAILED to render \(avatar.rawValue)")
        }
    }
    let picker = ImageRenderer(content: AvatarPickerView().padding(12)
        .background(Color(red: 0.35, green: 0.35, blue: 0.4)))
    picker.scale = 2
    if let img = picker.nsImage, let tiff = img.tiffRepresentation,
       let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: dir.appendingPathComponent("_picker.png"))
        print("rendered _picker.png")
    }
}

@MainActor
func filmstrip(out: String, t0: Double, t1: Double, n: Int, avatar: AvatarID) {
    let fw = 220, fh = 240
    guard let ctx = CGContext(data: nil, width: fw * n, height: fh, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
    for k in 0 ..< n {
        let tt = t0 + (t1 - t0) * Double(k) / Double(max(1, n - 1))
        if let cg = renderAvatarFrame(avatar, tt: tt) {
            ctx.draw(cg, in: CGRect(x: k * fw, y: 0, width: fw, height: fh))
        }
    }
    if let img = ctx.makeImage(),
       let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: out))
        print("filmstrip written: \(out)")
    }
}

@MainActor
func gif(out: String, t0: Double, t1: Double, fps: Double, avatar: AvatarID) {
    let n = Int((t1 - t0) * fps)
    guard let dest = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: out) as CFURL, "com.compuserve.gif" as CFString, n, nil) else { return }
    CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [
        kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
    let frameProps = [kCGImagePropertyGIFDictionary: [
        kCGImagePropertyGIFDelayTime: 1.0 / fps]] as CFDictionary
    for k in 0 ..< n {
        if let cg = renderAvatarFrame(avatar, tt: t0 + Double(k) / fps) {
            CGImageDestinationAddImage(dest, cg, frameProps)
        }
    }
    CGImageDestinationFinalize(dest)
    print("gif written: \(out) (\(n) frames)")
}

do {
    let a = CommandLine.arguments

    if let i = a.firstIndex(of: "--avatars"), a.count > i + 1 {
        let dir = URL(fileURLWithPath: a[i + 1])
        let sampleT = a.count > i + 2 ? (Double(a[i + 2]) ?? 1.35) : 1.35
        if a.count > i + 3, let tapAge = Double(a[i + 3]) { AppState.lastTapAt = sampleT - tapAge }
        if a.count > i + 4, let entranceAge = Double(a[i + 4]) { RenderMode.entranceAge = entranceAge }
        MainActor.assumeIsolated { snapshotAvatars(to: dir, at: sampleT) }
        exit(0)
    }

    if let i = a.firstIndex(of: "--filmstrip"), a.count > i + 4 {
        let avatar = a.count > i + 5 ? (AvatarID(rawValue: a[i + 5]) ?? .orbie) : .orbie
        if a.count > i + 6, let tapT = Double(a[i + 6]) { AppState.lastTapAt = tapT; AppState.orbieToggleAt = tapT }
        MainActor.assumeIsolated {
            filmstrip(out: a[i + 1], t0: Double(a[i + 2]) ?? 0, t1: Double(a[i + 3]) ?? 4,
                      n: Int(a[i + 4]) ?? 10, avatar: avatar)
        }
        exit(0)
    }

    if let i = a.firstIndex(of: "--gif"), a.count > i + 4 {
        let avatar = a.count > i + 5 ? (AvatarID(rawValue: a[i + 5]) ?? .orbie) : .orbie
        if a.count > i + 6, let tapT = Double(a[i + 6]) { AppState.lastTapAt = tapT; AppState.orbieToggleAt = tapT }
        MainActor.assumeIsolated {
            gif(out: a[i + 1], t0: Double(a[i + 2]) ?? 0, t1: Double(a[i + 3]) ?? 4,
                fps: Double(a[i + 4]) ?? 15, avatar: avatar)
        }
        exit(0)
    }
}

// MARK: - App

final class DraggableHostingView<Content: View>: NSHostingView<Content> {
    override var mouseDownCanMoveWindow: Bool { true }
}

final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let feed = Feed()
    let ui = UIState()
    let state = AppState.shared

    var panel: PetPanel!
    private var board: BoardPanelController!
    private var statusItem: NSStatusItem!
    private var bag = Set<AnyCancellable>()

    // Fixed at the LARGEST preset: cycling sizes never moves the window or controls
    static let fixedSize = NSSize(width: 200 * 1.2 + 80, height: 220 * 1.2 + 58)

    func applicationDidFinishLaunching(_: Notification) {
        // --board <dir>: one read, render the board surfaces to PNG, exit. No pet, no pointer.
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--board"), args.count > i + 1 {
            let dir = URL(fileURLWithPath: args[i + 1])
            let feed = feed, ui = ui
            Task {
                await feed.refresh()
                BoardPreview.writeAll(to: dir, feed: feed, ui: ui)
                NSApp.terminate(nil)
            }
            return
        }

        let size = Self.fixedSize
        panel = PetPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true

        let host = DraggableHostingView(rootView: RootView(feed: feed))
        host.frame = NSRect(origin: .zero, size: size)
        panel.contentView = host

        // Its own autosave name and its own bundle id, so this and the CoPlanner build can sit on
        // the same desktop without arguing about where the pet lives or which avatar is chosen.
        if !panel.setFrameUsingName("DarbarBuddy") {
            if let screen = NSScreen.main {
                let f = screen.visibleFrame
                panel.setFrameOrigin(NSPoint(x: f.maxX - size.width - 24, y: f.minY + 12))
            }
        }
        panel.setContentSize(size) // autosave may restore a stale frame; enforce ours
        panel.setFrameAutosaveName("DarbarBuddy")
        panel.orderFrontRegardless()

        board = BoardPanelController(feed: feed, ui: ui, pet: panel)

        // One flag drives the board from anywhere: the pill button, the resting pill, the status
        // menu, and the controller's own escape and click-outside dismissals.
        state.$boardOpen
            .removeDuplicates()
            .sink { [weak self] open in
                guard let self else { return }
                open ? self.board.open() : self.board.close()
            }
            .store(in: &bag)
        // dragging the pet, or cycling its size, both move where the card has to hang
        NotificationCenter.default.publisher(for: NSWindow.didMoveNotification, object: panel)
            .sink { [weak self] _ in self?.board.place() }
            .store(in: &bag)
        state.$petScale
            .removeDuplicates()
            .sink { [weak self] _ in
                DispatchQueue.main.async { self?.board.place() }
            }
            .store(in: &bag)

        feed.start()
        installStatusItem()

        // --reveal: open the board ONCE, shortly after launch, so the real window can be
        // photographed without driving the pointer. Deliberately a one-shot and not a demo loop:
        // the notch build left a loop cycling its reveal on Raj's screen until it was killed.
        if args.contains("--reveal") {
            Task {
                try? await Task.sleep(for: .seconds(1.2))
                state.boardOpen = true
                try? await Task.sleep(for: .seconds(1.2))
                // printed because a machine without Screen Recording permission cannot photograph
                // its own desktop, and "the card is on screen, this size, at these coordinates" is
                // still checkable from here
                board.report()
            }
        }
    }

    // An LSUIElement app has no dock icon and no window chrome. The pet's own pill can quit it, but
    // the menu bar is the way back if the pet is dragged somewhere silly, plus a way to force a read.
    private func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "sparkles", accessibilityDescription: "Darbar Buddy")
        let menu = NSMenu()
        menu.addItem(withTitle: "Show the board", action: #selector(showBoard), keyEquivalent: "b").target = self
        menu.addItem(withTitle: "Read the board now", action: #selector(refreshNow), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Bring the buddy home", action: #selector(recenter), keyEquivalent: "h").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Darbar Buddy", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
    }

    @objc private func showBoard() { state.boardOpen = true }
    @objc private func refreshNow() { Task { await feed.refresh() } }

    @objc private func recenter() {
        guard let screen = NSScreen.main else { return }
        let f = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: f.maxX - Self.fixedSize.width - 24, y: f.minY + 12))
        board.place()
    }

    @objc private func quit() {
        feed.stop()
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// assumeIsolated because top-level code is not implicitly main-actor under the v5 language mode
// this package builds in, and the delegate is.
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
