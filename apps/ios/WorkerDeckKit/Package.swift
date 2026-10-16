// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WorkerDeckKit",
  platforms: [.iOS(.v18), .macOS(.v14)],
  products: [
    .library(name: "WorkerDeckKit", targets: ["WorkerDeckKit"]),
    // Deliberately not part of WorkerDeckKit: the Live Activity payload is a
    // contract with the CLI's APNs forwarder, not with `packages/protocol`, and
    // the widget extension must link it without dragging the transcript
    // reducer and the terminal renderer into a memory-capped process.
    .library(name: "WorkerDeckActivity", targets: ["WorkerDeckActivity"]),
    // The Rust core, built into Native/ (gitignored) by `scripts/build-core.sh`.
    .library(name: "WorkerDeckSession", targets: ["WorkerDeckSession"]),
  ],
  targets: [
    .target(name: "WorkerDeckKit", dependencies: ["WorkerDeckCore"]),
    .target(name: "WorkerDeckActivity"),
    .testTarget(name: "WorkerDeckKitTests", dependencies: ["WorkerDeckKit", "WorkerDeckCore"]),
    .testTarget(
      name: "WorkerDeckActivityTests", dependencies: ["WorkerDeckActivity"],
      resources: [.copy("Fixtures")]),
    .binaryTarget(name: "WorkerDeckCoreFFI", path: "Native/WdFFI.xcframework"),
    .target(
      name: "WorkerDeckCore", dependencies: ["WorkerDeckCoreFFI"], path: "Native/Bindings",
      swiftSettings: [.swiftLanguageMode(.v5)]),
    .target(name: "WorkerDeckSession", dependencies: ["WorkerDeckCore"]),
    .testTarget(name: "WorkerDeckCoreTests", dependencies: ["WorkerDeckCore"]),
    .testTarget(name: "WorkerDeckSessionTests", dependencies: ["WorkerDeckSession"]),
  ]
)
