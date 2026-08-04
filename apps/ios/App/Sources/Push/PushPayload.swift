import Foundation

/// What the forwarder puts in an APNs payload beside `aps`.
///
/// Deliberately tiny. APNs caps a payload at 4 KB, and the app can fetch the
/// truth over REST or WS the moment it opens — so everything here is either
/// routing (`hostId`, `sessionId`) or the one thing a lock-screen action cannot
/// look up for itself (`requestId`).
struct PushPayload: Sendable, Equatable {
  /// Mirrors `SessionNotificationType`, kept as a plain string: an unknown type
  /// from a newer gateway must still deep-link rather than fail to decode.
  let type: String
  /// The client's own id for the gateway that sent this, echoed back from
  /// registration. Nil for a hand-crafted `simctl push`, which is fine — the
  /// route then falls back to whichever host is open.
  let hostId: UUID?
  let sessionId: String
  /// `permission_requested` only, and the reason this payload exists at all:
  /// without it Approve/Deny has nothing to POST to.
  let requestId: String?

  init?(userInfo: [AnyHashable: Any]) {
    guard let sessionId = userInfo["sessionId"] as? String, !sessionId.isEmpty else { return nil }
    self.sessionId = sessionId
    type = userInfo["type"] as? String ?? ""
    hostId = (userInfo["hostId"] as? String).flatMap(UUID.init(uuidString:))
    requestId = userInfo["requestId"] as? String
  }
}

/// Where a tapped notification wants to land. Equatable so the view layer can
/// drive off `.task(id:)` and pick the route up on a cold launch as well as on a
/// change.
struct PushRoute: Sendable, Hashable {
  let hostId: UUID?
  let sessionId: String
}

/// Category and action identifiers. The forwarder sets the category, so these
/// strings are wire contract — changing one means changing `packages/cli`'s
/// payload builder in the same commit.
enum PushCategory {
  /// Carries the Approve/Deny actions; set for `permission_requested` only.
  static let permissionRequest = "PERMISSION_REQUEST"
  /// Everything else — turn finished, error, closed. Tap-to-open only.
  static let sessionEvent = "SESSION_EVENT"
}

enum PushAction {
  static let approve = "APPROVE"
  static let deny = "DENY"
}
