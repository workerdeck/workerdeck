import Foundation

/// The work *under* a session row — the port of
/// `packages/ui/src/components/agent/SessionSteps.tsx`.
///
/// The rows themselves are SwiftUI's business; what lives here is everything the
/// three clients must agree about: which records become steps, **what order they
/// come in**, what state each one is in, and which kind it is — because the kind
/// is what decides where a press goes.
///
/// Ported rather than re-derived. `SessionListView` grew its own inline version
/// first and drifted from the shared rules in four ways at once (dispatch order,
/// inert tasks, a failed agent drawing a checkmark, and blue where the product
/// means green). One derivation, three renderers.
///
/// Today the only source is ``SessionInfo/subagents``. The other — the CLI's own
/// **task checklist**, the to-do list it keeps for the current turn — is not
/// built: nothing on the wire carries it yet. When it arrives it is a *source*,
/// not a second row shape: checklist when the session has one, its sub-agents
/// otherwise. That is why ``Step/Kind`` is two cases and not a `Bool`, and why
/// ``Step/State`` has a `pending` arm no sub-agent can produce — a record exists
/// only once dispatched, so it is never queued, but a to-do is queued for most
/// of its life and widening the union later is the more expensive move.
///
/// Unlike the web's `Step` this carries **no `onSelect`**. SwiftUI routes by
/// value (`NavigationLink(value:)`), so a closure here would be a callback the
/// list has to invent a destination for anyway; the ``Step/kind`` is the routing
/// fact, and the view turns it into a ``SessionRoute``.
public struct Step: Sendable, Equatable, Identifiable, Hashable {
  /// What one of these is, when a press has somewhere to go.
  ///
  /// An **agent** has an identity and work of its own, so it opens that agent's
  /// own frame and wears the sub-agent colour. A **task** is something the model
  /// described with no agent behind it (``isAgentRecord``), so it has no frame:
  /// pressing it opens the session and travels to that tool call's row.
  ///
  /// Conflating the two is the bug that shipped on the web and was fixed in
  /// 0.21.0 — framing a task's tool-use id selects no items, so the panel drew
  /// an **empty agent view**.
  public enum Kind: String, Sendable, Equatable, Hashable {
    case agent
    case task
  }

  public enum State: String, Sendable, Equatable, Hashable {
    case done
    case running
    case pending
    case failed
  }

  /// The `tool_use` id — the identity, and the handle both destinations ride.
  public let key: String
  public var id: String { key }
  /// ``subagentLabel``, never a spelling of its own.
  public let label: String
  /// What one of these is called, for the disclosure's count.
  public let noun: String
  public let kind: Kind
  public let state: State
  /// A trailing reading — a sub-agent's tool count. Nil draws nothing, because
  /// `0 tools` beside a thinking agent reads as a stall.
  public let detail: String?
  /// The long reading, for accessibility and a long-press.
  public let title: String

  public init(
    key: String, label: String, noun: String = "agent", kind: Kind, state: State,
    detail: String? = nil, title: String
  ) {
    self.key = key
    self.label = label
    self.noun = noun
    self.kind = kind
    self.state = state
    self.detail = detail
    self.title = title
  }
}

/// The steps under one session, **agents first**.
///
/// The two kinds do different things when pressed and are worth different
/// amounts of attention: an agent has work of its own to go and read, a task is
/// a marker in a transcript. Interleaved in dispatch order they read as one
/// undifferentiated list, and the rows that open a frame are scattered through
/// it. Grouped, the frames are a block at the top and the markers a tail you can
/// skip.
///
/// Stable **within** each group, deliberately: dispatch order is the only order
/// these records have that means anything (it is the order the work was started
/// in), so this partitions and never reorders inside a partition.
public func sessionSteps(_ info: SessionInfo) -> [Step] {
  let steps = (info.subagents ?? []).map { sub -> Step in
    let label = subagentLabel(sub)
    return Step(
      key: sub.toolUseId,
      label: label,
      noun: "agent",
      kind: isAgentRecord(sub) ? .agent : .task,
      state: stepState(sub.status),
      detail: sub.toolCount > 0 ? String(sub.toolCount) : nil,
      title: "\(label) · \(sub.toolCount) tool\(sub.toolCount == 1 ? "" : "s")")
  }
  return steps.filter { $0.kind == .agent } + steps.filter { $0.kind == .task }
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
