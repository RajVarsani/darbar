import SwiftUI

// The cast, carried over from coplanner-buddy minus Stache.
//
// Stache is a photographic cutout of a colleague plus a 120-frame flipbook of him laughing and the
// audio to go with it. It is 9.1MB of the 9.3MB of art in the original, it is the only thing in
// the package that needs a resource bundle, and it is a real person's likeness that was made for
// one app and shared with one team. None of those three is a reason to put it in this repo, so the
// avatar, its bodies, and the Vision pipeline that produced it all stayed behind. What crossed is
// the vector cast: pure SwiftUI paths, no bytes on disk, and all eight are shipping here because
// benching six of them only made sense when Stache was the other half of the pair.

enum AvatarID: String, CaseIterable, Identifiable {
    case orbie, cappy, pip, sage, nova, bolt, mochi, ringo
    var id: String { rawValue }

    static let active: [AvatarID] = allCases

    var name: String {
        switch self {
        case .orbie: "Orbie"
        case .cappy: "Cappy"
        case .pip: "Pip"
        case .sage: "Sage"
        case .nova: "Nova"
        case .bolt: "Bolt"
        case .mochi: "Mochi"
        case .ringo: "Ringo"
        }
    }

    var tagline: String {
        switch self {
        case .orbie: "The planet with a plan"
        case .cappy: "Chief vibes analyst"
        case .pip: "A letter that learned to fly"
        case .sage: "Has read every factsheet"
        case .nova: "The sentient sparkle"
        case .bolt: "Tiny copilot, big energy"
        case .mochi: "Squishy ghost intern"
        case .ringo: "Stole Saturn's ring, no regrets"
        }
    }

    @ViewBuilder
    func view(t: Double) -> some View {
        switch self {
        case .orbie: OrbieView(t: t)
        case .cappy: CappyView(t: t)
        case .pip: PipView(t: t)
        case .sage: SageView(t: t)
        case .nova: NovaView(t: t)
        case .bolt: BoltView(t: t)
        case .mochi: MochiView(t: t)
        case .ringo: RingoView(t: t)
        }
    }
}

final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var selected: AvatarID {
        didSet { UserDefaults.standard.set(selected.rawValue, forKey: "avatar") }
    }
    @Published var pickerOpen = false

    /// The board panel. Owned here rather than by the view so the pet can react to it opening
    /// (it is the thing the board comes out of) and the delegate can drive the window from it.
    @Published var boardOpen = false

    /// Pet size multiplier, Typibara-style resize. Persisted.
    @Published var petScale: CGFloat {
        didSet { UserDefaults.standard.set(petScale, forKey: "petScale") }
    }

    // Wall-clock tap time; TimelineView's t is the same clock, so avatars compare directly
    nonisolated(unsafe) static var lastTapAt: Double = -1e9

    // Orbie's form toggle: true = Saturn, false = CoPlanner mark. Clicks flip it.
    nonisolated(unsafe) static var orbieSaturn = true
    nonisolated(unsafe) static var orbieToggleAt: Double = -1e9

    private init() {
        let saved = UserDefaults.standard.string(forKey: "avatar").flatMap(AvatarID.init(rawValue:))
        selected = saved ?? .orbie
        let s = UserDefaults.standard.double(forKey: "petScale")
        petScale = s > 0 ? min(1.2, max(0.85, s)) : 1.0
    }
}
