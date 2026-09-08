import Foundation

/// The work *under* a session row — the port of
/// `packages/ui/src/components/agent/SessionSteps.tsx`.
///
/// The rows themselves are SwiftUI's business; what lives here is everything the
/// three clients must agree about: which records become steps, **what order they
/// come in**, and what state each one is in.
///
/// Ported rather than re-derived. `SessionListView` grew its own inline version
/// first and drifted from the shared rules at once (dispatch order, a failed
/// agent drawing a checkmark, and blue where the product means green). One
/// derivation, three renderers.
///
/// Steps are **sub-agents only**. A record with no agent type is a task, and
/// tasks live in the selected session's own surface (``sessionTasks``), not
/// under a list row.
///
/// Unlike the web's `Step` this carries **no `onSelect`**. SwiftUI routes by
/// value (`NavigationLink(value:)`), so a closure here would be a callback the
/// list has to invent a destination for anyway; the ``Step/key`` is the routing
/// fact, and the view turns it into a ``SessionRoute``.
public struct Step: Sendable, Equatable, Identifiable, Hashable {
  public enum State: String, Sendable, Equatable, Hashable {
    case done
    case running
    case failed
  }

  /// The `tool_use` id — the identity, and the handle both destinations ride.
  public let key: String
  public var id: String { key }
  /// ``subagentLabel``, never a spelling of its own.
  public let label: String
  /// What one of these is called, for the disclosure's count.
  public let noun: String
  public let state: State
  /// A trailing reading — a sub-agent's tool count. Nil draws nothing, because
  /// `0 tools` beside a thinking agent reads as a stall.
  public let detail: String?
  /// The long reading, for accessibility and a long-press.
  public let title: String

  public init(
    key: String, label: String, noun: String = "agent", state: State,
    detail: String? = nil, title: String
  ) {
    self.key = key
    self.label = label
    self.noun = noun
    self.state = state
    self.detail = detail
    self.title = title
  }
}

/// The sub-agents under one session, in dispatch order.
///
/// Dispatch order is the only order these records have that means anything (it
/// is the order the work was started in), so this filters and never reorders.
public func sessionSteps(_ info: SessionInfo) -> [Step] {
  (info.subagents ?? []).filter(isAgentRecord).map { sub -> Step in
    let label = subagentLabel(sub)
    return Step(
      key: sub.toolUseId,
      label: label,
      noun: "agent",
      state: stepState(sub.status),
      detail: sub.toolCount > 0 ? String(sub.toolCount) : nil,
      title: "\(label) · \(sub.toolCount) tool\(sub.toolCount == 1 ? "" : "s")")
  }
}

public func stepState(_ status: SubagentStatus) -> Step.State {
  switch status {
  case .running: return .running
  case .failed: return .failed
  case .done: return .done
  }
}

/// How many of these are still going — the live half of the disclosure's count.
public func runningSteps(_ steps: [Step]) -> Int {
  steps.filter { $0.state == .running }.count
}

/// The disclosure's reading in digits: `2/3` while some are still going, `3`
/// once they have all settled.
///
/// "How many are still working" is the live question and a bare total answers it
/// wrong the moment one finishes. Digits rather than words on the line itself
/// because this sits beside the folder and the age on a narrow second line, and
/// `1 of 6 agents` truncates the folder name away to say what three characters
/// already said. The words are ``stepCountWords(running:total:noun:)`` and go to
/// the accessibility label, which is where they read correctly.
public func stepCountLabel(running: Int, total: Int) -> String {
  running > 0 && running < total ? "\(running)/\(total)" : "\(total)"
}

/// The same count spoken — what a screen reader and a tooltip get.
public func stepCountWords(running: Int, total: Int, noun: String = "agent") -> String {
  if running > 0 && running < total { return "\(running) of \(total) \(noun)s running" }
  return "\(total) \(noun)\(total == 1 ? "" : "s")"
}
