import Foundation
import Testing

@testable import WorkerDeckKit

/// Row addressing and deterministic heights.
///
/// `rowIndex(forItem:)` is the one that earns a suite of its own: a row covers a
/// *membership*, not a range, so every positional shortcut anyone reaches for —
/// "the row is the item index", "the row before it starts earlier" — is wrong in
/// the presence of a fold.
@Suite("TerminalRows")
struct TerminalRowsTests {
  private func call(_ id: String, _ name: String = "Bash", parent: String? = nil) -> ToolCallItem {
    ToolCallItem(id: id, name: name, input: .object([:]), parentToolUseId: parent, status: .settled)
  }
  private func text(_ id: String, _ body: String = "hi") -> TranscriptItem {
    .assistantText(id: id, text: body, streaming: false, parentToolUseId: nil)
  }
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)

  // MARK: - Addressing

  @Test("an absorbed item resolves to the Task row that swallowed it")
  func absorbedItemsResolve() {
    let rows = TerminalRows.build(items: [
      text("intro"),                                  // 0
      .toolCall(call("t1", "Task")),                  // 1 → row 1
      .toolCall(call("c1", parent: "t1")),            // 2 absorbed
      .toolCall(call("c2", parent: "t1")),            // 3 absorbed
      text("outro"),                                  // 4 → row 2
    ])
    #expect(rows.count == 3)
    #expect(rows.rowIndex(forItem: 0) == 0)
    #expect(rows.rowIndex(forItem: 1) == 1)
    #expect(rows.rowIndex(forItem: 2) == 1)
    #expect(rows.rowIndex(forItem: 3) == 1)
    #expect(rows.rowIndex(forItem: 4) == 2)
  }

  @Test("an item folded into a run resolves to the run's row")
  func foldedItemsResolve() {
    let rows = TerminalRows.build(items: [
      text("intro"), .toolCall(call("a")), .toolCall(call("b")), .toolCall(call("c")),
    ])
    #expect(rows.count == 2)
    // The run is one row; every member answers with it, including the last —
    // which index arithmetic on the run's start would get right only by luck.
    for item in 1...3 { #expect(rows.rowIndex(forItem: item) == 1) }
  }

  @Test("a run records every member's global index, across an absorbed gap")
  func runIndicesSkipAbsorbed() {
    // Two top-level calls separated only by a subagent's step are adjacent on
    // screen, so `[index, index + count)` cannot describe the run's coverage.
    let rows = TerminalRows.build(items: [
      .toolCall(call("T", "Task")),                   // 0
      .toolCall(call("a")),                           // 1 ┐ one run
      .toolCall(call("c", parent: "T")),              // 2 absorbed
      .toolCall(call("b")),                           // 3 ┘
      text("done"),                                   // 4
    ])
    guard case .block(.run(let run)) = rows[1] else {
      Issue.record("expected a run at row 1")
      return
    }
    #expect(run.indices == [1, 3])
    #expect(run.index == 1)
  }

  @Test("an item that shares its row knows where it sits in it")
  func sharedRowPositions() {
    let rows = TerminalRows.build(items: [
      text("intro"),                                  // 0 own row
      .toolCall(call("T", "Task")),                   // 1 ┐
      .toolCall(call("c0", parent: "T")),             // 2 │ absorbed
      .toolCall(call("c1", parent: "T")),             // 3 ┘
      .toolCall(call("x")),                           // 4 ┐ run of two
      .toolCall(call("y")),                           // 5 ┘
    ])
    #expect(rows.position(forItem: 2) == RowPosition(ordinal: 0, count: 2))
    #expect(rows.position(forItem: 3) == RowPosition(ordinal: 1, count: 2))
    #expect(rows.position(forItem: 4) == RowPosition(ordinal: 0, count: 2))
    #expect(rows.position(forItem: 5) == RowPosition(ordinal: 1, count: 2))
    // A row's own head item, the Task itself, and out-of-range have none.
    #expect(rows.position(forItem: 0) == nil)
    #expect(rows.position(forItem: 1) == nil)
    #expect(rows.position(forItem: -1) == nil)
    #expect(rows.position(forItem: 99) == nil)
  }

  @Test("a run of one has no position — the rail must stay a map")
  func singletonRunHasNoPosition() {
    // The fold makes EVERY top-level tool call a run block. Without this
    // carve-out every ordinary failed call's mark would shrink from its row's
    // extent to a tick.
    let rows = TerminalRows.build(items: [text("intro"), .toolCall(call("a")), text("outro")])
    #expect(rows.position(forItem: 1) == nil)
  }

  @Test("the recap seam is never the answer")
  func recapIsNeverTheAnswer() {
    let rows = TerminalRows.build(
      items: [text("a"), text("b"), text("c"), text("d")], recapAt: 2, recapLabel: "2 new")
    // rows: a, b, <recap>, c, d
    #expect(rows.count == 5)
    if case .recap = rows[2] {} else { Issue.record("expected the seam at row 2") }
    #expect(rows.rowIndex(forItem: 1) == 1)
    #expect(rows.rowIndex(forItem: 2) == 3)
    #expect(rows.rowIndex(forItem: 3) == 4)
  }

  @Test("each side of the recap seam folds separately")
  func seamBreaksARun() {
    // A count under the seam must describe only what is new — a run spanning
    // "what you already read" would claim otherwise.
    let rows = TerminalRows.build(
      items: [.toolCall(call("a")), .toolCall(call("b")), .toolCall(call("c"))], recapAt: 2)
    #expect(rows.count == 3)  // run(a,b) + recap + run(c)
    guard case .block(.run(let first)) = rows[0], case .block(.run(let last)) = rows[2] else {
      Issue.record("expected a run on either side")
      return
    }
    #expect(first.run.count == 2)
    #expect(last.run.count == 1)
    #expect(last.index == 2)  // offset carried across the seam
  }

  // MARK: - Heights

  @Test("a row's height is exactly the lines it draws")
  func heightIsLineCount() {
    let rows = TerminalRows.build(items: [text("intro", "one line")])
    let book = TerminalHeightBook(rows: rows, metrics: metrics)
    #expect(book.height(at: 0) == metrics.line)
    #expect(book.totalHeight == metrics.line)
    // No prediction to be wrong: the planner wraps, the renderer draws what it
    // returned, so the count and the height cannot disagree.
    #expect(TerminalPlanner.plan(rows[0], metrics: metrics).count == 1)
  }

  @Test("a blank line above a row is part of that row's height")
  func gapRidesTheRow() {
    // A standalone blank would be a row of its own and every index below it
    // would be off by however many blanks preceded it.
    let rows = TerminalRows.build(items: [text("a", "x"), text("b", "y")])
    let book = TerminalHeightBook(rows: rows, metrics: metrics)
    #expect(book.height(at: 0) == metrics.line)
    #expect(book.height(at: 1) == 2 * metrics.line)
    #expect(book.offset(at: 1) == metrics.line)
    #expect(book.totalHeight == 3 * metrics.line)
  }

  @Test("two tool rows sit flush, with no blank between them")
  func toolRowsSitFlush() {
    let rows = TerminalRows.build(items: [
      .toolCall(call("a")), text("t"), .toolCall(call("b", "Read")),
    ])
    let book = TerminalHeightBook(rows: rows, metrics: metrics)
    #expect(book.height(at: 0) == metrics.line)          // run, no gap above
    #expect(book.height(at: 1) == 2 * metrics.line)      // prose, blank above
  }

  @Test("a collapsed Task is always one wrapped summary, however much it did")
  func taskRowStaysCollapsed() {
    // The invariant that keeps the height exact: the live signal is IN the
    // collapsed line — the pulse, a climbing count — never an auto-expansion.
    var items: [TranscriptItem] = [.toolCall(call("t1", "Task"))]
    for index in 0..<60 { items.append(.toolCall(call("c\(index)", parent: "t1"))) }
    let rows = TerminalRows.build(items: items)
    let book = TerminalHeightBook(rows: rows, metrics: metrics)
    #expect(rows.count == 1)
    #expect(book.height(at: 0) == metrics.line)
  }

  @Test("a wrapped row is as many lines as it wraps to")
  func wrappedRowsGrow() {
    let long = String(repeating: "word ", count: 60)
    let rows = TerminalRows.build(items: [text("a", long)])
    let book = TerminalHeightBook(rows: rows, metrics: metrics)
    let planned = TerminalPlanner.plan(rows[0], metrics: metrics)
    #expect(planned.count > 3)
    #expect(book.height(at: 0) == CGFloat(planned.count) * metrics.line)
  }

  @Test("offsets and the reverse lookup agree")
  func offsetLookupRoundTrips() {
    var items: [TranscriptItem] = []
    for index in 0..<200 { items.append(text("t\(index)", "row \(index)")) }
    let rows = TerminalRows.build(items: items)
    let book = TerminalHeightBook(rows: rows, metrics: metrics)
    for index in 0..<rows.count {
      #expect(book.rowIndex(atOffset: book.offset(at: index)) == index, "row \(index)")
      #expect(book.rowIndex(atOffset: book.offset(at: index) + 1) == index, "row \(index) + 1")
    }
    #expect(book.offset(at: rows.count) == book.totalHeight)
  }

  @Test("the plan cache returns what a cold plan would")
  func cacheAgreesWithColdPlan() {
    var items: [TranscriptItem] = []
    for index in 0..<50 { items.append(text("t\(index)", String(repeating: "x", count: index * 7))) }
    let rows = TerminalRows.build(items: items)
    let cache = TerminalPlanCache()
    let warm = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache)
    let cold = TerminalHeightBook(rows: rows, metrics: metrics)
    #expect(warm.totalHeight == cold.totalHeight)
    // A second build hits the cache for every row and must still agree.
    let again = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache)
    #expect(again.totalHeight == cold.totalHeight)
  }

  @Test("a parallel cold build agrees with a serial one, row for row")
  func parallelPlanAgreesWithSerial() {
    // Above `TerminalHeightBook.parallelPlanThreshold` the misses are planned on
    // worker threads writing disjoint indices. Row for row, not just in total:
    // a transposition would leave the sum right and every offset wrong, which is
    // precisely the failure a virtualizer cannot survive and a total cannot see.
    var items: [TranscriptItem] = []
    for index in 0..<600 {
      items.append(text("t\(index)", String(repeating: "word\(index) ", count: 1 + index % 23)))
    }
    let rows = TerminalRows.build(items: items)
    #expect(rows.count >= 512)

    let book = TerminalHeightBook(rows: rows, metrics: metrics)
    for index in 0..<rows.count {
      let lines = TerminalPlanner.plan(rows[index], metrics: metrics).count
      let gap = rows.gapBefore(index) ? 1 : 0
      #expect(book.height(at: index) == CGFloat(lines + gap) * metrics.line, "row \(index)")
    }

    // And a cache filled by the parallel path answers the same on the next build.
    let cache = TerminalPlanCache()
    let first = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache)
    let second = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache)
    #expect(first.totalHeight == book.totalHeight)
    #expect(second.totalHeight == book.totalHeight)
  }

  @Test("a new cell clears the cache rather than answering from the old one")
  func cacheIsPerEpoch() {
    let rows = TerminalRows.build(items: [text("a", String(repeating: "word ", count: 40))])
    let cache = TerminalPlanCache()
    let wide = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache)
    let narrow = TerminalHeightBook(
      rows: rows, metrics: TerminalMetrics(cell: 8, line: 18, width: 8 * 20, fontSize: 13),
      cache: cache)
    #expect(narrow.totalHeight > wide.totalHeight)
  }
}

