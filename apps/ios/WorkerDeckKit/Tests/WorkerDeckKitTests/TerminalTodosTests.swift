import Foundation
import Testing

@testable import WorkerDeckKit

/// The `TodoWrite` checklist.
///
/// Two things earn a suite: the parse is deliberately **whole-or-nothing**, so
/// the half-delivered input a streaming call produces must fall back rather than
/// draw a checklist missing its last item; and every glyph must be **one cell**,
/// because a two-cell glyph puts the entire checklist one column out of step
/// with the grid the theme's heights are measured on.
@Suite("TerminalTodos")
struct TerminalTodosTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)

  private func todo(_ status: String, _ content: String, active: String? = nil) -> JSONValue {
    var fields: [String: JSONValue] = ["status": .string(status), "content": .string(content)]
    if let active { fields["activeForm"] = .string(active) }
    return .object(fields)
  }
  private func input(_ todos: JSONValue...) -> JSONValue { .object(["todos": .array(todos)]) }

  private func call(_ input: JSONValue, result: String? = nil) -> ToolCallItem {
    ToolCallItem(
      id: "t1", name: "TodoWrite", input: input, status: .settled,
      result: result.map { ToolCallResult(text: $0, isError: false) })
  }

  // MARK: - The glyphs

  @Test("every status glyph is exactly one cell")
  func glyphsAreOneCell() {
    for status in [TerminalTodos.Status.pending, .inProgress, .completed] {
      let glyph = TerminalTodos.glyph(status)
      #expect(glyph.count == 1)
      let width = TerminalCells.clusterCells(glyph.first!)
      // Exact as well as one: a glyph the measurer only *guesses* is one cell
      // makes every line under it a guess, and the height book stops being a
      // fact. That is the difference between ☐ and an emoji checkbox.
      #expect(width.cells == 1)
      #expect(width.exact)
    }
  }

  // MARK: - Parsing

  @Test("a malformed entry falls back whole rather than drawing a partial list")
  func parseIsWholeOrNothing() {
    // Exactly what a streaming input looks like a keystroke before it is done.
    let partial = input(todo("completed", "one"), .object(["status": .string("pending")]))
    #expect(TerminalTodos.parse(partial) == nil)
    #expect(TerminalTodos.preview(name: "TodoWrite", input: partial) == nil)
    // An unknown status is not a status.
    #expect(TerminalTodos.parse(input(todo("skipped", "one"))) == nil)
    // Neither is a blank content.
    #expect(TerminalTodos.parse(input(todo("pending", "   "))) == nil)
    // Neither is an empty list — there is nothing to say about it.
    #expect(TerminalTodos.parse(.object(["todos": .array([])])) == nil)
    #expect(TerminalTodos.parse(.object([:])) == nil)
  }

  @Test("only an in-progress entry wears its active form")
  func activeFormIsForTheRunningOne() {
    let todos = TerminalTodos.parse(
      input(
        todo("in_progress", "Wire the planner", active: "Wiring the planner"),
        todo("pending", "Write the tests", active: "Writing the tests")))
    #expect(todos?.map(\.text) == ["Wiring the planner", "Write the tests"])
    // A blank active form is not an active form.
    let blank = TerminalTodos.parse(input(todo("in_progress", "Wire it", active: "  ")))
    #expect(blank?.first?.text == "Wire it")
  }

  @Test("only TodoWrite gets a checklist")
  func onlyTodoWrite() {
    #expect(TerminalTodos.preview(name: "Bash", input: input(todo("pending", "one"))) == nil)
  }

  // MARK: - The preview

  @Test("the summary counts what is done, not what is running")
  func summaryCountsCompleted() {
    let preview = TerminalTodos.preview(
      name: "TodoWrite",
      input: input(
        todo("completed", "one"), todo("completed", "two"), todo("in_progress", "three"),
        todo("pending", "four")))
    #expect(preview?.summary == "2/4 done")
  }

  @Test("nine entries draw eight and count the ninth")
  func previewBudget() {
    let nine = (1...9).map { todo("pending", "item \($0)") }
    let preview = TerminalTodos.preview(name: "TodoWrite", input: .object(["todos": .array(nine)]))
    #expect(preview?.shown.count == TerminalTodos.previewTodos)
    #expect(preview?.more == "… +1 more")
    // Exactly eight has nothing left to count.
    let eight = (1...8).map { todo("pending", "item \($0)") }
    #expect(TerminalTodos.preview(name: "TodoWrite", input: .object(["todos": .array(eight)]))?.more == nil)
  }

  // MARK: - The planned row

  @Test("the header counts the checklist instead of echoing the input")
  func headerCarriesTheSummary() {
    let lines = TerminalPlanner.planToolCall(
      call(input(todo("completed", "one"), todo("pending", "two"))), metrics: metrics,
      expansion: TerminalExpansion(), inOpen: false)
    #expect(lines.first?.text.hasPrefix("TodoWrite(1/2 done)") == true)
  }

  @Test("the checklist stands in for the result preview, and gives way when opened")
  func checklistReplacesTheResultPreview() {
    let item = call(
      input(todo("completed", "one"), todo("in_progress", "two", active: "Doing two")),
      result: "Todos have been modified successfully")

    let collapsed = TerminalPlanner.planToolCall(
      item, metrics: metrics, expansion: TerminalExpansion(), inOpen: false)
    #expect(collapsed.map(\.text) == ["TodoWrite(1/2 done)", "☒ one", "◐ Doing two"])
    // The prose the checklist replaced is nowhere in the collapsed row.
    #expect(!collapsed.contains { $0.text.contains("successfully") })
    // The first checklist line wears the output marker; the rest are bare.
    #expect(collapsed[1].gutter == TermGlyph.output)
    #expect(collapsed[2].gutter == "")
    // Completed reads back, in-progress reads live.
    #expect(collapsed[1].tone == .faint)
    #expect(collapsed[2].tone == .blue)

    let open = TerminalPlanner.planToolCall(
      item, metrics: metrics, expansion: TerminalExpansion(open: [.call("t1")]), inOpen: false)
    #expect(open.contains { $0.text.contains("successfully") })
    #expect(!open.contains { $0.text.contains("☒") })
  }

  @Test("the overflow line is planned, so the row is as tall as it draws")
  func overflowLineIsPlanned() {
    let nine = (1...9).map { todo("pending", "item \($0)") }
    let lines = TerminalPlanner.planToolCall(
      call(.object(["todos": .array(nine)]), result: "ok"), metrics: metrics,
      expansion: TerminalExpansion(), inOpen: false)
    #expect(lines.count == 1 + TerminalTodos.previewTodos + 1)
    #expect(lines.last?.text == "… +1 more")
    #expect(lines.last?.tone == .faint)
  }
}
