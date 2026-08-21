import Foundation
import Testing

@testable import WorkerDeckKit

/// The sub-agent's brief: the spawning call's `prompt`, leading the takeover
/// frame and the inline task expansion alike, clipped to
/// `TerminalPlanner.briefLines` and pressable for the whole of it. The rules
/// under test are the ones two clients must agree on (web `BriefRow` /
/// `briefPx`): presence is `taskBrief` — no `prompt`, no row, which is every
/// codex task — the clip is a wrapped-line count, and on this renderer the
/// collapsed and expanded heights must both be exact in the book.
@Suite("Subagent brief")
struct SubagentBriefTests {
  /// 400pt at cell 8 with a 2-cell gutter: 48 columns for a top-level brief,
  /// 46 for a nested (inline) one.
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 400, fontSize: 13)

  private func call(
    _ id: String, _ name: String = "Bash", parent: String? = nil,
    result: String? = ""
  ) -> ToolCallItem {
    ToolCallItem(
      id: id, name: name, input: .object([:]), parentToolUseId: parent, status: .settled,
      result: result.map { ToolCallResult(text: $0, isError: false) })
  }

  private func task(_ id: String, prompt: String?) -> ToolCallItem {
    var input: [String: JSONValue] = [
      "subagent_type": .string("Explore"), "description": .string("find the tests"),
    ]
    if let prompt { input["prompt"] = .string(prompt) }
    return ToolCallItem(
      id: id, name: "Task", input: .object(input), parentToolUseId: nil, status: .running,
      result: nil)
  }

  /// An unbroken run wraps break-word style, filling whole 48-cell lines — the
  /// arithmetic stays exact.
  private func unbroken(_ chars: Int) -> String { String(repeating: "x", count: chars) }

  private var frameItems: [TranscriptItem] {
    [
      .thinking(id: "th1", text: "hm", parentToolUseId: "T1"),
      .toolCall(call("c1", parent: "T1")),
      .assistantText(id: "r1", text: "report", streaming: false, parentToolUseId: "T1"),
    ]
  }

  // MARK: - Presence

  @Test("the brief leads the frame's rows")
  func briefLeadsFrame() {
    let rows = TerminalRows.build(items: frameItems, frameTask: task("T1", prompt: "dig in"))
    #expect(rows.count == 4)
    #expect(rows[0] == .brief(id: "T1", text: "dig in"))
    #expect(rows[0].key == "brief:T1")
    // Synthetic, so it spaces like the recap seam: a blank on either side.
    #expect(rows.gapBefore(1))
  }

  /// A **foreground** Task forwards its brief as a real nested user item, so the
  /// frame already opens with it and the synthetic row must stand down — drawn
  /// both ways, the reader sees one instruction twice. A **background** agent
  /// forwards nothing, which is the case the synthetic row exists for.
  @Test("the stream's own brief wins over the call's prompt")
  func streamBriefWins() {
    let forwarded: [TranscriptItem] = [
      .user(id: "b1", text: "dig in", parentToolUseId: "T1"),
      .toolCall(call("c1", parent: "T1")),
    ]
    let rows = TerminalRows.build(items: forwarded, frameTask: task("T1", prompt: "dig in"))
    #expect(rows.rows.allSatisfy { if case .brief = $0 { false } else { true } })
    #expect(rows.count == 2)
    // The background case, unchanged: no user item, so the row leads.
    let background = TerminalRows.build(items: frameItems, frameTask: task("T1", prompt: "dig in"))
    #expect(background.rows.first == .brief(id: "T1", text: "dig in"))
  }

  /// The codex case: its spawn message is encrypted on the wire, so there is no
  /// row — not an empty one. Whitespace is not a brief either.
  @Test("a task without a prompt draws no brief row")
  func noPromptNoRow() {
    let bare = TerminalRows.build(items: frameItems, frameTask: task("T1", prompt: nil))
    #expect(bare.count == 3)
    #expect(bare.rows.allSatisfy { if case .brief = $0 { false } else { true } })
    let blank = TerminalRows.build(items: frameItems, frameTask: task("T1", prompt: "  \n "))
    #expect(blank.count == 3)
  }

  @Test("the brief leads the inline task expansion — and only the open one")
  func briefLeadsInlineExpansion() {
    let blocks = terminalBlocks([
      .toolCall(task("T1", prompt: "dig in")),
      .toolCall(call("c1", parent: "T1")),
    ])
    guard case .task(let block) = blocks.first else {
      Issue.record("expected a task")
      return
    }
    // Collapsed: the header line only, no brief.
    let collapsed = TerminalPlanner.plan(.task(block), metrics: metrics)
    #expect(!collapsed.contains { $0.gutter == TermGlyph.prompt })

    var expansion = TerminalExpansion()
    expansion.apply(.toggle(block.expansionKey), subtree: [])
    let open = TerminalPlanner.plan(.task(block), metrics: metrics, expansion: expansion)
    // Header first — the row's identity — then the brief, then the work.
    #expect(open[0].press == .openSubagent(taskId: "T1"))
    #expect(open[1].gutter == TermGlyph.prompt)
    #expect(open[1].text == "dig in")
    // Inline it is one of the frame's stepped-in rows; the child follows it.
    #expect(open[1].nested)
    #expect(open.count > 2)

    // The codex task opens straight onto its children.
    let bare = terminalBlocks([
      .toolCall(task("T2", prompt: nil)),
      .toolCall(call("c2", parent: "T2")),
    ])
    guard case .task(let bareBlock) = bare.first else {
      Issue.record("expected a task")
      return
    }
    var bareExpansion = TerminalExpansion()
    bareExpansion.apply(.toggle(bareBlock.expansionKey), subtree: [])
    let bareOpen = TerminalPlanner.plan(
      .task(bareBlock), metrics: metrics, expansion: bareExpansion)
    #expect(!bareOpen.contains { $0.gutter == TermGlyph.prompt })
  }

  // MARK: - The clip

  /// The clip is `briefLines` **wrapped** lines — the planner's own wrap, so the
  /// boundary is exact: four full 48-column lines fit untouched, one character
  /// more clips.
  @Test("the clip boundary is briefLines wrapped lines")
  func clipBoundary() {
    let cols = 48
    // Exactly four lines' worth: shown whole, no affordance, no press — a
    // target that visibly does nothing teaches the reader the theme is broken.
    let fits = TerminalPlanner.plan(
      .brief(id: "T1", text: unbroken(TerminalPlanner.briefLines * cols)), metrics: metrics)
    #expect(fits.count == TerminalPlanner.briefLines)
    #expect(fits.allSatisfy { $0.press == nil })

    // One character more: four lines shown, a faint `… +N lines` under them,
    // and the whole block is one target (every line carries the press).
    let over = TerminalPlanner.plan(
      .brief(id: "T1", text: unbroken(TerminalPlanner.briefLines * cols + 1)), metrics: metrics)
    #expect(over.count == TerminalPlanner.briefLines + 1)
    #expect(over.last?.text == "… +1 line")
    #expect(over.allSatisfy { $0.press == .toggle(.brief("T1")) })
  }

  @Test("the affordance counts the hidden wrapped lines")
  func affordanceCountsHiddenLines() {
    // 300 unbroken chars at 48 cols: 7 wrapped lines, 3 hidden.
    let lines = TerminalPlanner.plan(.brief(id: "T1", text: unbroken(300)), metrics: metrics)
    #expect(lines.count == TerminalPlanner.briefLines + 1)
    #expect(lines.last?.text == "… +3 lines")
    #expect(lines[0].gutter == TermGlyph.prompt)
    #expect(lines[1].gutter.isEmpty)
  }

  @Test("open shows the whole brief, still one target")
  func openShowsEverything() {
    let expansion = TerminalExpansion(open: [.brief("T1")])
    let lines = TerminalPlanner.plan(
      .brief(id: "T1", text: unbroken(300)), metrics: metrics, expansion: expansion)
    #expect(lines.count == 7)
    #expect(!lines.contains { $0.text.hasPrefix("…") })
    // The way back rides every line, and the open wash marks the state.
    #expect(lines.allSatisfy { $0.press == .toggle(.brief("T1")) && $0.inOpen })
  }

  /// An interior blank line is planned as a single space — a real line of the
  /// grid, never a zero-height fragment — and the trim means the edges can
  /// never hold one.
  @Test("hard newlines inside a brief are exact lines")
  func interiorBlankLines() {
    let lines = TerminalPlanner.plan(
      .brief(id: "T1", text: "first\n\nsecond"), metrics: metrics)
    #expect(lines.map(\.text) == ["first", " ", "second"])
  }

  // MARK: - Book and plan agree

  /// The one claim this renderer cannot afford to get wrong, restated for the
  /// brief: in both states the book's height is the drawn plan's line count,
  /// and the toggle's re-plan is scoped to the brief's own row.
  @Test("collapsed and expanded heights agree between book and plan")
  func bookAgreesWithPlan() {
    let rows = TerminalRows.build(
      items: frameItems, frameTask: task("T1", prompt: unbroken(300)))

    func check(_ expansion: TerminalExpansion) {
      let book = TerminalHeightBook(rows: rows, metrics: metrics, expansion: expansion)
      for index in 0..<rows.count {
        let planned = TerminalPlanner.plan(
          rows[index], metrics: metrics, expansion: expansion.subset(for: rows[index]))
        let gap: CGFloat = rows.gapBefore(index) ? 1 : 0
        #expect(book.height(at: index) == (CGFloat(planned.count) + gap) * metrics.line)
      }
    }

    check(TerminalExpansion())
    var expansion = TerminalExpansion()
    expansion.apply(.toggle(.brief("T1")), subtree: [.brief("T1")])
    check(expansion)

    // The isolation claim behind "re-plans only its own row": no other row can
    // read the brief's key, so the plan cache's second key is untouched for
    // every row but the brief's.
    #expect(expansion.subset(for: rows[0]) == TerminalExpansion(open: [.brief("T1")]))
    for index in 1..<rows.count {
      #expect(expansion.subset(for: rows[index]).isEmpty)
    }
  }

  /// Same claim one level in: toggling the inline brief re-plans the task's row
  /// and nothing else, and the book follows the plan in both states.
  @Test("the inline brief's toggle is scoped to the task's row")
  func inlineToggleScoped() {
    let rows = TerminalRows.build(items: [
      .user(id: "u1", text: "go", attachments: nil, parentToolUseId: nil),
      .toolCall(task("T1", prompt: unbroken(300))),
      .toolCall(call("c1", parent: "T1")),
      .assistantText(id: "a1", text: "done", streaming: false, parentToolUseId: nil),
    ])
    #expect(rows.count == 3)

    var expansion = TerminalExpansion(open: [.task("T1")])
    let taskRow = rows.rows.firstIndex { $0.key == "task:T1" }!
    let collapsedBrief = TerminalPlanner.plan(
      rows[taskRow], metrics: metrics, expansion: expansion.subset(for: rows[taskRow]))
    expansion.apply(.toggle(.brief("T1")), subtree: expansionKeys(of: rows[taskRow]))
    let openBrief = TerminalPlanner.plan(
      rows[taskRow], metrics: metrics, expansion: expansion.subset(for: rows[taskRow]))
    // Nested, the brief wraps at 46 columns: ⌈300/46⌉ = 7 lines either way,
    // clipped to 4 + the affordance when closed.
    #expect(openBrief.count - collapsedBrief.count == 7 - (TerminalPlanner.briefLines + 1))

    let book = TerminalHeightBook(rows: rows, metrics: metrics, expansion: expansion)
    #expect(
      book.height(at: taskRow)
        == (CGFloat(openBrief.count) + (rows.gapBefore(taskRow) ? 1 : 0)) * metrics.line)
    // The other rows read none of it.
    #expect(expansion.subset(for: rows[0]).isEmpty)
    #expect(expansion.subset(for: rows[2]).isEmpty)
  }

  // MARK: - The state's lifecycle

  /// Closing the task container forgets the brief with the rest of its subtree;
  /// a press on the brief itself is a leaf and takes nothing with it.
  @Test("the brief closes with its task and closes alone")
  func closeSemantics() {
    let blocks = terminalBlocks([
      .toolCall(task("T1", prompt: unbroken(300))),
      .toolCall(call("c1", parent: "T1", result: "out")),
    ])
    guard case .task(let block) = blocks.first else {
      Issue.record("expected a task")
      return
    }
    let subtree = expansionKeys(of: TerminalBlock.task(block))
    #expect(subtree.contains(.brief("T1")))

    var expansion = TerminalExpansion()
    expansion.apply(.toggle(.task("T1")), subtree: subtree)
    expansion.apply(.toggle(.brief("T1")), subtree: subtree)
    expansion.apply(.toggle(.call("c1")), subtree: subtree)
    // The brief is a leaf: closing it leaves the sibling result open.
    expansion.apply(.toggle(.brief("T1")), subtree: subtree)
    #expect(!expansion.isOpen(.brief("T1")))
    #expect(expansion.isOpen(.call("c1")))
    // Re-open, then close the container: everything inside goes with it.
    expansion.apply(.toggle(.brief("T1")), subtree: subtree)
    expansion.apply(.toggle(.task("T1")), subtree: subtree)
    #expect(!expansion.isOpen(.brief("T1")))
    #expect(!expansion.isOpen(.call("c1")))
  }

  /// The audit's input: `everything` opens the brief in the frame and inline,
  /// so the fully-expanded pass checks the whole instruction's wrap.
  @Test("everything(in:) opens the brief")
  func everythingOpensBrief() {
    let frame = TerminalRows.build(
      items: frameItems, frameTask: task("T1", prompt: unbroken(300)))
    #expect(TerminalExpansion.everything(in: frame).isOpen(.brief("T1")))

    let inline = TerminalRows.build(items: [
      .toolCall(task("T2", prompt: "dig in")), .toolCall(call("c1", parent: "T2")),
    ])
    let everything = TerminalExpansion.everything(in: inline)
    #expect(everything.isOpen(.brief("T2")))
    // And never invents one for a task with no prompt.
    let bare = TerminalRows.build(items: [
      .toolCall(task("T3", prompt: nil)), .toolCall(call("c2", parent: "T3")),
    ])
    #expect(!TerminalExpansion.everything(in: bare).open.contains(.brief("T3")))
  }

  // MARK: - The lookup

  @Test("subagentTask finds the spawning call the frame excludes")
  func taskLookup() {
    let spawning = task("T1", prompt: "dig in")
    let items: [TranscriptItem] = [.toolCall(spawning)] + frameItems
    #expect(subagentTask(items, id: "T1") == spawning)
    #expect(subagentTask(items, id: "T9") == nil)
    #expect(subagentItems(items, parentToolUseId: "T1").allSatisfy { $0.id != "T1" })
  }
}
