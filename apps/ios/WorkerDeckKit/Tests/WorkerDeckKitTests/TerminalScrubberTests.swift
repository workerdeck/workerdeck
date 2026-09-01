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
    _ items: [TranscriptItem], approvals: [PermissionRequest] = [], bookmarks: [String] = [],
    recap: ScrubberRecap? = nil, viewport: CGFloat = 400,
    expansion: TerminalExpansion = TerminalExpansion(),
    frameParentId: String? = nil, frameTask: ToolCallItem? = nil
  ) -> ScrubberInput {
    let rows = TerminalRows.build(items: items, frameTask: frameTask)
    return ScrubberInput(
      items: items, rows: rows,
      book: TerminalHeightBook(
        rows: rows, metrics: metrics, expansion: expansion, frameParentId: frameParentId),
      pendingApprovals: approvals,
      bookmarks: bookmarks, recap: recap, viewportHeight: viewport, expansion: expansion,
      frameParentId: frameParentId)
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
    // Both are the response lane, so a point apart they merge — and the rank
    // that does the work is `error` over `toolFailed`.
    let items = [call("a", status: .failed), .notice(id: "n", level: .error, text: "bad")]
    let clusters = buildScrubberClusters(input(items, viewport: 4000), railH: 4)
    let right = clusters.filter { $0.lane == .right }
    #expect(right.count == 1)
    #expect(right[0].kind == .error)
    #expect(right[0].marks.count == 2)
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

  @Test("a bookmark id this transcript does not hold draws nothing")
  func bookmarksResolveById() {
    // Ids, not indices — the seam's whole point. A mark from another frame's
    // items (or a truncated replay) is not an error, it is simply not here.
    let clusters = buildScrubberClusters(
      input([say("a")], bookmarks: ["a", "someone-elses-row"]), railH: 300)
    #expect(kinds(clusters).filter { $0 == .bookmark }.count == 1)
  }

  @Test("a bookmark on a run member marks the run's row, by membership")
  func bookmarkOnRunMemberMarksTheRunRow() {
    // The id names the *last* member, whose row no index arithmetic can find:
    // the run's row starts two items earlier.
    let items = [user("u"), call("a"), call("b"), call("c"), say("answer")]
    let scrub = input(items, bookmarks: ["c"])
    let mark = buildScrubberClusters(scrub, railH: 300)
      .flatMap { $0.marks }.map(\.mark).first { $0.kind == .bookmark }
    #expect(mark?.itemIndex == 3)
    #expect(mark?.rowIndex == 1)
    #expect(mark?.rowIndex == scrub.rows.rowIndex(forItem: 3))
  }

  @Test("a bookmark on a task's absorbed child marks the Task row that swallowed it")
  func bookmarkOnAbsorbedChildMarksTheTaskRow() {
    let items: [TranscriptItem] = [
      user("u"),                // 0 → row 0
      call("T", "Task"),        // 1 → row 1, the fold's anchor
      call("c1", parent: "T"),  // 2 absorbed into row 1
      say("answer"),            // 3 → row 2
    ]
    let scrub = input(items, bookmarks: ["c1"])
    let mark = buildScrubberClusters(scrub, railH: 300)
      .flatMap { $0.marks }.map(\.mark).first { $0.kind == .bookmark }
    #expect(mark?.itemIndex == 2)
    #expect(mark?.rowIndex == 1)
  }

  @Test("one bookmark set rides a frame's rail: its own items resolve, the host's stay out")
  func bookmarksInsideAFrameResolveAgainstItsOwnItems() {
    // What made index-addressed bookmarks impossible to pass into a takeover:
    // index 2 means different items in the two spaces. Ids dissolve it — the
    // same set goes to both rails, and inside the frame each id either names a
    // frame item at the frame's own offsets or names nothing.
    let frameItems = [say("s1", parent: "T"), call("c1", parent: "T", result: "ok")]
    let scrub = input(frameItems, bookmarks: ["c1", "top-level-prompt"], frameParentId: "T")
    let bookmarks = buildScrubberClusters(scrub, railH: 300)
      .flatMap { $0.marks }.map(\.mark).filter { $0.kind == .bookmark }
    #expect(bookmarks.count == 1)
    #expect(bookmarks.first?.itemIndex == 1)
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

  // MARK: - Marks inside a shared row

  /// A task of many children is one line collapsed and the whole subagent area
  /// expanded. The height book reports the measurement either way, so one failed
  /// child used to paint a band down the entire rail once it was opened.
  private var taskWithOneFailedChild: [TranscriptItem] {
    [
      user("u1"),
      .toolCall(
        ToolCallItem(
          id: "T", name: "Task", input: .object(["description": .string("explore")]),
          parentToolUseId: nil, status: .settled,
          result: ToolCallResult(text: "report", isError: false))),
      call("c0", parent: "T", result: "ok"),
      call("c1", "Grep", parent: "T", result: "no matches", error: true),
      call("c2", parent: "T", result: "ok"),
      call("c3", parent: "T", result: "ok"),
      say("a1"),
    ]
  }

  /// A folded run of four whose **last** call failed — the shape the rail still
  /// marks, and therefore the shape the fractional anchor has to be tested on.
  /// It was a task's absorbed child until the outcome rule landed; the geometry
  /// under test is identical (a member of a row that covers a membership) and
  /// only the membership that earns a mark has narrowed.
  private var runEndingInFailure: [TranscriptItem] {
    [
      user("u1"),
      call("c0", result: "ok"),
      call("c1", result: "ok"),
      call("c2", result: "ok"),
      call("c3", "Grep", result: "no matches", error: true),
      say("a1"),
    ]
  }

  // MARK: - Red on screen, red on the rail

  /// Eight calls with the failures in the *middle* — the shape Tobias opened,
  /// and the one that has to behave differently collapsed and open.
  private var runWithMiddleFailures: [TranscriptItem] {
    var items: [TranscriptItem] = [user("u1")]
    for i in 0..<8 {
      items.append(
        call("c\(i)", result: i == 3 || i == 5 ? "boom" : "ok", error: i == 3 || i == 5))
    }
    items.append(say("a1"))
    return items
  }

  @Test("collapsed, a run whose failures are all mid-chain marks nothing")
  func middleFailuresCollapsedAreSilent() {
    // The summary line is coloured by `runFailed` — the LAST call — and that
    // call succeeded, so there is nothing red on screen to mark.
    let marks = kinds(buildScrubberClusters(input(runWithMiddleFailures), railH: 100))
    #expect(!marks.contains(.toolFailed))
  }

  @Test("opened, the same run marks each failure where it actually is")
  func middleFailuresOpenedAreMarked() {
    // Every member is planned through `planToolCall` once the run is open, and
    // a failed one is red on its own line. Two failures, two marks.
    let open = TerminalExpansion(open: [.run("c0")])
    let clusters = buildScrubberClusters(input(runWithMiddleFailures, expansion: open), railH: 100)
    let failures = clusters.flatMap { $0.marks.map(\.mark) }.filter { $0.kind == .toolFailed }
    #expect(failures.count == 2)
    // At the failures' own item indices — 1 is the first call, so c3 and c5.
    #expect(Set(failures.map(\.itemIndex)) == [4, 6])
  }

  @Test("a sub-agent's failed child marks only once it is actually red on screen")
  func openTaskMarksItsFailedChildOnlyWhenTheRunIsOpen() {
    // Two folds deep, and the rule holds at each: opening the **task** reveals
    // its children as a folded *run*, whose summary line `runFailed` colours by
    // its last call — which succeeded. So there is still nothing red, and still
    // nothing to mark. This is the case that shows the rule is about what is
    // drawn rather than about nesting depth.
    let taskOnly = TerminalExpansion(open: [.task("T")])
    #expect(
      !kinds(buildScrubberClusters(input(taskWithOneFailedChild, expansion: taskOnly), railH: 100))
        .contains(.toolFailed))

    // Open the run inside it and the Grep is red on its own line — so it marks.
    let both = TerminalExpansion(open: [.task("T"), .run("c0")])
    #expect(
      kinds(buildScrubberClusters(input(taskWithOneFailedChild, expansion: both), railH: 100))
        .contains(.toolFailed))
  }

  // MARK: - The expanded region

  /// `.expanded` was a `ScrubberMarkKind` and needed three exemptions from the
  /// mark machinery inside an hour — skip the fractional rule, never merge,
  /// paint first. It is a `ScrubberRegion` now, and these are the same claims
  /// made against a type that needs none of them.

  @Test("an opened block bands the left lane, and a collapsed one does not")
  func expandedBandsTheInputLane() {
    #expect(buildScrubberRail(input(runWithMiddleFailures), railH: 100).regions.isEmpty)

    let open = TerminalExpansion(open: [.run("c0")])
    let regions = buildScrubberRail(input(runWithMiddleFailures, expansion: open), railH: 100)
      .regions
    #expect(regions.count == 1)
    // Opening is something *you* did, which is what the left lane holds.
    #expect(regions.first?.lane == .left)
    #expect(regions.first?.kind == .expanded)
  }

  @Test("the expanded band spans the region it opened, not a tick at its start")
  func expandedSpansTheRegion() {
    // The bug this pins: a run block is addressed by its first member's index,
    // and a member of a run longer than one carries a `RowPosition` — so under
    // the mark machinery the band came out as a 2px tick at ordinal 0, a slim
    // marker where the opened region starts rather than a band over it. A region
    // is measured by its *row*, so the exemption is gone with the type.
    var items: [TranscriptItem] = [user("u1")]
    items += (0..<60).map { say("pad\($0)", "line \($0)") }
    let firstCall = items.count
    items += (0..<8).map { call("c\($0)", result: "ok") }
    items.append(say("a1"))

    let open = TerminalExpansion(open: [.run("c0")])
    let state = input(items, expansion: open)
    guard let band = buildScrubberRail(state, railH: 100).regions.first else {
      Issue.record("expected an expanded region")
      return
    }
    let rowIndex = state.rows.rowIndex(forItem: firstCall)
    let scale = railScale(
      railH: 100, totalSize: state.totalSize, viewportH: state.viewportHeight)
    #expect(band.rowIndex == rowIndex)
    #expect(band.h == max(scrubberMinMark, (state.book.height(at: rowIndex) * scale).rounded()))
    // Eight calls drawn open is many lines, so this is a real band and not the
    // floor a tick would have collapsed to.
    #expect(band.h > scrubberMinMark)
  }

  @Test("a lone top-level call bands when opened — it has no run key at all")
  func loneCallBandsWhenOpened() {
    // The fold makes every top-level call a run block, usually of one, and
    // `planRun` draws a run of one as the call itself — so the press writes
    // `.call(id)` and the block has no `.run` key to open. Asking `block.key`
    // meant expanding a lone `Bash` banded nothing at all; that call no longer
    // compiles, and this is the behaviour it used to get wrong.
    let items = [user("u1"), call("c0", result: "a long result"), say("a1")]
    let open = TerminalExpansion(open: [.call("c0")])
    #expect(buildScrubberRail(input(items, expansion: open), railH: 100).regions.count == 1)
    // ...and nothing is banded while it is shut.
    #expect(buildScrubberRail(input(items), railH: 100).regions.isEmpty)
  }

  @Test("a tall band does not swallow the lane and repaint it")
  func tallBandDoesNotSwallowTheLane() {
    // Opening a tool *inside* an opened run made the row enormous, and a merged
    // cluster grows to cover its members and takes the loudest one's colour — so
    // the band absorbed every prompt in the lane and the whole rail went blue.
    // A region is not a point: it is not a cluster at all, so there is no merge
    // rule to exempt it from and no loudness that could win one.
    var items: [TranscriptItem] = [user("u1")]
    items += (0..<8).map { call("c\($0)", result: String(repeating: "line\n", count: 40)) }
    items.append(say("a1"))
    items.append(user("u2"))
    items.append(say("a2"))

    let open = TerminalExpansion(open: [.run("c0"), .call("c3")])
    let rail = buildScrubberRail(input(items, expansion: open), railH: 100)

    // Both prompts keep their own clusters and their own colour.
    #expect(rail.clusters.filter { $0.kind == .user }.count == 2)
    // One row opened, one band — several keys inside it are still one region,
    // because it is one row.
    #expect(rail.regions.count == 1)
    // And the band is not in the mark machinery at all: it is not a lane mate
    // that has to lose a merge, it is ground. The left lane holds exactly the
    // two prompts, and the region is the same rows without being one of them.
    #expect(rail.clusters.filter { $0.lane == .left }.allSatisfy { $0.kind == .user })
    #expect(rail.regions.allSatisfy { $0.lane == .left })
  }

  // MARK: - The outcome rule

  @Test("a failure the model recovered from inside its run earns no mark")
  func recoveredFailureIsNotMarked() {
    // The measured case: a `cd` to the wrong directory, retried and fixed two
    // calls later. Against one real session this was 8 of 9 failures — the rail
    // showed nine alarms for a transcript that reddens one row.
    let items = [
      user("u1"),
      call("c0", result: "no such file or directory", error: true),
      call("c1", result: "ok"),
      call("c2", result: "ok"),
      say("a1"),
    ]
    #expect(!kinds(buildScrubberClusters(input(items), railH: 100)).contains(.toolFailed))
  }

  @Test("a run whose last call failed is the one that marks")
  func runOutcomeIsMarked() {
    #expect(kinds(buildScrubberClusters(input(runEndingInFailure), railH: 100)).contains(.toolFailed))
  }

  @Test("a lone failed call still marks — a run of one is its own outcome")
  func standaloneFailureIsMarked() {
    let items = [user("u1"), call("c0", result: "boom", error: true), say("a1")]
    #expect(kinds(buildScrubberClusters(input(items), railH: 100)).contains(.toolFailed))
  }

  @Test("a sub-agent's failed child does not mark — the rail says what taskFailed says")
  func absorbedChildIsNotMarked() {
    // `taskFailed` already refuses to redden a `Task` for a child's failure: an
    // agent that ran a hundred calls, one of them a grep that matched nothing,
    // did not fail. A red tick on the rail says exactly what the row is
    // forbidden from saying, so it goes too. The band stays: a sub-agent still
    // ran here.
    let marks = kinds(buildScrubberClusters(input(taskWithOneFailedChild), railH: 100))
    #expect(!marks.contains(.toolFailed))
    #expect(marks.contains(.subagent))
  }

  @Test("a Task whose own result errored still marks, child or no child")
  func taskOutcomeIsMarked() {
    let items = [
      user("u1"),
      .toolCall(
        ToolCallItem(
          id: "T", name: "Task", input: .object(["description": .string("explore")]),
          parentToolUseId: nil, status: .settled,
          result: ToolCallResult(text: "crashed", isError: true))),
      call("c0", parent: "T", result: "ok"),
      say("a1"),
    ]
    let marks = kinds(buildScrubberClusters(input(items), railH: 100))
    // Both channels, which is the point of having two: green says a sub-agent
    // ran here, red says it came back broken.
    #expect(marks.contains(.toolFailed))
    #expect(marks.contains(.subagent))
  }

  @Test("an expanded run's failed outcome is a tick inside the row, not a band over it")
  func absorbedChildAnchorsFractionally() {
    let items = runEndingInFailure
    let open = TerminalExpansion(open: [.run("c0")])
    let expanded = input(items, expansion: open)
    let clusters = buildScrubberClusters(expanded, railH: 100)
    guard let failed = clusters.first(where: { $0.kind == .toolFailed }) else {
      Issue.record("expected a toolFailed cluster")
      return
    }
    let rowIndex = expanded.rows.rowIndex(forItem: 4)
    let rowH = expanded.book.height(at: rowIndex)
    let scale = railScale(
      railH: 100, totalSize: expanded.totalSize, viewportH: expanded.viewportHeight)
    // The run folded four calls and this is the last of them.
    #expect(expanded.rows.position(forItem: 4) == RowPosition(ordinal: 3, count: 4))
    #expect(failed.h == scrubberMinMark)
    #expect(
      failed.y
        == min(
          max(0, 100 - scrubberMinMark),
          ((expanded.book.offset(at: rowIndex) + rowH * 3 / 4) * scale).rounded()))
    // The bug: without the fraction the mark would be the whole expanded block.
    #expect(failed.h < (rowH * scale).rounded())
  }

  @Test("collapsed, the same mark sits where it always did")
  func absorbedChildCollapsedIsUnchanged() {
    // Padded to a session's worth of rows, which is the regime that matters:
    // the collapsed task row is one line out of thousands, so every fraction of
    // it rounds onto the row's own offset and siblings merge as they always did.
    let items = runEndingInFailure + (0..<300).map { say("pad\($0)", "line \($0)") }
    let collapsed = input(items)
    let clusters = buildScrubberClusters(collapsed, railH: 100)
    guard let failed = clusters.first(where: { $0.kind == .toolFailed }) else {
      Issue.record("expected a toolFailed cluster")
      return
    }
    // One line, so the fraction rounds onto the row's own offset — the mark is
    // the hit target at the top of the task row, exactly as before.
    let rowIndex = collapsed.rows.rowIndex(forItem: 4)
    #expect(failed.h == scrubberMinMark)
    #expect(
      failed.y
        == (collapsed.book.offset(at: rowIndex)
          * railScale(
            railH: 100, totalSize: collapsed.totalSize, viewportH: collapsed.viewportHeight))
          .rounded())
  }

  @Test("a plain failed call still spans its own row — the rail stays a map")
  func singletonRunKeepsItsExtent() {
    // No answer in it: the response mark now shares the right lane with the
    // failure and would merge with it, hiding the very height under test.
    let items = [user("u1"), call("c1", result: "boom", error: true)]
    let plain = input(items)
    let clusters = buildScrubberClusters(plain, railH: 100)
    guard let failed = clusters.first(where: { $0.kind == .toolFailed }) else {
      Issue.record("expected a toolFailed cluster")
      return
    }
    #expect(plain.rows.position(forItem: 1) == nil)
    let rowIndex = plain.rows.rowIndex(forItem: 1)
    let scale = railScale(
      railH: 100, totalSize: plain.totalSize, viewportH: plain.viewportHeight)
    #expect(failed.h == max(scrubberMinMark, (plain.book.height(at: rowIndex) * scale).rounded()))
  }

  // MARK: - Channels

  /// Every mark with the lane its cluster drew it in — clusters merge, so a
  /// cluster-level filter silently loses the quieter member.
  private func members(_ clusters: [ScrubberCluster]) -> [(lane: ScrubberLane, kind: ScrubberMarkKind, itemIndex: Int)] {
    clusters.flatMap { cluster in
      cluster.marks.map { (lane: cluster.lane, kind: $0.mark.kind, itemIndex: $0.mark.itemIndex) }
    }
  }

  @Test("failures all land in the response lane — one column answers 'did it go wrong'")
  func failuresShareTheOutputChannel() {
    let items: [TranscriptItem] = [
      user("u1"), call("a", status: .failed), .notice(id: "n", level: .error, text: "bad"),
      say("s1"), turn("t1", failed: true),
    ]
    let marks = members(buildScrubberClusters(input(items, viewport: 4000), railH: 400))
    for kind in [ScrubberMarkKind.toolFailed, .error, .turnFailed] {
      #expect(marks.contains { $0.kind == kind && $0.lane == .right })
      #expect(!marks.contains { $0.kind == kind && $0.lane != .right })
    }
  }

  @Test("a sub-agent bands the input lane, by membership and not by name")
  func subagentBandsTheInputChannel() {
    // The spawning call is named `Agent`, not `Task`: the SDK's name is a
    // convention, so the rule is that an id other items nest under is an agent.
    let items: [TranscriptItem] = [
      user("u1"), call("agent-1", "Agent"), call("c1", "Grep", parent: "agent-1"), say("s1"),
    ]
    let marks = members(buildScrubberClusters(input(items, viewport: 4000), railH: 400))
    let band = marks.filter { $0.kind == .subagent }
    #expect(band.count == 1)
    #expect(band.first?.lane == .left)
    #expect(band.first?.itemIndex == 1)

    // A childless call is not a sub-agent.
    let plain = members(
      buildScrubberClusters(input([user("u1"), call("a")], viewport: 4000), railH: 400))
    #expect(!plain.contains { $0.kind == .subagent })
  }

  @Test("a failed sub-agent gets a band and a failure mark, one per channel")
  func failedSubagentMarksBothChannels() {
    let items: [TranscriptItem] = [
      user("u1"), call("task-1", "Task", status: .failed),
      call("c1", "Read", parent: "task-1"),
    ]
    let marks = members(buildScrubberClusters(input(items, viewport: 4000), railH: 400))
    #expect(marks.filter { $0.kind == .subagent }.map(\.lane) == [.left])
    #expect(marks.filter { $0.kind == .toolFailed }.map(\.lane) == [.right])
  }

  @Test("a prompt keeps the input lane when a dispatch merges with it")
  func promptOutranksTheBand() {
    let items: [TranscriptItem] = [
      user("u1"), call("task-1", "Task"), call("c1", "Read", parent: "task-1"),
    ]
    // A tiny rail, so everything in a lane chain-merges.
    let clusters = buildScrubberClusters(input(items, viewport: 4000), railH: 4)
    let left = clusters.filter { $0.lane == .left }
    #expect(left.count == 1)
    #expect(left[0].kind == .user)
    // ...and the dispatch is still in it, one press away.
    #expect(left[0].marks.contains { $0.mark.kind == .subagent })
  }
}

