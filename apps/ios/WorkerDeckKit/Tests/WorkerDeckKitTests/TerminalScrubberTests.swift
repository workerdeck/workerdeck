import Foundation
import Testing

@testable import WorkerDeckKit

/// The overview ruler's arithmetic, mirroring `packages/ui/test/scrubber.test.ts`.
///
/// This suite exists because both of the bugs the web client's rail has shipped
/// were pure-logic ones invisible in a screenshot: a live answer with no
/// `turn_result` yet went unmarked for the whole two minutes it was the only
/// thing worth navigating to, and a replayed history — which carries no turn
/// rows at all — came back with an empty response lane.
@Suite("TerminalScrubber")
struct TerminalScrubberTests {
  private func user(_ id: String, _ body: String = "do it", parent: String? = nil)
    -> TranscriptItem
  {
    .user(id: id, text: body, attachments: nil, parentToolUseId: parent)
  }
  private func say(_ id: String, _ body: String = "done it", parent: String? = nil)
    -> TranscriptItem
  {
    .assistantText(id: id, text: body, streaming: false, parentToolUseId: parent)
  }
  private func turn(_ id: String, failed: Bool = false) -> TranscriptItem {
    .turnResult(
      id: id, subtype: failed ? "error_during_execution" : "success", isError: failed,
      durationMs: 1200, totalCostUsd: 0.01, errors: failed ? ["boom"] : nil)
  }
  private func call(
    _ id: String, _ name: String = "Bash", parent: String? = nil,
    status: ToolCallStatus = .settled, result: String? = nil, error: Bool = false
  ) -> TranscriptItem {
    .toolCall(
      ToolCallItem(
        id: id, name: name, input: .object([:]), parentToolUseId: parent, status: status,
        result: result.map { ToolCallResult(text: $0, isError: error) }))
  }

  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 60, fontSize: 13)

  private func input(
    _ items: [TranscriptItem], approvals: [PermissionRequest] = [], bookmarks: [Int] = [],
    recap: ScrubberRecap? = nil, viewport: CGFloat = 400
  ) -> ScrubberInput {
    let rows = TerminalRows.build(items: items)
    return ScrubberInput(
      items: items, rows: rows,
      book: TerminalHeightBook(rows: rows, metrics: metrics), pendingApprovals: approvals,
      bookmarks: bookmarks, recap: recap, viewportHeight: viewport)
  }

  private func kinds(_ clusters: [ScrubberCluster]) -> [ScrubberMarkKind] {
    clusters.flatMap { $0.marks.map(\.mark.kind) }
  }

  // MARK: - Scale

  @Test("railScale is rail over content when the content overflows")
  func scaleOverflowing() {
    #expect(railScale(railH: 300, totalSize: 3000, viewportH: 600) == 0.1)
  }

  @Test("railScale clamps its denominator to the viewport when everything fits")
  func scaleClamps() {
    // The bug this is: 90 points of content in a 906-point window made
    // `railH / totalSize` ≈ 10 and a 9,120-point band inside a 906-point rail.
    // The rail sits *inside* the scroller, so that overflow became real
    // scrollable height — ~8,000 points of nothing under a three-row session.
    let scale = railScale(railH: 906, totalSize: 90, viewportH: 906)
    #expect(scale == 1)
    // The structural claim: the band can never exceed the rail, for any content.
    #expect(906 * scale <= 906)
  }

  @Test("railScale is zero for an empty transcript rather than dividing by nothing")
  func scaleEmpty() {
    #expect(railScale(railH: 300, totalSize: 0, viewportH: 600) == 0)
  }

  // MARK: - Lanes

  @Test("a prompt marks the left lane and its answer the right")
  func promptAndAnswer() {
    let clusters = buildScrubberClusters(
      input([user("u1"), say("a1"), turn("t1")]), railH: 300)
    #expect(clusters.contains { $0.kind == .user && $0.lane == .left })
    #expect(clusters.contains { $0.kind == .turn && $0.lane == .right })
  }

  @Test("a live answer with no turn_result yet is still marked")
  func liveAnswerIsMarked() {
    // The bug, verbatim: a two-minute answer went unrepresented on the rail for
    // the whole two minutes it was the only thing worth navigating to.
    let items = [user("u1"), .assistantText(id: "a1", text: "…", streaming: true, parentToolUseId: nil)]
    let clusters = buildScrubberClusters(input(items), railH: 300)
    #expect(kinds(clusters).contains(.turn))
  }

  @Test("a replayed history carrying no turn rows still fills the response lane")
  func replayedHistoryIsMarked() {
    // A resumed session's backfill maps only user and assistant entries. Built
    // from `turn_result` alone the whole lane came back empty — and the prompt
    // lane survived, which is what made it look like a rendering bug.
    let items = [user("u1"), say("a1"), user("u2"), say("a2")]
    let clusters = buildScrubberClusters(input(items), railH: 300)
    #expect(kinds(clusters).filter { $0 == .turn }.count == 2)
  }

  @Test("a turn mark anchors on the answer; the turn_result only decorates it")
  func turnAnchorsOnTheAnswer() {
    let items = [user("u1"), say("a1"), turn("t1", failed: true)]
    let clusters = buildScrubberClusters(input(items), railH: 300)
    guard let mark = clusters.flatMap({ $0.marks }).map(\.mark).first(where: {
      $0.kind == .turnFailed
    }) else {
      Issue.record("expected a failed turn mark")
      return
    }
    #expect(mark.itemIndex == 1)  // the answer, not the turn end
    #expect(mark.turnIndex == 2)
  }

  @Test("a subagent's brief paints no prompt mark and does not close the segment")
  func subagentBriefIsInvisible() {
    // Both halves matter: a subagent's brief is a `user` item, so it would paint
    // a "you" mark for something nobody typed *and* mis-anchor the response
    // mark whenever a task runs between the prompt and the answer.
    let items = [
      user("u1"),
      call("t1", "Task"),
      user("brief", "go look", parent: "t1"),
      say("child", "found it", parent: "t1"),
      say("a1"),
      turn("turn1"),
    ]
    let clusters = buildScrubberClusters(input(items), railH: 300)
    let marks = clusters.flatMap { $0.marks }.map(\.mark)
    #expect(marks.filter { $0.kind == .user }.count == 1)
    #expect(marks.first { $0.kind == .turn }?.itemIndex == 4)
  }

  @Test("a failed tool call is marked by either spelling")
  func toolFailureBothSpellings() {
    // An out-of-loop execution failure sets only the status; an engine can flag
    // `is_error` on a call the reducer has not settled.
    let byStatus = buildScrubberClusters(
      input([call("a", status: .failed), say("x")]), railH: 300)
    let byFlag = buildScrubberClusters(
      input([call("b", result: "nope", error: true), say("x")]), railH: 300)
    #expect(kinds(byStatus).contains(.toolFailed))
    #expect(kinds(byFlag).contains(.toolFailed))
  }

  @Test("an error notice is marked and an info one is not")
  func noticeLevels() {
    let error = buildScrubberClusters(
      input([.notice(id: "n", level: .error, text: "bad")]), railH: 300)
    let info = buildScrubberClusters(
      input([.notice(id: "n", level: .info, text: "fyi")]), railH: 300)
    #expect(kinds(error).contains(.error))
    #expect(!kinds(info).contains(.error))
  }

  // MARK: - Merging

  @Test("a session error keeps the colour when it merges with a tool failure")
  func loudestWinsTheMerge() {
    // Both are the full lane, so a point apart they merge — and the rank that
    // does the work is `error` over `toolFailed`.
    let items = [call("a", status: .failed), .notice(id: "n", level: .error, text: "bad")]
    let clusters = buildScrubberClusters(input(items, viewport: 4000), railH: 4)
    let full = clusters.filter { $0.lane == .full }
    #expect(full.count == 1)
    #expect(full[0].kind == .error)
    #expect(full[0].marks.count == 2)
  }

  @Test("a merged cluster keeps every member, so a press resolves to the nearest")
  func nearestMemberResolves() {
    let items = [call("a", status: .failed), .notice(id: "n", level: .error, text: "bad")]
    let clusters = buildScrubberClusters(input(items, viewport: 4000), railH: 4)
    guard let cluster = clusters.first(where: { $0.marks.count > 1 }) else {
      Issue.record("expected a merged cluster")
      return
    }
    // A press at the middle of a chain-merged bar must not act on whichever mark
    // happened to found it.
    let low = cluster.nearestMember(to: cluster.y)
    let high = cluster.nearestMember(to: cluster.y + cluster.h)
    #expect(low != nil && high != nil)
    #expect(low?.rowIndex ?? -1 <= high?.rowIndex ?? -1)
  }

  // MARK: - The pieces with no item

  @Test("a waiting approval pins at the rail's foot, full width")
  func approvalPins() {
    let request = PermissionRequest(
      id: "p1", toolName: "Bash", input: .object([:]), toolUseId: "tu1")
    let clusters = buildScrubberClusters(input([say("a")], approvals: [request]), railH: 300)
    guard let approval = clusters.first(where: { $0.kind == .approval }) else {
      Issue.record("expected an approval mark")
      return
    }
    #expect(approval.lane == .full)
    #expect(approval.y == 300 - scrubberMinMark)
    // No item to derive a position from, so no members — the peek reads the
    // request itself.
    #expect(approval.marks.isEmpty)
  }

  @Test("a bookmark pointing outside the transcript is dropped")
  func bookmarksAreBounded() {
    let clusters = buildScrubberClusters(input([say("a")], bookmarks: [0, 9]), railH: 300)
    #expect(kinds(clusters).filter { $0 == .bookmark }.count == 1)
  }

  @Test("the recap seam is marked from its row, never from an item")
  func recapComesFromItsRow() {
    let clusters = buildScrubberClusters(
      input([user("u"), say("a")], recap: ScrubberRecap(rowIndex: 1, label: "3 new")), railH: 300)
    guard let mark = clusters.flatMap({ $0.marks }).map(\.mark).first(where: { $0.kind == .recap })
    else {
      Issue.record("expected a recap mark")
      return
    }
    #expect(mark.itemIndex == -1)
    #expect(mark.rowIndex == 1)
  }

  // MARK: - Geometry

  @Test("a mark is floored at the hit target and never runs past the rail")
  func marksStayOnTheRail() {
    let items = (0..<200).flatMap { [user("u\($0)"), say("a\($0)")] }
    let clusters = buildScrubberClusters(input(items), railH: 300)
    #expect(!clusters.isEmpty)
    for cluster in clusters {
      #expect(cluster.h >= scrubberMinMark)
      #expect(cluster.y >= 0)
      #expect(cluster.y <= 300)
    }
  }

  @Test("a mark's row index is not its item index")
  func rowIndexIsNotItemIndex() {
    // The rule the whole row model rests on. A fold puts the answer's row well
    // before its item index, and arithmetic would land the mark on the wrong
    // part of the rail.
    let items = [user("u"), call("a"), call("b"), call("c"), say("answer")]
    let scrub = input(items)
    let clusters = buildScrubberClusters(scrub, railH: 300)
    guard let mark = clusters.flatMap({ $0.marks }).map(\.mark).first(where: { $0.kind == .turn })
    else {
      Issue.record("expected a response mark")
      return
    }
    #expect(mark.itemIndex == 4)
    #expect(mark.rowIndex == 2)  // prompt, the folded run, the answer
    #expect(mark.rowIndex == scrub.rows.rowIndex(forItem: mark.itemIndex))
  }

  @Test("an empty transcript paints nothing")
  func emptyPaintsNothing() {
    #expect(buildScrubberClusters(input([]), railH: 300).isEmpty)
  }
}