/// The rendering rules that are not the web client's.
///
/// Kept in their own suite so a future parity sweep finds them deliberately
/// stated rather than mistaking them for drift.
@Suite("TerminalDivergences")
struct TerminalDivergenceTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)

  @Test("a run of one draws the call, not a count of it")
  func singleCallIsNotSummarised() {
    // The web client spells this `Ran 1 tool · 1 read`, which costs the same one
    // row and throws away the name, the input and the result preview. A fold
    // that compresses nothing should not also hide something.
    let call = ToolCallItem(
      id: "c1", name: "Read", input: .object(["file_path": .string("/src/height.ts")]),
      status: .settled, result: ToolCallResult(text: "740 lines", isError: false))
    let rows = TerminalRows.build(items: [.toolCall(call)])
    let plan = TerminalPlanner.plan(rows[0], metrics: metrics)
    #expect(plan.first?.text.hasPrefix("Read(/src/height.ts)") == true)
    #expect(plan.contains { $0.text.contains("740 lines") })
    #expect(plan.allSatisfy { !$0.text.contains("Ran 1 tool") })
  }

  @Test("the preview budget is four lines' worth at any width")
  func previewBudgetFollowsTheWidth() {
    // 400 characters is "about four lines" at a hundred columns and thirteen
    // lines at thirty — a preview that fills a phone screen.
    let blob = String(repeating: "x", count: 30_000)
    let narrow = ResultPreview.collapsed([blob], cols: 30)
    let wide = ResultPreview.collapsed([blob], cols: 100)
    // Exactly four lines' worth, ellipsis included — a fifth line holding only
    // the ellipsis is the artefact this arithmetic exists to avoid.
    #expect(narrow.shown[0].count == 4 * 30)
    #expect(wide.shown[0].count == 4 * 100)
    #expect(TerminalCells.textLines(narrow.shown[0], cols: 30).lines == 4)
    #expect(TerminalCells.textLines(wide.shown[0], cols: 100).lines == 4)
  }

  @Test("two calls still fold into a count")
  func twoCallsStillFold() {
    // The divergence is exactly at one; the fold itself is unchanged.
    let a = ToolCallItem(id: "a", name: "Bash", input: .object([:]), status: .settled)
    let b = ToolCallItem(id: "b", name: "Read", input: .object([:]), status: .settled)
    let rows = TerminalRows.build(items: [.toolCall(a), .toolCall(b)])
    let plan = TerminalPlanner.plan(rows[0], metrics: metrics)
    #expect(plan.count == 1)
    #expect(plan[0].text == "Ran 2 tools · 1 read, 1 shell")
  }
}
