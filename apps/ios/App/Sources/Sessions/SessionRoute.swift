import Foundation

/// Everything reachable from the session list's navigation stack.
///
/// Each route names its gateway: the list shows every host's sessions at once,
/// so "which server" is a fact about the destination, not ambient state.
enum SessionRoute: Hashable {
  case session(hostId: UUID, sessionId: String)
  case create(hostId: UUID, seed: CreateSessionSeed)
}

/// Pre-fill for the create form. Carries only what a caller can know up front —
/// the Resume tab supplies both fields, the "+" button neither.
struct CreateSessionSeed: Hashable {
  var cwd: String = ""
  /// SDK session id to resume (`CreateSessionRequest.resume`).
  var resume: String?
}
