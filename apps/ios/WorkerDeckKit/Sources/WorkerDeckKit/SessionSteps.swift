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
/// Steps are sub-agents, then tasks (the checklist and untyped spawns), then
/// shells, each list under its own ``StepDisplay``.
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
    /// Not started - or a checklist item left in progress after the turn ended,
    /// which is not running either.
    case pending
  }

  /// What the row is about, which is the only thing the renderer needs to know
  /// to draw it: a sub-agent gets the state glyph and the success tone, a shell
  /// gets `$` and the shell accent, and neither borrows the other's colour.
  public enum Kind: String, Sendable, Equatable, Hashable {
    case agent
    case task
    case shell
  }

  /// The `tool_use` id, the task key, or the shell id - the identity, and the
  /// handle agent and shell destinations ride.
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

  /// A running shell (kill) or a task the engine can stop. Never a sub-agent:
  /// a stop glyph there would promise something no client can do.
  public let killable: Bool
  /// A spawned task's `tool_use` id: where a press reveals it, and what a stop
  /// names. Nil for agents, shells and checklist items.
  public let toolUseId: String?

  public init(
    key: String, kind: Kind = .agent, label: String, noun: String = "agent", state: State,
    detail: String? = nil, title: String, killable: Bool = false, toolUseId: String? = nil
  ) {
    self.key = key
    self.kind = kind
    self.label = label
    self.noun = noun
    self.state = state
    self.detail = detail
    self.title = title
    self.killable = killable
    self.toolUseId = toolUseId
  }
}

/// The sub-agents under one session in dispatch order, then its tasks, then its
/// shells.
///
/// Dispatch order is the only order these records have that means anything (it
/// is the order the work was started in), so this filters and never reorders.
/// Tasks and shells come after as blocks: they are different kinds of thing, and
/// a `$ npm run dev` interleaved by timestamp between two agents would read as
/// part of the agent's work.
///
/// `now` is passed in rather than read from the clock so that which shells earn
/// a line is a pure function of the caller's tick, exactly as it is on the web.
/// `nil` leaves shells out, and a nil `tasks` leaves tasks out - what a surface
/// with nowhere to route those presses wants.
public func sessionSteps(
  _ info: SessionInfo, _ show: StepDisplay = .all, now: Double? = nil,
  shells: StepDisplay = .active, tasks: StepDisplay? = nil
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
  let live = sessionLive(info)
  let taskSteps = tasks.map { displayedTasks(info, $0).map { taskStep($0, live: live) } } ?? []
  guard let now else { return agents + taskSteps }
  return agents + taskSteps + visibleShells(info, shells, now: now).map(shellStep)
}

/// Whether the session's turn is still in flight. A checklist item left
/// `in_progress` on a session that is not is drawn as pending: the agent forgot
/// to settle it, and a spinner would claim work that is not happening.
public func sessionLive(_ info: SessionInfo) -> Bool {
  info.status == .running || info.status == .starting || info.status == .awaitingApproval
}

private func taskStep(_ task: SessionTask, live: Bool) -> Step {
  let stalled = task.source == .checklist && task.state == .running && !live
  let state: Step.State
  switch task.state {
  case .pending: state = .pending
  case .running: state = stalled ? .pending : .running
  case .done: state = .done
  case .failed: state = .failed
  }
  return Step(
    key: task.key,
    kind: .task,
    label: task.label,
    noun: "task",
    state: state,
    detail: task.detail,
    title: stalled ? "\(task.label) · left in progress" : task.label,
    killable: task.stoppable && task.toolUseId != nil,
    toolUseId: task.toolUseId)
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
