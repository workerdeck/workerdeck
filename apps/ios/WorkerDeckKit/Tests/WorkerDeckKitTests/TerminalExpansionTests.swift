import Foundation
import Testing

@testable import WorkerDeckKit

/// Expansion, which on this renderer is arithmetic rather than component state.
///
/// The web client can leave this untested because an expanded row is mounted
/// and the browser measures it. Here the planner has to *predict* the expanded
/// row, the layout takes every frame from that prediction, and a wrong one is a
/// clipped or overlapping row — so the properties below are the whole safety
/// net: a plan that changes with expansion, a cached height that agrees with a
/// cold one, and a row that is unaffected by a press somewhere else.
@Suite("TerminalExpansion")
struct TerminalExpansionTests {
  private func call(
    _ id: String, _ name: String = "Bash", parent: String? = nil, result: String? = nil,
    error: Bool = false
  ) -> ToolCallItem {
    ToolCallItem(
      id: id, name: name, input: .object([:]), parentToolUseId: parent, status: .settled,
      result: result.map { ToolCallResult(text: $0, isError: error) })
  }
  private func text(_ id: String, _ body: String = "hi") -> TranscriptItem {
    .assistantText(id: id, text: body, streaming: false, parentToolUseId: nil)
  }
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 60, fontSize: 13)

  private func lines(_ row: TranscriptRow, _ expansion: TerminalExpansion) -> [TermLine] {
    TerminalPlanner.plan(row, metrics: metrics, expansion: expansion)
  }

  // MARK: - Nothing open changes nothing

  @Test("an empty expansion plans exactly what the collapsed planner planned")
  func collapsedIsUnchanged() {
    let rows = TerminalRows.build(items: [
      text("intro"),
      .toolCall(call("a", result: "one\ntwo\nthree\nfour\nfive")),
      .toolCall(call("b")),
      .toolCall(call("c")),
      .toolCall(call("t", "Task")),
      .toolCall(call("k1", parent: "t")),
    ])
    for index in 0..<rows.count {
      // The default argument and an explicitly empty value must agree, or every
      // caller that has not been updated is silently drawing something else.
      #expect(
        TerminalPlanner.plan(rows[index], metrics: metrics)
          == lines(rows[index], TerminalExpansion()))
    }
  }

  // MARK: - Runs

  @Test("opening a run draws its calls, and closing it restores the summary")
  func runOpensAndCloses() {
    let rows = TerminalRows.build(items: [
      .toolCall(call("a", result: "alpha")), .toolCall(call("b", result: "beta")),
      .toolCall(call("c", result: "gamma")),
    ])
    guard case .block(.run(let block)) = rows[0] else {
      Issue.record("expected one folded run")
      return
    }
    let collapsed = lines(rows[0], TerminalExpansion())
    #expect(collapsed.count == 1)
    #expect(collapsed[0].text.contains("Ran 3 shell commands"))
    #expect(collapsed[0].press == .toggle(block.key))

    var expansion = TerminalExpansion()
    #expect(expansion.apply(.toggle(block.key)) == true)
    let open = lines(rows[0], expansion)
    // The summary, then each call's header and its result — and every line of it
    // washed, so eighty new lines read as one block.
    #expect(open.count > collapsed.count)
    #expect(open.allSatisfy { $0.inOpen })
    #expect(open.filter { $0.text.contains("alpha") }.count == 1)
    #expect(open.filter { $0.text.contains("gamma") }.count == 1)
    // The nested calls answer to themselves; only the summary closes the run.
    #expect(open[0].press == .toggle(block.key))
    #expect(open.contains { $0.press == .toggle(TerminalExpansion.openKey(callId: "b")) })

    #expect(expansion.apply(.toggle(block.key)) == false)
    #expect(lines(rows[0], expansion) == collapsed)
  }

  @Test("a run of one offers no run key — it is already drawn as the call")
  func runOfOneHasNoOwnKey() {
    let rows = TerminalRows.build(items: [.toolCall(call("a", result: "x")), text("after")])
    guard case .block(.run(let block)) = rows[0] else {
      Issue.record("expected a run block")
      return
    }
    // The block still exists (the fold is untouched); it is the *rendering* that
    // draws the call itself, so opening the run key would do nothing and must
    // not be offered as something a press can reach.
    #expect(!expansionKeys(of: rows[0]).contains(block.key))
    #expect(expansionKeys(of: rows[0]).contains(TerminalExpansion.openKey(callId: "a")))
  }

  // MARK: - Tasks

  @Test("opening a Task draws its children, stepped in behind the rule")
  func taskOpens() {
    let rows = TerminalRows.build(items: [
      .toolCall(call("t", "Task")),
      .toolCall(call("k1", parent: "t", result: "found it")),
      .assistantText(id: "say", text: "report", streaming: false, parentToolUseId: "t"),
    ])
    #expect(rows.count == 1)
    guard case .block(.task(let block)) = rows[0] else {
      Issue.record("expected a Task row")
      return
    }
    let collapsed = lines(rows[0], TerminalExpansion())
    #expect(collapsed.count == 1)

    var expansion = TerminalExpansion()
    expansion.apply(.toggle(block.key))
    let open = lines(rows[0], expansion)
    #expect(open.contains { $0.text.contains("report") })
    // Everything below the summary is a subagent's own row, and a subagent's
    // rows are drawn one level in behind a rule.
    #expect(open.dropFirst().allSatisfy { $0.nested })
    #expect(open.allSatisfy { $0.inOpen })
  }

  // MARK: - Results

  @Test("an open result is clipped to the expanded budget until `full` lifts it")
  func resultHasThreeStates() {
    let long = (1...400).map { "line \($0) of the output" }.joined(separator: "\n")
    let rows = TerminalRows.build(items: [.toolCall(call("a", result: long)), text("after")])
    let openKey = TerminalExpansion.openKey(callId: "a")
    let fullKey = TerminalExpansion.fullKey(callId: "a")

    let collapsed = lines(rows[0], TerminalExpansion())
    var expansion = TerminalExpansion()
    expansion.apply(.toggle(openKey))
    let open = lines(rows[0], expansion)
    expansion.apply(.expandFull(fullKey))
    let full = lines(rows[0], expansion)

    #expect(collapsed.count < open.count)
    #expect(open.count < full.count)
    // The middle state is the layout guard: the whole of a hundred-thousand-
    // character result lands in *one* virtual row, and the collection view
    // recycles rows, not what is inside one.
    #expect(open.contains { $0.text.contains("show all") })
    #expect(open.last?.press == .expandFull(fullKey))
    #expect(!full.contains { $0.text.contains("show all") })
    // Every planned line is one drawn line, expanded or not — the premise the
    // layout takes its frames from.
    #expect(full.count >= 400)
  }

  @Test("closing a result forgets that its budget was lifted")
  func closingForgetsFull() {
    var expansion = TerminalExpansion()
    let openKey = TerminalExpansion.openKey(callId: "a")
    let fullKey = TerminalExpansion.fullKey(callId: "a")
    expansion.apply(.toggle(openKey))
    expansion.apply(.expandFull(fullKey))
    expansion.apply(.toggle(openKey))
    #expect(expansion.isEmpty)
  }

  // MARK: - The book and its cache

  @Test("a cached book under expansion agrees with a cold plan, row for row")
  func cacheAgreesWithColdPlan() {
    let items: [TranscriptItem] = [
      text("intro"),
      .toolCall(call("a", result: "one\ntwo\nthree\nfour\nfive\nsix")),
      .toolCall(call("b", result: "beta")),
      .toolCall(call("t", "Task")),
      .toolCall(call("k1", parent: "t", result: "child output")),
      text("outro"),
    ]
    let rows = TerminalRows.build(items: items)
    let cache = TerminalPlanCache()
    var expansion = TerminalExpansion()

    // Warm the cache collapsed first: a stale entry is exactly the failure this
    // guards, and it can only happen to a row that was measured before.
    _ = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache, expansion: expansion)

    for key in rows.rows.flatMap({ Array(expansionKeys(of: $0)) }).sorted() {
      guard key.hasPrefix("run:") || key.hasPrefix("task:") || key.hasPrefix("call:") else {
        continue
      }
      expansion.apply(.toggle(key))
      let warm = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache, expansion: expansion)
      let cold = TerminalHeightBook(rows: rows, metrics: metrics, expansion: expansion)
      for index in 0..<rows.count {
        #expect(warm.height(at: index) == cold.height(at: index), "row \(index) after \(key)")
      }
      #expect(warm.totalHeight == cold.totalHeight)
    }
  }

  @Test("a press on one row does not re-plan the rest")
  func expansionIsScopedToItsRow() {
    let rows = TerminalRows.build(items: [
      .toolCall(call("a", result: "alpha")), .toolCall(call("b", result: "beta")),
      text("prose"),
      .toolCall(call("c", result: "gamma")), .toolCall(call("d", result: "delta")),
    ])
    guard case .block(.run(let first)) = rows[0] else {
      Issue.record("expected a run first")
      return
    }
    var expansion = TerminalExpansion()
    expansion.apply(.toggle(first.key))

    // The scoping claim, stated as the thing it exists for: a row that holds
    // none of the open keys sees an *empty* expansion, so its cached height
    // stands and sixteen thousand of them are not re-wrapped for one finger.
    #expect(expansion.subset(for: rows[0]).isEmpty == false)
    for index in 1..<rows.count { #expect(expansion.subset(for: rows[index]).isEmpty) }

    let book = TerminalHeightBook(rows: rows, metrics: metrics, expansion: expansion)
    let untouched = TerminalHeightBook(rows: rows, metrics: metrics)
    #expect(book.height(at: 0) > untouched.height(at: 0))
    for index in 1..<rows.count {
      #expect(book.height(at: index) == untouched.height(at: index))
    }
  }

  @Test("every planned line's height is the book's, expanded or not")
  func heightsFollowThePlan() {
    let rows = TerminalRows.build(items: [
      .toolCall(call("a", result: (1...50).map(String.init).joined(separator: "\n"))),
      text("after"),
    ])
    var expansion = TerminalExpansion()
    expansion.apply(.toggle(TerminalExpansion.openKey(callId: "a")))
    let book = TerminalHeightBook(rows: rows, metrics: metrics, expansion: expansion)
    for index in 0..<rows.count {
      let planned = lines(rows[index], expansion).count
      let gap = rows.gapBefore(index) ? 1 : 0
      #expect(book.height(at: index) == CGFloat(planned + gap) * metrics.line)
    }
  }
}

