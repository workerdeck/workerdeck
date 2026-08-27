import Foundation
import Testing

@testable import WorkerDeckKit

/// The sub-agent takeover's rules: the frame membership (`subagentItems`, the
/// port of web `blocks.ts`), the header's identity (`taskIdentity`), the strip's
/// claims, and the press the phone hangs the takeover on.
@Suite("Subagent frame")
struct SubagentFrameTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 400, fontSize: 13)

  private func call(
    _ id: String, _ name: String = "Bash", parent: String? = nil,
    status: ToolCallStatus = .settled, input: JSONValue = .object([:]),
    result: ToolCallResult? = ToolCallResult(text: "", isError: false)
  ) -> ToolCallItem {
    ToolCallItem(
      id: id, name: name, input: input, parentToolUseId: parent, status: status, result: result)
  }

  private func task(
    _ id: String, agent: String? = "Explore", description: String? = "find the tests",
    status: ToolCallStatus = .settled
  ) -> ToolCallItem {
    var input: [String: JSONValue] = [:]
    if let agent { input["subagent_type"] = .string(agent) }
    if let description { input["description"] = .string(description) }
    return call(id, "Task", input: .object(input), result: nil).with(status: status)
  }

  // MARK: - Frame membership

  /// Everything the agent produced — the brief, thinking, calls, the report —
  /// and nothing else: not the spawning call (that is the frame, not a row in
  /// it), not another agent's work, not the main thread.
  @Test("subagentItems is the membership rule, not a slice")
  func frameMembership() {
    let items: [TranscriptItem] = [
      .user(id: "u1", text: "go"),
      .toolCall(task("T1")),
      .toolCall(task("T2")),
      // Parallel agents interleave: T2's row lands between T1's.
      .user(id: "b1", text: "brief for one", parentToolUseId: "T1"),
      .user(id: "b2", text: "brief for two", parentToolUseId: "T2"),
      .thinking(id: "th1", text: "hm", parentToolUseId: "T1"),
      .toolCall(call("c1", parent: "T1")),
      .toolCall(call("c2", parent: "T2")),
      .assistantText(id: "r1", text: "report", streaming: false, parentToolUseId: "T1"),
      .assistantText(id: "main", text: "meanwhile", streaming: false, parentToolUseId: nil),
    ]
    let frame = subagentItems(items, parentToolUseId: "T1")
    #expect(frame.map(\.id) == ["b1", "th1", "c1", "r1"])
  }

  /// Stream ids are namespaced per sidechain (`streaming:<parentId>`), so a
  /// frame picks up in-flight text for free — proven through the reducer, which
  /// is what actually stamps the parent, not through a hand-built item.
  @Test("a streaming item lands in its agent's frame")
  func streamingItemIsFrameMember() {
    let delta = StreamDeltaEvent(
      event: .init(type: "content_block_delta", delta: .init(type: "text_delta", text: "Half a ")),
      parentToolUseId: "T1", uuid: "s1")
    let state = applyEvent(
      TranscriptState.initial, SessionEvent(seq: 1, ts: 0, body: .streamDelta(delta)))
    let frame = subagentItems(state.items, parentToolUseId: "T1")
    #expect(frame.count == 1)
    guard case .assistantText(let id, let text, let streaming, let parent) = frame[0] else {
      Issue.record("expected the in-flight text")
      return
    }
    #expect(id == "streaming:T1")
    #expect(text == "Half a ")
    #expect(streaming)
    #expect(parent == "T1")
    // And it is nobody else's.
    #expect(subagentItems(state.items, parentToolUseId: "T2").isEmpty)
  }

  /// The doc on `subagentItems` claims the slice folds like a transcript:
  /// consecutive calls still make a run, because the run fold keys on an
  /// *equal* parent rather than on the absence of one.
  @Test("a frame's consecutive calls still fold into a run")
  func frameSliceFolds() {
    let frame: [TranscriptItem] = [
      .user(id: "b1", text: "brief", parentToolUseId: "T1"),
      .toolCall(call("c1", parent: "T1")),
      .toolCall(call("c2", parent: "T1")),
      .assistantText(id: "r1", text: "report", streaming: false, parentToolUseId: "T1"),
    ]
    let blocks = terminalBlocks(frame)
    #expect(blocks.count == 3)
    guard case .run(let run) = blocks[1] else { Issue.record("expected a run"); return }
    #expect(run.run.map(\.id) == ["c1", "c2"])
  }

  // MARK: - taskIdentity

  @Test("taskIdentity names the agent and what it was asked for")
  func identityBothFields() {
    #expect(taskIdentity(task("T1")) == "Explore · find the tests")
  }

  @Test("taskIdentity falls back a field at a time")
  func identityFallbacks() {
    #expect(taskIdentity(task("T1", description: nil)) == "Explore")
    #expect(taskIdentity(task("T1", agent: nil)) == "find the tests")
    // Whitespace is not an identity: a blank field yields to the other one.
    #expect(taskIdentity(task("T1", agent: "  ")) == "find the tests")
    #expect(taskIdentity(task("T1", description: "  \n")) == "Explore")
  }

  @Test("taskIdentity clips a long description the way the row does")
  func identityClips() {
    let long = String(repeating: "x", count: 120)
    let identity = taskIdentity(task("T1", description: long))
    #expect(identity == "Explore · " + String(repeating: "x", count: 79) + "…")
  }

  // MARK: - The press

  /// The phone's divergence, stated in `TermPress.openSubagent`: the Task row's
  /// one press is the takeover, and every collapsed line carries it — a thumb
  /// gets the whole block as one target.
  @Test("a collapsed Task row's press is the takeover")
  func collapsedTaskPressOpensSubagent() {
    let blocks = terminalBlocks([
      .toolCall(task("T1")),
      .user(id: "b1", text: "brief", parentToolUseId: "T1"),
      .toolCall(call("c1", parent: "T1")),
    ])
    guard case .task(let block) = blocks.first else { Issue.record("expected a task"); return }
    let lines = TerminalPlanner.plan(.task(block), metrics: metrics)
    #expect(!lines.isEmpty)
    #expect(lines.allSatisfy { $0.press == .openSubagent(taskId: "T1") })
  }

  /// Open (the preview harness's expand-all state), the header still raises the
  /// takeover while the children keep their own presses — a child's result is
  /// its own target, never the frame's.
  @Test("an open Task keeps the takeover on its header only")
  func openTaskHeaderPress() {
    let child = call("c1", parent: "T1", result: ToolCallResult(text: "output", isError: false))
    let blocks = terminalBlocks([.toolCall(task("T1")), .toolCall(child)])
    guard case .task(let block) = blocks.first else { Issue.record("expected a task"); return }
    var expansion = TerminalExpansion()
    expansion.apply(.toggle(block.expansionKey), subtree: [])
    let lines = TerminalPlanner.plan(.task(block), metrics: metrics, expansion: expansion)
    #expect(lines.first?.press == .openSubagent(taskId: "T1"))
    #expect(lines.contains { $0.press == .toggle(.call("c1")) })
  }

  // MARK: - The frame's nesting

  /// Inside the frame those items are the top level (web `nestedClass`): the
  /// agent's own rows shed the step, a stray grandchild keeps it — and the
  /// height book reads the same value the planner does, because `nested`
  /// spends cells and so changes the wrap.
  @Test("frameParentId suppresses the step for the frame's own rows only")
  func frameNesting() {
    let own = TranscriptRow.block(
      .item(
        TerminalItemBlock(
          key: "assistantText:r1",
          item: .assistantText(id: "r1", text: "report", streaming: false, parentToolUseId: "T1"),
          index: 0)))
    let other = TranscriptRow.block(
      .item(
        TerminalItemBlock(
          key: "assistantText:r2",
          item: .assistantText(id: "r2", text: "aside", streaming: false, parentToolUseId: "T9"),
          index: 1)))

    let ownLines = TerminalPlanner.plan(own, metrics: metrics, frameParentId: "T1")
    let otherLines = TerminalPlanner.plan(other, metrics: metrics, frameParentId: "T1")
    #expect(ownLines.allSatisfy { !$0.nested })
    #expect(otherLines.allSatisfy { $0.nested })
    // Un-framed, the same row steps in — the suppression is the frame's alone.
    #expect(TerminalPlanner.plan(own, metrics: metrics).allSatisfy { $0.nested })

    // The one claim this renderer cannot afford to get wrong, restated for the
    // frame: the book's height is the plan's line count, same value both sides.
    let rows = TerminalRows(rows: [own, other])
    let book = TerminalHeightBook(rows: rows, metrics: metrics, frameParentId: "T1")
    #expect(book.height(at: 0) == CGFloat(ownLines.count) * metrics.line)
  }

  // MARK: - The strip

  @Test("the strip claims what the Task row claims")
  func stripClaims() {
    let running = task("T1", status: .running)
    let children: [TranscriptItem] = [
      .toolCall(call("c1", parent: "T1")),
      .toolCall(call("c2", parent: "T1", status: .running)),
    ]
    let live = subagentStripLine(task: running, items: children, fallbackLabel: "Sub-agent")
    #expect(live.name == "Explore · find the tests")
    #expect(live.status == "working…")
    #expect(live.busy)
    #expect(live.toolCount == 2)

    let settled = subagentStripLine(
      task: task("T1"), items: [.toolCall(call("c1", parent: "T1"))], fallbackLabel: "Sub-agent")
    #expect(settled.status == "done")
    #expect(!settled.busy)

    var failedTask = task("T1")
    failedTask.result = ToolCallResult(text: "boom", isError: true)
    let failed = subagentStripLine(task: failedTask, items: [], fallbackLabel: "Sub-agent")
    #expect(failed.status == "failed")
    #expect(failed.failed)
  }

  /// No `Task` call to read: the label is the rollup's, and the status is
  /// silent — better than confidently wrong about an agent we cannot see.
  @Test("the strip without a task names the agent and claims nothing")
  func stripFallback() {
    let line = subagentStripLine(task: nil, items: [], fallbackLabel: "Explore")
    #expect(line.name == "Explore")
    #expect(line.status == nil)
    #expect(!line.busy && !line.failed)
  }

  // MARK: - The sub-task reveal

  /// The other half of the agent/task split. A **task** step names a tool call
  /// with no agent behind it, so it has no frame to open — the press opens the
  /// session and travels to that call's own row instead. This is the first hop
  /// of that journey, and the reason it answers in **item** space: rows are
  /// refolded on every revision and every rotation, items are not.
  @Test("toolCallItemIndex finds a call's own position, whatever nests it")
  func revealFindsTheCall() {
    let items: [TranscriptItem] = [
      .user(id: "u1", text: "go"),
      .toolCall(task("T1")),
      .toolCall(call("c1", parent: "T1")),
      .toolCall(call("c2")),
    ]
    // The spawning call itself, which `subagentItems` deliberately excludes —
    // a task reveal wants exactly the row that frame refuses to contain.
    #expect(toolCallItemIndex(items, id: "T1") == 1)
    // A nested call is findable too: this is "where is this id", not "where is
    // this top-level id".
    #expect(toolCallItemIndex(items, id: "c1") == 2)
    #expect(toolCallItemIndex(items, id: "c2") == 3)
  }

  /// An id the transcript does not hold answers nil rather than zero, which is
  /// what lets the caller keep waiting out the replay instead of scrolling the
  /// reader to the top of a transcript that has not finished arriving.
  @Test("an absent id is nil, not the first row")
  func revealMissesHonestly() {
    let items: [TranscriptItem] = [.user(id: "u1", text: "go"), .toolCall(call("c1"))]
    #expect(toolCallItemIndex(items, id: "nope") == nil)
    #expect(toolCallItemIndex([], id: "c1") == nil)
  }
}

extension ToolCallItem {
  fileprivate func with(status: ToolCallStatus) -> ToolCallItem {
    var copy = self
    copy.status = status
    return copy
  }
}
