import Testing

@testable import WorkerDeckKit

/// The terminal transcript's two folds — a port of
/// `packages/ui/test/terminal-blocks.test.ts`.
///
/// A run is built from adjacency, a task from membership. Keeping those apart is
/// the whole reason this file exists: parallel subagents interleave, so any test
/// that only ever feeds contiguous children proves nothing about the rule that
/// matters.
@Suite("TerminalBlocks")
struct TerminalBlocksTests {
  private func call(
    _ id: String, _ name: String = "Bash", parent: String? = nil,
    status: ToolCallStatus = .settled, input: JSONValue = .object([:]), isError: Bool = false
  ) -> ToolCallItem {
    ToolCallItem(
      id: id, name: name, input: input, parentToolUseId: parent, status: status,
      result: ToolCallResult(text: "", isError: isError))
  }

  private func text(_ id: String, _ body: String = "hi", parent: String? = nil) -> TranscriptItem {
    .assistantText(id: id, text: body, streaming: false, parentToolUseId: parent)
  }

  // MARK: - Runs

  @Test("consecutive tool calls fold into one run")
  func foldsConsecutiveCalls() {
    let blocks = terminalBlocks([
      .toolCall(call("a")), .toolCall(call("b")), .toolCall(call("c")),
    ])
    #expect(blocks.count == 1)
    guard case .run(let run) = blocks[0] else { Issue.record("expected a run"); return }
    #expect(run.run.map(\.id) == ["a", "b", "c"])
    // Keyed by the FIRST call, so the key is stable as the run grows and the
    // virtualizer keeps the measurement it already has.
    #expect(run.key == "run:a")
    #expect(run.index == 0)
  }

  @Test("anything the model said breaks a run")
  func proseBreaksARun() {
    let blocks = terminalBlocks([
      .toolCall(call("a")), text("t1"), .toolCall(call("b")),
    ])
    #expect(blocks.count == 3)
    guard case .run(let first) = blocks[0], case .run(let second) = blocks[2] else {
      Issue.record("expected two runs around the prose")
      return
    }
    #expect(first.run.count == 1)
    #expect(second.run.count == 1)
  }

  @Test("a failure colours a run, it does not split it")
  func failureDoesNotSplitARun() {
    let blocks = terminalBlocks([
      .toolCall(call("a")), .toolCall(call("b", status: .failed)), .toolCall(call("c")),
    ])
    #expect(blocks.count == 1)
    guard case .run(let run) = blocks[0] else { Issue.record("expected one run"); return }
    #expect(run.run.count == 3)
  }

  @Test("a subagent's call never folds with a top-level one")
  func parentSplitsARun() {
    // Both calls are consecutive in the stream, but one is drawn stepped in
    // behind a rule — folding them would count rows that are not adjacent.
    let blocks = terminalBlocks([
      .toolCall(call("a")), .toolCall(call("b", parent: "orphan")),
    ])
    #expect(blocks.count == 2)
  }

  // MARK: - Tasks

  @Test("a Task absorbs its children, wherever they fall in the stream")
  func taskAbsorbsByMembership() {
    // Interleaved on purpose: parallel Tasks do exactly this, and an adjacency
    // rule would put half of each subagent's work at top level.
    let blocks = terminalBlocks([
      .toolCall(call("t1", "Task")),
      .toolCall(call("t2", "Task")),
      .toolCall(call("c1", parent: "t1")),
      .toolCall(call("c2", parent: "t2")),
      .toolCall(call("c3", parent: "t1")),
    ])
    #expect(blocks.count == 2)
    guard case .task(let first) = blocks[0], case .task(let second) = blocks[1] else {
      Issue.record("expected two task blocks")
      return
    }
    #expect(first.childIndices == [2, 4])
    #expect(second.childIndices == [3])
    #expect(taskChildItems(first).count == 2)
  }

  @Test("an absorbed child is never also its own row")
  func absorbedChildrenAreNotDuplicated() {
    let blocks = terminalBlocks([
      .toolCall(call("t1", "Task")), text("brief", parent: "t1"), .toolCall(call("c1", parent: "t1")),
    ])
    #expect(blocks.count == 1)
  }

  @Test("a childless Task stays a plain call and folds into runs")
  func childlessTaskFolds() {
    // The Task is still spawning, or a resumed session compacted its children
    // away. Either way it is a tool call like any other.
    let blocks = terminalBlocks([.toolCall(call("t1", "Task")), .toolCall(call("a"))])
    #expect(blocks.count == 1)
    guard case .run(let run) = blocks[0] else { Issue.record("expected a run"); return }
    #expect(run.run.count == 2)
  }

  @Test("an orphan child keeps its own row rather than vanishing")
  func orphanChildIsVisible() {
    // The parent is outside the slice — what a recap boundary and a compaction
    // both leave behind. An unmapped item must be visible, never gone.
    let blocks = terminalBlocks([text("x"), .toolCall(call("c1", parent: "elsewhere"))])
    #expect(blocks.count == 2)
  }

  @Test("a task breaks a run")
  func taskBreaksARun() {
    let blocks = terminalBlocks([
      .toolCall(call("a")),
      .toolCall(call("t1", "Task")),
      .toolCall(call("c1", parent: "t1")),
      .toolCall(call("b")),
    ])
    #expect(blocks.count == 3)
    guard case .run(let last) = blocks[2] else { Issue.record("expected a trailing run"); return }
    #expect(last.run.map(\.id) == ["b"])
  }

  @Test("a subagent's own run of calls folds inside its task")
  func childrenFoldInsideATask() {
    let blocks = terminalBlocks([
      .toolCall(call("t1", "Task")),
      .toolCall(call("c1", parent: "t1")),
      .toolCall(call("c2", parent: "t1")),
    ])
    guard case .task(let task) = blocks[0] else { Issue.record("expected a task"); return }
    #expect(task.children.count == 1)
    guard case .run(let run) = task.children[0] else { Issue.record("expected a folded run"); return }
    #expect(run.run.count == 2)
  }

  @Test("fold: false gives one block per item")
  func unfoldedIsFlat() {
    let items: [TranscriptItem] = [
      .toolCall(call("a")), .toolCall(call("b")), .toolCall(call("c")),
    ]
    #expect(terminalBlocks(items, fold: false).count == 3)
  }

  // MARK: - Blank lines

  @Test("two tool calls sit flush; anything else gets a blank line")
  func blankLineRule() {
    #expect(needsBlank(.toolCall(call("a")), .toolCall(call("b"))) == false)
    #expect(needsBlank(text("t"), .toolCall(call("b"))) == true)
    // A collapsed task counts as a tool call for spacing, so it sits flush with
    // the tool rows of the same turn.
    let blocks = terminalBlocks([
      .toolCall(call("t1", "Task")), .toolCall(call("c1", parent: "t1")), .toolCall(call("b")),
    ])
    #expect(blockNeedsBlank(blocks[0], blocks[1]) == false)
  }
}