extension TerminalScrubberTests {
  @Test("a very long transcript builds its rail in one pass, and merges to a bounded rail")
  func denseRailStaysBounded() {
    // The rail is rebuilt whenever the transcript changes — the same cadence
    // the fold already pays — so it has to be one linear pass. And the *output*
    // has to be bounded by the rail rather than by the session: a press scans
    // the clusters, and merging is what keeps that a rail's worth of work
    // instead of a session's.
    var items: [TranscriptItem] = []
    for index in 0..<4000 {
      items.append(user("u\(index)"))
      items.append(say("a\(index)"))
      items.append(turn("t\(index)"))
    }
    let scrub = input(items, viewport: 800)
    let clock = ContinuousClock()
    var clusters: [ScrubberCluster] = []
    let elapsed = clock.measure { clusters = buildScrubberClusters(scrub, railH: 760) }

    #expect(elapsed < .milliseconds(400))
    // Two lanes over a 760-point rail, merged: nowhere near the 8,000 marks
    // that went in. Six hundred prompts over a rail *is* a solid stripe, which
    // is exactly how VS Code draws dense decorations.
    #expect(clusters.count <= 2 * 760)
    #expect(clusters.flatMap(\.marks).count == 8000)
    for cluster in clusters { #expect(cluster.y + cluster.h <= 760 + scrubberMinMark) }
  }
}
