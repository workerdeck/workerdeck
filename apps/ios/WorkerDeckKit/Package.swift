// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WorkerDeckKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "WorkerDeckKit", targets: ["WorkerDeckKit"])
  ],
  targets: [
    .target(name: "WorkerDeckKit"),
    .testTarget(name: "WorkerDeckKitTests", dependencies: ["WorkerDeckKit"]),
  ]
)
