import Foundation

/// The work *under* a session row - the port of
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
/// Steps are sub-agents and **promoted shells**. A record with no agent type is
/// a task, and tasks live in the selected session's own surface
/// (``sessionTasks``), not under a list row.
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

  /// What the row is about, which is the only thing the renderer needs to know
  /// to draw it: a sub-agent gets the state glyph and the success tone, a shell
  /// gets `$` and the shell accent, and neither borrows the other's colour.
  public enum Kind: String, Sendable, Equatable, Hashable {
    case agent
    case shell
  }

  /// The `tool_use` id, or the shell id - the identity, and the handle both
  /// destinations ride.
  public let key: String
  public var id: String { key }
  public let kind: Kind
  /// `subagentLabel` or `TerminalShell.label`, never a spelling of its own.
  public let label: String
  /// What one of these is called, for the disclosure's count.
  public let noun: String
  public let state: State
  /// A trailing reading - a sub-agent's tool count. Nil draws nothing, because
  /// `0 tools` beside a thinking agent reads as a stall.
  public let detail: String?
  /// The long reading, for accessibility and a long-press.
  public let title: String

  /// True only for a **running** shell: nothing else on a card can be stopped
  /// from the card, and a kill glyph beside a sub-agent would promise something
  /// no client can do.
  public let killable: Bool

  public init(
    key: String, kind: Kind = .agent, label: String, noun: String = "agent", state: State,
    detail: String? = nil, title: String, killable: Bool = false
  ) {
    self.key = key
    self.kind = kind
    self.label = label
    self.noun = noun
    self.state = state
    self.detail = detail
    self.title = title
    self.killable = killable
  }
}

/// The sub-agents under one session, in dispatch order, then its promoted
/// shells.
///
/// Dispatch order is the only order these records have that means anything (it
/// is the order the work was started in), so this filters and never reorders.
/// Shells come last as a block: they are a different kind of thing, and a
/// `$ npm run dev` interleaved by timestamp between two agents would read as
/// part of the agent's work.
///
/// `now` is passed in rather than read from the clock so that which shells earn
/// a line is a pure function of the caller's tick, exactly as it is on the web,
/// where a poll's `now` decides it. `nil` leaves shells out entirely, which is
/// what a surface with nowhere to route a shell press wants.
public func sessionSteps(
  _ info: SessionInfo, _ show: SubagentDisplay = .all, now: Double? = nil
) -> [Step] {
  let agents = visibleSubagents(info, show).filter(isAgentRecord).map { sub -> Step in
    let label = subagentLabel(sub)
    return Step(
      key: sub.toolUseId,
      kind: .agent,
      label: label,
      noun: "agent",
      state: stepState(sub.status),
      detail: sub.toolCount > 0 ? String(sub.toolCount) : nil,
      title: "\(label) · \(sub.toolCount) tool\(sub.toolCount == 1 ? "" : "s")")
  }
  guard let now else { return agents }
  return agents + promotedShells(info, now: now).map(shellStep)
}

private func shellStep(_ shell: ShellInfo) -> Step {
  let status = TerminalShell.statusText(shell)
  let running = shell.status == .running
  return Step(
    key: shell.id,
    kind: .shell,
    label: TerminalShell.label(shell),
    noun: "shell",
    state: TerminalShell.failed(shell) ? .failed : running ? .running : .done,
    // A running shell's status is the word "running", which the spinner already
    // says. Only an ended one has anything left to report.
    detail: running ? nil : status,
    title: "\(TerminalShell.title(shell)) · \(status)",
    killable: running)
}

public func stepState(_ status: SubagentStatus) -> Step.State {
  switch status {
  case .running: return .running
  case .failed: return .failed
  case .done: return .done
  }
}
