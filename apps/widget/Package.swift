// swift-tools-version:5.9
import PackageDescription

// apps/widget — the always-there macOS menu bar glance. A THIN CLIENT over the daemon
// (OpenClaw's gateway pattern, docs/inspiration.md): it renders the state the daemon owns,
// never its own. No external deps — only system frameworks — so `swift build` needs no network.
let package = Package(
    name: "oo-widget",
    platforms: [.macOS(.v13)], // MenuBarExtra(.window) lands in macOS 13
    targets: [
        .executableTarget(name: "oo-widget", path: "Sources/oo-widget"),
    ]
)
