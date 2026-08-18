import Foundation
import Testing

@testable import WorkerDeckKit

/// The strings and the wrapping — a port of `packages/ui/test/tool-run.test.ts`,
/// `result-preview.test.ts` and the `textLines` half of the height audit.
///
/// These are tested rather than eyeballed because in this theme the string *is*
/// the height: a row is measured by wrapping the exact text it will draw, so a
/// wording change is a layout change.
@Suite("TerminalText")
struct TerminalTextTests {
  private func call(_ name: String, id: String = "x", status: ToolCallStatus = .settled)
    -> ToolCallItem
  {
    ToolCallItem(id: id, name: name, input: .object([:]), status: status)
  }

  // MARK: - Families

  @Test("an MCP tool is counted under its server, not its name")
  func mcpFamily() {
    #expect(toolFamily("mcp__roam_code__search") == "roam-code")
    #expect(toolFamily("mcp__figma__get_design_context") == "figma")
    #expect(toolFamily("Bash") == "shell")
    #expect(toolFamily("CodexCommand") == "shell")
    #expect(toolFamily("Read") == "read")
  }

  // MARK: - Run summaries

  @Test("an all-shell run reads as shell commands")
  func shellRunWording() {
    #expect(runSummary([call("Bash"), call("Bash"), call("Bash")], busy: false) == "Ran 3 shell commands")
    #expect(runSummary([call("Bash")], busy: false) == "Ran 1 shell command")
    #expect(runSummary([call("Bash")], busy: true) == "Running 1 shell command…")
  }

  @Test("a mixed run breaks down by family, commonest first")
  func mixedRunWording() {
    let run = [
      call("Read"), call("mcp__roam_code__x"), call("mcp__roam_code__y"),
      call("mcp__roam_code__z"), call("Bash"), call("Bash"),
    ]
    // Count descending, then alphabetical — load-bearing rather than tidy: an
    // unstable order would remeasure the row for nothing.
    #expect(runSummary(run, busy: false) == "Ran 6 tools · 3 roam-code, 2 shell, 1 read")
  }

  @Test("the ellipsis trails the whole line, not the count")
  func busyEllipsisPlacement() {
    #expect(runSummary([call("Read"), call("Bash")], busy: true) == "Running 2 tools · 1 read, 1 shell…")
  }

  // MARK: - Task summaries

