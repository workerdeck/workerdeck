import Foundation
import Testing

@testable import WorkerDeckKit

/// The catch-up seam's label. Pinned against `packages/react/src/lib/recap.ts`,
/// because the two clients draw one sentence and a phone that counted a failed
/// call differently would be quietly telling a different story about the same
/// session.
@Suite("Recap")
struct RecapTests {
  private func call(
    _ id: String, _ name: String = "Bash", status: ToolCallStatus = .settled,
    error: Bool = false
  ) -> TranscriptItem {
    .toolCall(
      ToolCallItem(
        id: id, name: name, input: .object([:]), status: status,
        result: ToolCallResult(text: "", isError: error)))
  }
  private func text(_ id: String) -> TranscriptItem {
    .assistantText(id: id, text: "hi", streaming: false, parentToolUseId: nil)
  }
  private func turn(_ id: String, error: Bool = false) -> TranscriptItem {
    .turnResult(
      id: id, subtype: "success", isError: error, durationMs: 1, totalCostUsd: 0, errors: nil)
  }

  @Test("counts only what arrived after the boundary")
  func countsAfterBoundary() {
    let items = [text("a"), call("c1"), text("b"), call("c2", "Read"), turn("t1")]
    let summary = summarizeSince(items: items, from: 2)
    #expect(summary.replies == 1)
    #expect(summary.tools == 1)
    #expect(summary.turns == 1)
    #expect(summary.toolNames == ["Read"])
  }

  @Test("a boundary past the end is clamped, not rejected — a transcript can shrink")
  func clampsBoundary() {
    let summary = summarizeSince(items: [text("a")], from: 99)
    #expect(!summary.any)
    #expect(recapLine(summary) == nil)
  }

  @Test("tool names lead with the most frequent, ties by name")
  func toolNameOrder() {
    let items = [call("1", "Read"), call("2", "Bash"), call("3", "Read"), call("4", "Apply")]
    #expect(summarizeSince(items: items, from: 0).toolNames == ["Read", "Apply", "Bash"])
  }

  @Test("a failed call and a failed turn both count as errors")
  func errorsCounted() {
    let items = [call("1", status: .failed), call("2", error: true), turn("t", error: true)]
    #expect(summarizeSince(items: items, from: 0).errors == 3)
  }

  @Test("an error notice counts, an info notice does not")
  func noticeLevels() {
    let items: [TranscriptItem] = [
      .notice(id: "n1", level: .error, text: "boom"),
      .notice(id: "n2", level: .info, text: "fyi"),
    ]
    #expect(summarizeSince(items: items, from: 0).errors == 1)
  }

  @Test("turns win over replies in the line, and both are counted")
  func turnsLeadTheLine() {
    let items = [text("a"), turn("t")]
    let summary = summarizeSince(items: items, from: 0)
    #expect(summary.replies == 1)
    #expect(recapLine(summary) == "1 turn")
  }

  @Test("replies lead when no turn has landed yet")
  func repliesLeadMidTurn() {
    #expect(recapLine(summarizeSince(items: [text("a"), text("b")], from: 0)) == "2 replies")
  }

  @Test("the line names three tools and counts the rest")
  func lineNamesThreeTools() {
    let items = [
      call("1", "Read"), call("2", "Read"), call("3", "Bash"), call("4", "Edit"),
      call("5", "Grep"), call("6", "Glob"),
    ]
    #expect(recapLine(summarizeSince(items: items, from: 0)) == "6 tool calls (Read, Bash, Edit, +2)")
  }

  @Test("every part joins in one fixed order")
  func fullLine() {
    let items: [TranscriptItem] = [
      turn("t"), call("c"), .fileDelivered(id: "f", path: "a.txt", bytes: 1, description: nil),
      .notice(id: "n", level: .error, text: "boom"),
    ]
    let line = recapLine(summarizeSince(items: items, from: 0, pendingApprovals: 2))
    #expect(line == "1 turn · 1 tool call (Bash) · 1 file · 1 error · 2 approvals waiting")
  }

  @Test("an approval waiting is news on its own — nothing else has to have happened")
  func pendingAlone() {
    #expect(recapLine(summarizeSince(items: [], from: 0, pendingApprovals: 1)) == "1 approval waiting")
  }
}
