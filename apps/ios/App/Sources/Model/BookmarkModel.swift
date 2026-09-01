import WorkerDeckKit
import Foundation
import Observation

/// The reader's bookmarks: the kit's `Bookmarks` (the web client's
/// `workerdeck.bookmarks.v1` semantics — per-session item ids) backed by
/// UserDefaults, wrapped so views re-derive when one is toggled.
///
/// The shape is `UnreadModel`'s, deliberately: the rules live in the kit where
/// `swift test` can reach them, and all that is iOS-shaped is where the map is
/// kept and the `revision` counter — `Bookmarks` is not observable, so reading
/// a set through here is what lets the rail learn that a long-press just
/// starred a row. Storage stays local to this phone, as the web's stays local
/// to its browser: a bookmark is the reader's annotation, not the session's.
@MainActor
@Observable
final class BookmarkModel {
  private static let key = "bi.atomic.workerdeck.ios.bookmarks"

  private let marks: Bookmarks
  /// Bumped whenever a mark is toggled, so Observation re-runs anything that
  /// read a set through this model.
  private(set) var revision = 0

  init(defaults: UserDefaults = .standard) {
    marks = Bookmarks(
      store: BookmarkStore(
        read: {
          defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode([String: [String]].self, from: $0) }
        },
        write: { updated in
          guard let data = try? JSONEncoder().encode(updated) else { return }
          defaults.set(data, forKey: Self.key)
        }))
  }

  /// One session's bookmarked item ids, in the order they were set.
  func bookmarks(host: UUID, sessionId: String) -> [String] {
    // Registers the dependency: a toggle from the row menu must re-derive the
    // rail that drew (or didn't draw) this mark.
    _ = revision
    return marks.bookmarks(hostId: host.uuidString, sessionId: sessionId)
  }

  func toggle(host: UUID, sessionId: String, itemId: String) {
    marks.toggle(hostId: host.uuidString, sessionId: sessionId, itemId: itemId)
    revision &+= 1
  }
}
