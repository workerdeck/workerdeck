import Foundation
@preconcurrency import WorkerDeckSession

/// Where the core keeps closed sessions' transcripts between launches, so the first open after
/// a relaunch resumes instead of replaying the whole log.
enum TranscriptStore {
  static func start() {
    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    else { return }
    setTranscriptStore(dir: caches.appendingPathComponent("transcripts").path, build: build)
  }

  /// The executable's date joins version and build: a dev install keeps its build number.
  private static var build: String {
    let info = Bundle.main.infoDictionary ?? [:]
    let date = Bundle.main.executableURL
      .flatMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]) }?
      .contentModificationDate?.timeIntervalSince1970 ?? 0
    let version = info["CFBundleShortVersionString"] as? String ?? ""
    let number = info["CFBundleVersion"] as? String ?? ""
    return "\(version) (\(number)) \(Int(date))"
  }
}