// MARK: - Inside a sub-agent frame

extension TerminalScrubberTests {
  /// The takeover renders `subagentItems`, so EVERY item there has a parent.
  /// The rail's "top level only" tests then excluded all of them and it came
  /// out mounted, banded, and marking nothing on a hundred-tool agent — which
  /// is exactly the run that needs a rail. "Top level" is now the frame's level
  /// (`ScrubberInput.frameParentId`), mirroring web `scrubber.test.ts`'s
  /// `inside a sub-agent frame` cases — plus the brief-row interaction, which
  /// is this client's own: the frame's rows open on a synthetic row no item
  /// maps to, and every mark must land past it.
  private func spawningTask(_ id: String) -> ToolCallItem {
    ToolCallItem(
      id: id, name: "Task",
      input: .object([
        "subagent_type": .string("Explore"), "description": .string("dig in"),
        "prompt": .string("Find the tests and read them."),
      ]),
      parentToolUseId: nil, status: .running, result: nil)
  }

  @Test("a frame marks every narration step, where the conversation marks one per segment")
  func frameMarksEveryStep() {
    // No prompts and no `turn_result` exist in a sub-agent's stream, so the
    // segment machinery would fold the lot into a single mark at the final
    // report — the one place a reader can already reach.
    let items = [
      say("s1", "looking", parent: "T1"),
      say("s2", "found it", parent: "T1"),
      say("s3", "done", parent: "T1"),
    ]
    let scrub = input(items, frameParentId: "T1", frameTask: spawningTask("T1"))
    let marks = buildScrubberClusters(scrub, railH: 300).flatMap { $0.marks }.map(\.mark)
    #expect(marks.map(\.kind) == [.turn, .turn, .turn])
    #expect(marks.map(\.itemIndex) == [0, 1, 2])
    // The brief row leads the frame's rows and no item maps to it — the same
    // mechanism that keeps marks off the recap seam (a row with no index), so
    // every mark's row lands past it, at the offsets the book keeps for the
    // shifted rows.
    #expect(scrub.rows.rows.first == .brief(id: "T1", text: "Find the tests and read them."))
    #expect(marks.map(\.rowIndex) == [1, 2, 3])
  }

