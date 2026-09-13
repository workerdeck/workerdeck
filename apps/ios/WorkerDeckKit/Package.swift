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
  ],
  targets: [
    .target(name: "WorkerDeckKit"),
    .target(name: "WorkerDeckActivity"),
    .testTarget(name: "WorkerDeckKitTests", dependencies: ["WorkerDeckKit"]),
    .testTarget(
      name: "WorkerDeckActivityTests", dependencies: ["WorkerDeckActivity"],
      resources: [.copy("Fixtures")]),
  ]
)
