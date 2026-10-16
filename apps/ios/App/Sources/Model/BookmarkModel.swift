import Foundation
import Observation
import WorkerDeckCore

// The reader's bookmarks: the core's `Bookmarks` (the web's `workerdeck.bookmarks.v1` semantics, per-session item ids)
// kept in UserDefaults in the kit's old format. Local to this phone: a bookmark is the reader's annotation, not the
// session's. `revision` is what Observation sees, so the rail redraws after a long-press toggles a row.
@MainActor
@Observable
final class BookmarkModel {
  private static let key = "bi.atomic.workerdeck.ios.bookmarks"

  private let marks: WorkerDeckCore.Bookmarks
  private let defaults: UserDefaults
  private(set) var revision = 0

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let stored = defaults.string(forKey: Self.key) ?? defaults.data(forKey: Self.key).flatMap { String(data: $0, encoding: .utf8) }
    marks = WorkerDeckCore.Bookmarks(json: stored)
  }

  func bookmarks(host: UUID, sessionId: String) -> [String] {
    _ = revision
    return marks.forSession(hostId: host.uuidString, sessionId: sessionId)
  }

  func toggle(host: UUID, sessionId: String, itemId: String) {
    _ = marks.toggle(hostId: host.uuidString, sessionId: sessionId, itemId: itemId)
    defaults.set(marks.toJson(), forKey: Self.key)
    revision &+= 1
  }
}
