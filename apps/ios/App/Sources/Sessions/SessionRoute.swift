import Foundation

/// Everything reachable from the session list's navigation stack.
///
/// Each route names its gateway: the list shows every host's sessions at once,
/// so "which server" is a fact about the destination, not ambient state.
enum SessionRoute: Hashable {
  /// - Parameter seq: the event a push notification was about, when this route
  ///   came from a tapped notification. Part of the case's identity, so a second
  ///   notification about the same session is a route SwiftUI treats as new —
  ///   which is what re-opens it at the newer row.
  case session(hostId: UUID, sessionId: String, seq: Int? = nil)
  case create(hostId: UUID, seed: CreateSessionSeed)
}

/// Pre-fill for the create form. Carries only what a caller can know up front —
/// the Resume tab supplies both fields, the "+" button neither.
struct CreateSessionSeed: Hashable {
  var cwd: String = ""
  /// SDK session id to resume (`CreateSessionRequest.resume`).
  var resume: String?
}
