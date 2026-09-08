import Foundation
import Testing

@testable import WorkerDeckKit

/// The selected session's Tasks surface — the port of
/// `packages/react/test/checklist.test.ts`.
///
/// Two sources, one row shape, and the rules both clients must agree about:
/// checklist before spawns, an agent record is never a task, and a failure is
/// neither progress nor something a "hide completed" toggle may swallow.
@Suite("Checklist")
struct ChecklistTests {
  private func sub(
    _ id: String, agentType: String? = nil, description: String? = nil,
    status: SubagentStatus = .running, toolCount: Int = 0
  ) -> SubagentInfo {
    SubagentInfo(
      toolUseId: id, agentType: agentType, description: description, status: status,
      startedAt: 1_000, toolCount: toolCount)
  }

  private let checklist: [ChecklistItem] = [
    ChecklistItem(text: "read", status: .completed),
    ChecklistItem(text: "write", status: .inProgress),
    ChecklistItem(text: "ship", status: .pending),
  ]

  @Test("a checklist status maps onto a task state")
  func statusMapping() {
    let tasks = sessionTasks(checklist: checklist, subagents: nil)
    #expect(tasks.map(\.state) == [.done, .running, .pending])
  }

  @Test("the checklist leads and the spawns follow, each in its own order")
  func order() {
    let tasks = sessionTasks(
      checklist: [ChecklistItem(text: "plan", status: .pending)],
      subagents: [sub("s1", description: "one"), sub("s2", description: "two")])
    #expect(tasks.map(\.key) == ["checklist:0", "spawn:s1", "spawn:s2"])
  }

  /// A record with an agent type is a sub-agent and belongs to the card, not
  /// here — the same split `sessionSteps` reads from the other side.
  @Test("an agent record is never a task")
  func agentsExcluded() {
    let tasks = sessionTasks(
      checklist: nil, subagents: [sub("a", agentType: "Explore"), sub("t", description: "a task")])
    #expect(tasks.map(\.key) == ["spawn:t"])
  }

  /// Keyed by index, not text: a plan may name the same step twice, and a
  /// duplicate `Identifiable.id` in a `ForEach` is a crash.
  @Test("duplicate texts keep distinct keys")
  func duplicateTexts() {
    let tasks = sessionTasks(
      checklist: [
        ChecklistItem(text: "Run tests", status: .pending),
        ChecklistItem(text: "Run tests", status: .pending),
      ], subagents: nil)
    #expect(Set(tasks.map(\.key)).count == 2)
  }

  @Test("a spawn carries its tool count, a checklist item carries none")
  func detail() {
    let tasks = sessionTasks(
      checklist: [ChecklistItem(text: "plan", status: .pending)],
      subagents: [sub("s", description: "work", toolCount: 4)])
    #expect(tasks.map(\.detail) == [nil, "4"])
    #expect(tasks.map(\.toolUseId) == [nil, "s"])
  }

  @Test("an untyped record with no description still reads as something")
  func fallbackLabel() {
    #expect(sessionTasks(checklist: nil, subagents: [sub("s")]).first?.label == "Task")
    #expect(sessionTasks(checklist: nil, subagents: [sub("s", description: "  ")]).first?.label == "Task")
  }

  @Test("nothing present is no tasks, and nil is not a crash")
  func empty() {
    #expect(sessionTasks(checklist: nil, subagents: nil).isEmpty)
    #expect(sessionTasks(checklist: [], subagents: []).isEmpty)
  }

  /// `done` counts completions only. A failure is settled, but calling it
  /// progress would overstate how far the work got.
  @Test("the summary counts each settled state apart")
  func summary() {
    let tasks = sessionTasks(
      checklist: [
        ChecklistItem(text: "a", status: .completed), ChecklistItem(text: "b", status: .inProgress),
      ],
      subagents: [sub("f", description: "broke", status: .failed)])
    let count = taskSummary(tasks)
    #expect(count == TaskSummary(total: 3, done: 1, running: 1, failed: 1))
    #expect(taskCountLabel(count) == "1/3")
  }

  @Test("no tasks is no label to draw")
  func noLabel() {
    #expect(taskCountLabel(taskSummary([])) == nil)
  }

  @Test("hiding completed keeps a failure visible")
  func hideCompleted() {
    let tasks = sessionTasks(
      checklist: [
        ChecklistItem(text: "a", status: .completed), ChecklistItem(text: "b", status: .pending),
      ],
      subagents: [sub("f", description: "broke", status: .failed)])
    #expect(visibleTasks(tasks, showCompleted: false).map(\.label) == ["b", "broke"])
    #expect(visibleTasks(tasks, showCompleted: true).count == 3)
  }
}
