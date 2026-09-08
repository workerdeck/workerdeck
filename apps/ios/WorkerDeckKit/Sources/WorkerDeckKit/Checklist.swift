import Foundation

/// Widening this union costs a `PROTOCOL_VERSION` bump: it decodes strictly.
public enum ChecklistStatus: String, Decodable, Sendable, Equatable, Hashable {
  case pending
  case inProgress = "in_progress"
  case completed
}

public struct ChecklistItem: Decodable, Sendable, Equatable, Hashable {
  public let text: String
  public let status: ChecklistStatus

  public init(text: String, status: ChecklistStatus) {
    self.text = text
    self.status = status
  }
}

/// One row of the selected session's Tasks surface — the port of
/// `packages/protocol/src/checklist.ts`.
///
/// Two sources, one row shape: the engine's own checklist and the `Task` spawns
/// that carry no agent type (the ones ``sessionSteps`` leaves out). A spawn has
/// a tool count and a transcript row to travel to; a checklist item has neither.
public struct SessionTask: Sendable, Equatable, Identifiable, Hashable {
  public enum Source: String, Sendable, Equatable, Hashable {
    case checklist
    case spawn
  }

  public enum State: String, Sendable, Equatable, Hashable {
    case pending
    case running
    case done
    case failed
  }

  /// Namespaced by source, and by *index* within the checklist rather than by
  /// text: a plan may name the same step twice, and a duplicate `id` in a
  /// `ForEach` is a crash rather than a warning.
  public let key: String
  public var id: String { key }
  public let label: String
  public let source: Source
  public let state: State
  public let detail: String?
  /// The reveal handle — spawns only.
  public let toolUseId: String?

  public init(
    key: String, label: String, source: Source, state: State,
    detail: String? = nil, toolUseId: String? = nil
  ) {
    self.key = key
    self.label = label
    self.source = source
    self.state = state
    self.detail = detail
    self.toolUseId = toolUseId
  }
}

public struct TaskSummary: Sendable, Equatable {
  public let total: Int
  public let done: Int
  public let running: Int
  public let failed: Int
}

/// Checklist first in the order the engine authored it, then spawns in dispatch
/// order. Interleaving is impossible — a checklist item carries no time — and
/// the plan is the frame the spawned work sits inside.
public func sessionTasks(checklist: [ChecklistItem]?, subagents: [SubagentInfo]?) -> [SessionTask] {
  let items = (checklist ?? []).enumerated().map { index, item in
    SessionTask(
      key: "checklist:\(index)",
      label: item.text,
      source: .checklist,
      state: checklistState(item.status))
  }
  let spawns = (subagents ?? []).filter { !isAgentRecord($0) }.map { sub in
    SessionTask(
      key: "spawn:\(sub.toolUseId)",
      label: sub.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        ? sub.description!.trimmingCharacters(in: .whitespacesAndNewlines) : "Task",
      source: .spawn,
      state: spawnState(sub.status),
      detail: sub.toolCount > 0 ? String(sub.toolCount) : nil,
      toolUseId: sub.toolUseId)
  }
  return items + spawns
}

public func sessionTasks(_ info: SessionInfo) -> [SessionTask] {
  sessionTasks(checklist: info.checklist, subagents: info.subagents)
}

func checklistState(_ status: ChecklistStatus) -> SessionTask.State {
  switch status {
  case .pending: return .pending
  case .inProgress: return .running
  case .completed: return .done
  }
}

func spawnState(_ status: SubagentStatus) -> SessionTask.State {
  switch status {
  case .running: return .running
  case .done: return .done
  case .failed: return .failed
  }
}

/// `done` counts completions only — a failure is settled but is not progress.
public func taskSummary(_ tasks: [SessionTask]) -> TaskSummary {
  TaskSummary(
    total: tasks.count,
    done: tasks.filter { $0.state == .done }.count,
    running: tasks.filter { $0.state == .running }.count,
    failed: tasks.filter { $0.state == .failed }.count)
}

public func taskCountLabel(_ summary: TaskSummary) -> String? {
  summary.total == 0 ? nil : "\(summary.done)/\(summary.total)"
}

/// Hides completions only: a failure is exactly what someone opening this wants
/// to see, and hiding it behind a "completed" toggle would be a lie.
public func visibleTasks(_ tasks: [SessionTask], showCompleted: Bool) -> [SessionTask] {
  showCompleted ? tasks : tasks.filter { $0.state != .done }
}
