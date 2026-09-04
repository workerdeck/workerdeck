import Foundation

/// A message the reader typed while a turn was running, kept here instead of
/// sent — the Swift mirror of the web `ui` package's `useHeldSends`
/// (`packages/ui/src/components/agent/held-sends.tsx`).
///
/// Catch-up mode is the engine's own behaviour: a message that arrives mid-turn
/// is folded into the running turn. Holding it on the client is the only way to
/// turn that off, which makes this a purely local preference — nothing about it
/// travels on the wire, and there is nothing to negotiate with the engine.
public struct HeldSend: Equatable, Sendable {
  public let text: String
  public let attachmentIds: [String]

  public init(text: String, attachmentIds: [String] = []) {
    self.text = text
    self.attachmentIds = attachmentIds
  }
}

/// The queue itself, pure so the ordering rules are testable: every mutation
/// **returns what to send now**, and the caller does the sending. A queue that
/// held the send closure would be a view model, and this package is the only
/// part of the app under test.
public struct HeldSendQueue: Equatable, Sendable {
  public private(set) var held: [HeldSend] = []

  public init() {}

  public var isEmpty: Bool { held.isEmpty }

  /// `hold` is the preference, `busy` is the session. Both must hold, so a
  /// message typed at an idle session — or at one that has ended, which is never
  /// busy — goes straight through however the preference is set.
  public mutating func submit(_ message: HeldSend, hold: Bool, busy: Bool) -> [HeldSend] {
    guard hold, busy else { return [message] }
    held.append(message)
    return []
  }

  /// The turn's own trigger: the queue empties as soon as the session stops
  /// being busy, whatever the preference now says — a message held under `hold`
  /// that was then switched to catch-up is still owed its send.
  ///
  /// Guarded on emptiness rather than left to `flush`, because the caller polls
  /// this on every applied event and an `@Observable` holder would invalidate
  /// its views on each one.
  public mutating func sessionBusy(_ busy: Bool) -> [HeldSend] {
    guard !busy, !held.isEmpty else { return [] }
    return flush()
  }

  /// Everything held, in the order it was typed. Drains, so a second call
  /// cannot re-send what the first one returned.
  public mutating func flush() -> [HeldSend] {
    defer { held = [] }
    return held
  }

  /// What the bar above the composer says, or nil when there is nothing to draw
  /// — the empty queue renders no bar at all rather than an empty one.
  public var summary: String? {
    guard let last = held.last else { return nil }
    let count = held.count == 1 ? "1 message" : "\(held.count) messages"
    return "\(count) waiting for this turn to end — \(last.text)"
  }
}
