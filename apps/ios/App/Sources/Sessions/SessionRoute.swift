import Foundation
import WorkerDeckKit

/// Everything reachable from the session list's navigation stack.
///
/// Each route names its gateway: the list shows every host's sessions at once,
/// so "which server" is a fact about the destination, not ambient state.
enum SessionRoute: Hashable {
  /// - Parameter seq: the event a push notification was about, when this route
  ///   came from a tapped notification. Part of the case's identity, so a second
  ///   notification about the same session is a route SwiftUI treats as new —
  ///   which is what re-opens it at the newer row.
  /// - Parameter subagent: a `SubagentInfo.toolUseId`, when this route came from
  ///   an agent line under a session row — the session opens with that agent's
  ///   takeover already framed. Part of the identity for the same reason `seq`
  ///   is: tapping a *different* agent of a session already on screen has to
  ///   read as a new destination, not as the one that is showing.
  /// - Parameter reveal: a `tool_use` id, when this route came from a **task**
  ///   line under a session row — the session opens on that tool call's own
  ///   row. The sibling of `subagent` and never set with it: the two kinds of
  ///   step go to two destinations, which is the whole distinction. A task has
  ///   no agent behind it, so framing its id selects no items and draws an
  ///   empty agent view; that was the bug on the web, and the fix was giving
  ///   the kinds different destinations rather than teaching the frame to cope.
  ///   Part of the identity for the same reason the other two are.
  case session(
    hostId: UUID, sessionId: String, seq: Int? = nil, subagent: String? = nil,
    reveal: String? = nil)
  case create(hostId: UUID, seed: CreateSessionSeed)

  // Where a step line under a session row goes. Here rather than at the list,
  // because the preview harness routes its own copy of the same rows: with the
  // rule spelled twice, a test driving the preview proves only that the preview
  // agrees with itself.
  static func step(hostId: UUID, sessionId: String, step: Step) -> SessionRoute {
    switch step.kind {
    case .agent: .session(hostId: hostId, sessionId: sessionId, subagent: step.key)
    case .task: .session(hostId: hostId, sessionId: sessionId, reveal: step.key)
    }
  }
}

/// Pre-fill for the create form. Carries only what a caller can know up front —
/// the Resume tab supplies both fields, the "+" button neither.
struct CreateSessionSeed: Hashable {
  var cwd: String = ""
  /// SDK session id to resume (`CreateSessionRequest.resume`).
  var resume: String?
}
