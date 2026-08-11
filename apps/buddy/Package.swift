// swift-tools-version: 6.0
import PackageDescription

// DarbarBuddy: the desktop surface for Darbar (DAR-246). A copy of coplanner-buddy's pet, with
// the notch's board grafted on. Not a Bun workspace; the root package.json globs apps/*, but Bun
// only claims directories containing a package.json, so this one is invisible to `bun install`.
//
// No dependencies at all. The pet is hand-drawn SwiftUI vector art and the board is URLSession
// against loopback, so a build needs nothing from the network and there is no Package.resolved.
//
// Language mode v5 on purpose: the avatar code came from a 5.10 package and reads NSApp from
// global helpers (Components.cursorGazeVector). Under the v6 mode those become actor-isolation
// errors, and rewriting inherited art code to satisfy strict concurrency is a rewrite of exactly
// the thing this task was told to carry over rather than rewrite.
let package = Package(
    name: "DarbarBuddy",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "DarbarBuddy",
            path: "Sources/DarbarBuddy",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