extension TerminalExpansionTests {
  @Test("a call with nothing folded behind it advertises no press")
  func emptyCallsAreNotPressable() {
    // A target that visibly does nothing is worse than no target: the reader
    // concludes the theme is broken rather than that this row is empty.
    let rows = TerminalRows.build(items: [.toolCall(call("a")), text("after")])
    #expect(lines(rows[0], TerminalExpansion()).allSatisfy { $0.press == nil })

    let withResult = TerminalRows.build(items: [.toolCall(call("b", result: "out")), text("x")])
    #expect(lines(withResult[0], TerminalExpansion()).contains { $0.press != nil })
  }

  @Test("a file edit with no result prose keeps its diff, open or not")
  func patchWithoutTextNeverHidesItsDiff() {
    var edit = call("e", "Edit")
    edit.patch = FilePatch(
      path: "a.swift", hunks: [PatchHunk(oldStart: 0, oldLines: 1, newStart: 0, newLines: 1,
        lines: ["-old", "+new"])])
    let rows = TerminalRows.build(items: [.toolCall(edit), text("after")])
    let collapsed = lines(rows[0], TerminalExpansion())
    // `everything` would open it; the planner refuses, because opening a row
    // whose only content *is* the diff would swap the change for nothing.
    #expect(lines(rows[0], .everything(in: rows)) == collapsed)
    #expect(collapsed.contains { $0.text.contains("new") })
  }
}