  @Test("a Task names its agent and what it was asked for")
  func taskLabelWording() {
    let task = ToolCallItem(
      id: "t", name: "Task",
      input: .object([
        "subagent_type": .string("Explore"), "description": .string("permission mode parsing"),
      ]), status: .settled)
    #expect(taskLabel(task) == "Task(Explore · permission mode parsing)")
    #expect(
      taskSummary(task, [.toolCall(call("Bash", id: "c1")), .toolCall(call("Read", id: "c2"))])
        == "Task(Explore · permission mode parsing) · 2 tools")
  }

  @Test("a Task with no calls yet says what it is doing")
  func taskSummaryEmpty() {
    let running = ToolCallItem(
      id: "t", name: "Task", input: .object(["subagent_type": .string("Plan")]), status: .running)
    #expect(taskSummary(running, []) == "Task(Plan) · working…")
    var done = running
    done.status = .settled
    #expect(taskSummary(done, []) == "Task(Plan) · done")
  }

  @Test("a child still working keeps the whole Task pulsing")
  func taskBusyFromChild() {
    // The Task call itself can settle while a bridged or deferred child runs on;
    // a pulse that stopped there would read as a hang.
    let task = ToolCallItem(id: "t", name: "Task", input: .object([:]), status: .settled)
    #expect(taskBusy(task, [.toolCall(call("Bash", id: "c", status: .running))]) == true)
    #expect(taskBusy(task, [.toolCall(call("Bash", id: "c", status: .settled))]) == false)
  }

  // MARK: - Result previews

  @Test("a long single line is cut by characters, not lines")
  func minifiedJsonIsClipped() {
    // The blind spot the character budget exists for: a minified MCP reply is
    // ONE line, so a four-line slice kept all thirty thousand characters of it
    // and the row did not even offer the affordance.
    let blob = String(repeating: "x", count: 30_000)
    let result = ResultPreview.collapsed([blob])
    #expect(result.shown.count == 1)
    #expect(result.shown[0].count == ResultPreview.previewChars + 1)  // + the ellipsis
    #expect(result.more == "… +29,600 chars")
  }

  @Test("many short lines are cut by lines")
  func manyLinesAreClipped() {
    let lines = (1...10).map { "line \($0)" }
    let result = ResultPreview.collapsed(lines)
    #expect(result.shown == ["line 1", "line 2", "line 3", "line 4"])
    #expect(result.more == "… +6 lines")
  }

  @Test("a result that fits offers no affordance")
  func shortResultHasNoMore() {
    let result = ResultPreview.collapsed(["one", "two"])
    #expect(result.shown.count == 2)
    #expect(result.more == nil)
  }

  @Test("the line budget yields to the character budget")
  func charBudgetWinsWithinFourLines() {
    // Four lines that together blow the character budget must stop early —
    // otherwise "4 lines" silently means 1,200 characters. One 300-character
    // line already spends three quarters of the budget, so the second is
    // refused and three lines stay hidden.
    let lines = (1...4).map { _ in String(repeating: "y", count: 300) }
    let result = ResultPreview.collapsed(lines)
    #expect(result.shown.count == 1)
    #expect(result.more == "… +3 lines")
  }

  // MARK: - Wrapping

  @Test("a word too long for the column fills whole lines")
  func breakWord() {
    #expect(TerminalCells.textLines(String(repeating: "a", count: 25), cols: 10).lines == 3)
  }

  @Test("a word moves to its own line before it fills any")
  func wordMovesFirst() {
    // "ab " then a 25-cell word at cols 10: the word starts a new line, then
    // fills — 1 + 3, not 3.
    #expect(TerminalCells.textLines("ab " + String(repeating: "a", count: 25), cols: 10).lines == 4)
  }

  @Test("trailing spaces hang rather than forcing a wrap")
  func spacesHang() {
    // Preserved spaces hang at the end of a line (CSS Text 3, and what every
    // terminal does). Asserted with spaces that push well past the column —
    // a run that merely fits would prove nothing.
    #expect(TerminalCells.textLines("abc" + String(repeating: " ", count: 40), cols: 10).lines == 1)
  }

  @Test("a hyphen breaks unless a digit follows it")
  func breakAfterHyphen() {
    // `protocol-0.16.0` must stay together; `alpha-beta` may break.
    #expect(TerminalCells.textLines("protocol-0.16.0", cols: 10).lines == 2)
    // At 10 columns `alpha-beta` still fits on one line; at 8 it splits at the
    // hyphen rather than mid-word.
    #expect(TerminalCells.wrapped("xxxxxxxx alpha-beta", cols: 10) == ["xxxxxxxx ", "alpha-beta"])
    #expect(TerminalCells.wrapped("xxxxxxxx alpha-beta", cols: 8) == ["xxxxxxxx ", "alpha-", "beta"])
  }

  @Test("newlines are hard breaks")
  func hardLines() {
    #expect(TerminalCells.textLines("a\nb\nc", cols: 80).lines == 3)
    #expect(TerminalCells.textLines("", cols: 80).lines == 1)
  }

  @Test("a wide glyph costs two cells and flags itself inexact")
  func wideGlyphs() {
    #expect(TerminalCells.clusterCells("あ").cells == 2)
    #expect(TerminalCells.clusterCells("あ").exact == false)
    #expect(TerminalCells.clusterCells("a").cells == 1)
    #expect(TerminalCells.clusterCells("a").exact == true)
    // An emoji built from a ZWJ sequence is one cluster and two cells.
    #expect(TerminalCells.clusterCells("👩‍💻").cells == 2)
    #expect(TerminalCells.textLines("あいうえお", cols: 6).exact == false)
  }

  @Test("wrapping loses no characters")
  func wrapIsLossless() {
    // The renderer draws these lines, so anything the wrapper drops is gone from
    // the transcript rather than merely mismeasured.
    let source = "the quick brown fox jumps over the lazy dog\nand a second paragraph here"
    for cols in [6, 11, 17, 40] {
      let joined = TerminalCells.wrapped(source, cols: cols).joined()
      #expect(joined == source.replacingOccurrences(of: "\n", with: ""), "cols \(cols)")
    }
  }
}
