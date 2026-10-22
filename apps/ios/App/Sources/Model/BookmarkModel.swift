import Foundation
import Observation
import WorkerDeckCore

// The reader's bookmarks: the core's `Bookmarks` (the web's `workerdeck.bookmarks.v1` semantics, item ids per
// conversation of a session) kept in UserDefaults as JSON text. Local to this phone: a bookmark is the reader's
// annotation, not the session's. `revision` is what Observation sees, so the rail redraws after a long-press toggles a row.
@MainActor
@Observable
final class BookmarkModel {
  private static let key = "bi.atomic.workerdeck.ios.bookmarks"

  private let marks: WorkerDeckCore.Bookmarks
  private let defaults: UserDefaults
  private(set) var revision = 0

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    marks = WorkerDeckCore.Bookmarks(json: defaults.string(forKey: Self.key))
  }

  func bookmarks(host: UUID, sessionId: String, conversation: Int64) -> [String] {
    _ = revision
    return marks.forSession(hostId: host.uuidString, sessionId: sessionId, conversation: conversation)
  }

  func toggle(host: UUID, sessionId: String, conversation: Int64, itemId: String) {
    _ = marks.toggle(hostId: host.uuidString, sessionId: sessionId, conversation: conversation, itemId: itemId)
    defaults.set(marks.toJson(), forKey: Self.key)
    revision &+= 1
  }
}
