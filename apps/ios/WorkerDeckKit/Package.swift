// swift-tools-version: 6.0
import Foundation
import PackageDescription

// The Rust core joins once `scripts/build-core.sh` has built it into Native/ (gitignored), so an app-only checkout
// still builds without cargo.
let nativeCore = FileManager.default.fileExists(
  atPath: Context.packageDirectory + "/Native/WdFFI.xcframework/Info.plist")

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

if nativeCore {
  package.products.append(.library(name: "WorkerDeckCore", targets: ["WorkerDeckCore"]))
  package.targets += [
    .binaryTarget(name: "WorkerDeckCoreFFI", path: "Native/WdFFI.xcframework"),
    .target(
      name: "WorkerDeckCore", dependencies: ["WorkerDeckCoreFFI"], path: "Native/Bindings",
      swiftSettings: [.swiftLanguageMode(.v5)]),
    .testTarget(name: "WorkerDeckCoreTests", dependencies: ["WorkerDeckCore"]),
  ]
}