  @Test("a frame marks a failure its own renderer reddens")
  func frameMarksItsOwnFailure() {
    // No level test guards this one — `redItemIndices` reads the frame's own
    // fold — but it is the second thing the web pins and the claim is the
    // rail's whole rule: red in the transcript, red on the rail.
    let items = [
      say("s1", "trying", parent: "T1"),
      call("c1", parent: "T1", status: .failed),
    ]
    let clusters = buildScrubberClusters(
      input(items, frameParentId: "T1", frameTask: spawningTask("T1")), railH: 300)
    #expect(kinds(clusters).contains(.toolFailed))
  }

  @Test("the conversation still marks nothing of a sub-agent's own steps")
  func topLevelStillExcludesFrameSteps() {
    // The regression guard on the generalisation: at the top level a
    // sub-agent's steps are represented by its `Task` band, never by a second
    // set of marks threaded through the rail.
    let items = [
      user("u1", "go"),
      say("s1", "looking", parent: "T1"),
      say("a1", "done"),
      turn("t1"),
    ]
    let marks = buildScrubberClusters(input(items), railH: 300)
      .flatMap { $0.marks }.map(\.mark)
    #expect(marks.map(\.kind).sorted { $0.rawValue < $1.rawValue } == [.turn, .user])
    #expect(!marks.contains { $0.itemIndex == 1 })
  }

  @Test("an opened brief row bands like any block you opened")
  func openedBriefBands() {
    // The brief row is synthetic — no fold produces it — but opening it is
    // still opened height, and the region walk reads row-level keys so it is
    // not invisible to the rail. Closed, nothing bands.
    let items = [say("s1", "looking", parent: "T1")]
    let open = TerminalExpansion(open: [.brief("T1")])
    let banded = buildScrubberRail(
      input(items, expansion: open, frameParentId: "T1", frameTask: spawningTask("T1")),
      railH: 300)
    #expect(banded.regions.count == 1)
    #expect(banded.regions.first?.rowIndex == 0)
    #expect(banded.regions.first?.lane == .left)
    let shut = buildScrubberRail(
      input(items, frameParentId: "T1", frameTask: spawningTask("T1")), railH: 300)
    #expect(shut.regions.isEmpty)
  }
}
