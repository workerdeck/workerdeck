import Foundation

/// Which Live Activity card the app has accepted for each `(host, session)`.
///
/// Pure bookkeeping, extracted from `ActivityCoordinator` so it can be tested: ActivityKit hands
/// the *same* activity to the app twice — once from `Activity.activities` at launch, once from the
/// `activityUpdates` stream — and a guard keyed on the session alone reads that second delivery as
/// a duplicate card and ends the only card there is. Keying on the activity id is what tells the
/// two apart.
public struct ActivityClaims: Sendable {
  public enum Claim: Sendable, Equatable {
    case fresh
    /// This exact card again. Ignore it; ending it would kill the live one.
    case alreadyWatched
    /// A different card for a session that already has one — the real duplicate-start hazard.
    case duplicate
  }

  private var held: [String: String] = [:]

  public init() {}

  public var count: Int { held.count }

  public static func key(sessionId: String, hostId: String?) -> String {
    "\(hostId ?? "-")|\(sessionId)"
  }

  public mutating func claim(id: String, sessionId: String, hostId: String?) -> Claim {
    let key = Self.key(sessionId: sessionId, hostId: hostId)
    if let existing = held[key] {
      return existing == id ? .alreadyWatched : .duplicate
    }
    held[key] = id
    return .fresh
  }

  /// Frees the slot only if this card still holds it — a replacement may have claimed it already.
  public mutating func release(id: String, sessionId: String, hostId: String?) {
    let key = Self.key(sessionId: sessionId, hostId: hostId)
    if held[key] == id { held.removeValue(forKey: key) }
  }
}
