import WorkerDeckKit
import Foundation
import Observation

/// The app's unread memory: the kit's `Watermarks` (the shared monotonic rules)
/// backed by UserDefaults, wrapped so views re-derive when a mark moves.
///
/// The rules — monotonicity, the once-a-minute touch, the 30-day prune, and
/// `unseenCount`'s rows-not-turns arithmetic — live in the kit as a port of
/// `packages/protocol/src/watermarks.ts`, because the VS Code extension and the
/// dashboard count unread the same way and a second implementation would drift.
/// All that is iOS-shaped is where the marks are kept, and the `revision`
/// counter: `Watermarks` is not observable, so reading a count through here is
/// what lets a badge learn that answering a prompt just cleared it — reading
/// rows is silent (no poll, no event), and `mark`'s return value is the only
/// signal there is.
@MainActor
@Observable
final class UnreadModel {
  private static let key = "bi.atomic.workerdeck.ios.watermarks"

  private let marks: Watermarks
  /// Bumped whenever a mark moves, so Observation re-runs anything that read a
  /// count through this model.
  private(set) var revision = 0

  init(defaults: UserDefaults = .standard) {
    marks = Watermarks(
      store: WatermarkStore(
        read: {
          defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode([String: Watermark].self, from: $0) }
        },
        write: { updated in
          guard let data = try? JSONEncoder().encode(updated) else { return }
          defaults.set(data, forKey: Self.key)
        }))
  }

  /// Record what is on screen now. Callers own the "genuinely on screen" test —
  /// the session view visible and showing it — because that is a fact about the
  /// UI, not about storage.
  @discardableResult
  func mark(host: UUID, sessionId: String, itemCount: Int?, activity: Int?, turns: Int?) -> Bool {
    let moved = marks.mark(
      hostId: host.uuidString, sessionId: sessionId, itemCount: itemCount, activity: activity,
      turns: turns)
    if moved { revision &+= 1 }
    return moved
  }

  /// Rows this phone has not seen, from the rollup alone.
  func unseen(host: UUID, info: SessionInfo) -> Int {
    // Registers the dependency: a mark written by the session screen must
    // re-derive every list that counted through this model.
    _ = revision
    return unseenCount(
      mark: marks.get(hostId: host.uuidString, sessionId: info.id), info: info)
  }

  /// The session was deleted; its mark is now noise.
  func forget(host: UUID, sessionId: String) {
    marks.forget(hostId: host.uuidString, sessionId: sessionId)
    revision &+= 1
  }
}
