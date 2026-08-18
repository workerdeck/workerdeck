import Foundation
import Testing

@testable import WorkerDeckKit

/// What the fold and the height book cost at a size no one will hit by accident.
///
/// Not a benchmark — a guard. The refold runs on **every applied event**,
/// streamed deltas included, and a transcript is append-only and unbounded, so
/// an O(n) cost per token is a session that gets slower all afternoon and a bug
/// nobody can point at. The cache exists to make the warm path proportional to
/// what changed rather than to what is there; these bounds are set generously
/// enough that only a regression in *that property* trips them.
@Suite("TerminalPerf")
struct TerminalPerfTests {
  private let metrics = TerminalMetrics(cell: 7.4, line: 17, width: 360, fontSize: 12)

  private func transcript(turns: Int) -> [TranscriptItem] {
    var items: [TranscriptItem] = []
    for turn in 0..<turns {
      items.append(
        .user(id: "u\(turn)", text: "Turn \(turn): what changed?", attachments: nil,
          parentToolUseId: nil))
      items.append(
        .assistantText(
          id: "a\(turn)",
          text: "Answer \(turn). The planner wrapped this line and the row drew what it returned.",
          streaming: false, parentToolUseId: nil))
      items.append(
        .toolCall(
          ToolCallItem(
            id: "s\(turn)a", name: "Bash", input: .object([:]), status: .settled,
            result: ToolCallResult(text: "ok", isError: false))))
      items.append(
        .toolCall(
          ToolCallItem(
            id: "s\(turn)b", name: "Read", input: .object([:]), status: .settled,
            result: ToolCallResult(text: "ok", isError: false))))
      items.append(
        .turnResult(
          id: "tr\(turn)", subtype: "success", isError: false, durationMs: 1_200,
          totalCostUsd: 0.01, errors: nil))
    }
    return items
  }

  private func milliseconds(_ block: () -> Void) -> Double {
    let start = DispatchTime.now().uptimeNanoseconds
    block()
    return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
  }

  @Test("a streamed token re-plans one row, not the transcript")
  func warmDeltaIsProportionalToWhatChanged() {
    let items = transcript(turns: 4_000)
    let cache = TerminalPlanCache()
    let rows = TerminalRows.build(items: items)
    let cold = milliseconds { _ = TerminalHeightBook(rows: rows, metrics: metrics, cache: cache) }

    var next = items
    if case .assistantText(let id, let text, _, let parent) = next[next.count - 4] {
      next[next.count - 4] = .assistantText(
        id: id, text: text + " more", streaming: true, parentToolUseId: parent)
    }
    let warm = milliseconds {
      let grown = TerminalRows.build(items: next)
      _ = TerminalHeightBook(rows: grown, metrics: metrics, cache: cache)
    }

    // The warm path still walks the row array — that is the sum, and it is
    // cheap. What it must NOT do is re-wrap 16,000 rows' text, which is the
    // difference the cache buys and is an order of magnitude, not a few percent.
    #expect(warm < cold / 3, "warm \(warm)ms vs cold \(cold)ms")
  }

  @Test("a very long transcript folds and measures in one pass")
  func coldBuildStaysLinear() {
    let small = transcript(turns: 1_000)
    let large = transcript(turns: 4_000)
    let smallTime = milliseconds {
      let rows = TerminalRows.build(items: small)
      _ = TerminalHeightBook(rows: rows, metrics: metrics)
    }
    let largeTime = milliseconds {
      let rows = TerminalRows.build(items: large)
      _ = TerminalHeightBook(rows: rows, metrics: metrics)
    }
    // Four times the work, well under ten times the time — the fold's two
    // pre-passes are hash lookups, and anything quadratic in there (a scan per
    // item looking for children, say) would show up here long before a user hit
    // it.
    #expect(largeTime < smallTime * 10, "1k \(smallTime)ms vs 4k \(largeTime)ms")
  }
}
