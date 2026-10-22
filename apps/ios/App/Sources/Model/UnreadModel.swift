import Foundation
import Observation
import WorkerDeckCore
import WorkerDeckKit

// The app's unread memory. The marks live in the core's `SessionList` (the shared watermark rules), which the sessions
// list draws from too, so a mark the session screen writes clears the list's badge with no second copy to drift. The
// store is the JSON text the core writes. `revision` is what Observation sees: the core is not observable.
@MainActor
@Observable
final class UnreadModel {
  private static let key = "bi.atomic.workerdeck.ios.watermarks"

  let list: SessionList
  private let defaults: UserDefaults
  private(set) var revision = 0

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    list = SessionList(configJson: nil, marksJson: defaults.string(forKey: Self.key))
  }

  // Callers own the "genuinely on screen" test: that is a fact about the UI, not about storage.
  @discardableResult
  func mark(host: UUID, sessionId: String, itemCount: Int?, activity: Int?, prose: Int?, turns: Int?) -> Bool {
    let moved = list.mark(
      hostId: host.uuidString, sessionId: sessionId, itemCount: itemCount.map(UInt32.init),
      activity: activity.map(UInt32.init), prose: prose.map(UInt32.init), turns: turns.map(UInt32.init),
      nowMs: Date().timeIntervalSince1970 * 1000)
    if moved { changed() }
    return moved
  }

  // The true-up on leaving: a fresh `GET /v1/sessions/:id` body, read by the core.
  @discardableResult
  func markSession(host: UUID, sessionId: String, itemCount: Int?, body: String) -> Bool {
    let moved = list.markSession(
      hostId: host.uuidString, sessionId: sessionId, itemCount: itemCount.map(UInt32.init), body: body,
      nowMs: Date().timeIntervalSince1970 * 1000)
    if moved { changed() }
    return moved
  }

  // Deliberately not `revision`-dependent: the boundary is fixed when a session is opened, and a mark that moved under
  // a reader would walk the recap row down the transcript while they read it.
  func since(host: UUID, sessionId: String) -> CatchUpMark? {
    list.since(hostId: host.uuidString, sessionId: sessionId).map {
      CatchUpMark(itemCount: Int($0.itemCount), seenAt: $0.seenAt)
    }
  }

  func forget(host: UUID, sessionId: String) {
    if list.forget(hostId: host.uuidString, sessionId: sessionId) { changed() }
  }

  func forget(host: UUID) {
    if list.removeHost(hostId: host.uuidString) { changed() }
  }

  private func changed() {
    defaults.set(list.marksJson(), forKey: Self.key)
    revision &+= 1
  }
}

// What a session screen was handed at mount: how much of the transcript had been read, and when (epoch ms).
struct CatchUpMark: Equatable {
  var itemCount: Int
  var seenAt: Double
}
