import Testing

@testable import WorkerDeckKit

/// The seq → item lookup behind the push deep link. Everything the app layer
/// does with it is a scroll nobody can assert on, so the arithmetic is tested
/// here and the app is left with plumbing.
@Suite("TranscriptSeqIndex")
struct TranscriptSeqIndexTests {
  private func rows(_ ids: [String]) -> [TranscriptItem] {
    ids.map { .notice(id: $0, level: .info, text: $0) }
  }

  /// Fold a script of `(seq, appended)` into an index, minting a fresh row id per append.
  private func index(_ script: [(seq: Int, appended: Int)]) -> TranscriptSeqIndex {
    var index = TranscriptSeqIndex()
    var ids: [String] = []
    for step in script {
      let before = ids
      for _ in 0..<step.appended { ids.append("r\(ids.count)") }
      index.note(seq: step.seq, before: rows(before), after: rows(ids))
    }
    return index
  }

  @Test("an empty index answers nothing")
  func empty() {
    #expect(TranscriptSeqIndex().item(forSeq: 7) == nil)
    #expect(TranscriptSeqIndex().isEmpty)
  }

  @Test("an event that appended is found at its own first item")
  func exactMatch() {
    let index = index([(2, 1), (5, 2), (9, 1)])
    #expect(index.item(forSeq: 2) == 0)
    #expect(index.item(forSeq: 5) == 1)
    #expect(index.item(forSeq: 9) == 3)
  }

  @Test("an event that appended nothing lands on the next row written")
  func nearestAfter() {
    // seq 6 mutated an existing item (a tool result settling onto its call) and
    // recorded nothing; the row nearest after it is seq 9's.
    let index = index([(2, 1), (6, 0), (9, 1)])
    #expect(index.item(forSeq: 6) == 1)
    #expect(index.count == 2)
  }

  @Test("a seq older than anything held lands on the top of what there is")
  func olderThanRetained() {
    // The gateway's retention dropped the head of the session, so the transcript
    // starts at seq 40 - a notification about seq 3 can only offer the first row.
    let index = index([(40, 1), (44, 1)])
    #expect(index.item(forSeq: 3) == 0)
  }

  @Test("a seq newer than anything held answers nothing")
  func newerThanHeld() {
    // Which is the point: the caller leaves the reader pinned at the tail, where
    // that event is about to appear anyway.
    let index = index([(2, 1), (5, 1)])
    #expect(index.item(forSeq: 6) == nil)
  }

  @Test("a /clear drops every landmark it invalidated")
  func conversationReset() {
    var built = TranscriptSeqIndex()
    built.note(seq: 2, before: [], after: rows(["a"]))
    built.note(seq: 5, before: rows(["a"]), after: rows(["a", "b", "c"]))
    built.note(seq: 8, before: rows(["a", "b", "c"]), after: [])
    #expect(built.isEmpty)
    #expect(built.item(forSeq: 2) == nil)
    built.note(seq: 11, before: [], after: rows(["d"]))
    #expect(built.item(forSeq: 11) == 0)
  }

  @Test("a reset that leaves rows behind starts them at zero")
  func resetLeavingRows() {
    // A compaction that replaced the history with a summary: nothing of the old
    // list survives, so the surviving landmark is the summary's own.
    var built = TranscriptSeqIndex()
    built.note(seq: 2, before: [], after: rows(["a", "b", "c", "d"]))
    built.note(seq: 8, before: rows(["a", "b", "c", "d"]), after: rows(["summary"]))
    #expect(built.count == 1)
    #expect(built.item(forSeq: 8) == 0)
  }

  @Test("a streamed placeholder giving way to its finished message keeps the older landmarks")
  func streamedThinkingSuperseded() {
    // `assistant_message` drops the streamed thinking row it supersedes, shrinking the
    // list by one in a perfectly ordinary turn. Treating that as a `/clear` is what left
    // every session that has ever shown thinking with no landmarks at all.
    var built = TranscriptSeqIndex()
    built.note(seq: 2, before: [], after: rows(["prompt"]))
    built.note(seq: 4, before: rows(["prompt"]), after: rows(["prompt", "stream-thinking"]))
    built.note(
      seq: 7, before: rows(["prompt", "stream-thinking"]), after: rows(["prompt", "msg-0"]))
    #expect(built.item(forSeq: 2) == 0)
    #expect(built.item(forSeq: 7) == 1)
  }

  @Test("a message that replaces one streamed row with two starts at the first of them")
  func streamedTextSupersededByTwoBlocks() {
    var built = TranscriptSeqIndex()
    built.note(seq: 2, before: [], after: rows(["prompt"]))
    built.note(seq: 4, before: rows(["prompt"]), after: rows(["prompt", "stream-text"]))
    built.note(
      seq: 7, before: rows(["prompt", "stream-text"]),
      after: rows(["prompt", "msg-0", "msg-1"]))
    #expect(built.item(forSeq: 7) == 1)
    #expect(built.item(forSeq: 2) == 0)
  }

  @Test("a seq that does not advance is refused")
  func nonAdvancingSeq() {
    var built = TranscriptSeqIndex()
    built.note(seq: 5, before: [], after: rows(["a"]))
    built.note(seq: 5, before: rows(["a"]), after: rows(["a", "b"]))
    #expect(built.count == 1)
    #expect(built.item(forSeq: 5) == 0)
  }

  @Test("the lookup binary-searches a long history correctly")
  func longHistory() {
    // Every second event appends, so the answer is checkable in closed form and
    // the search is exercised well past the point a walk would still pass.
    var built = TranscriptSeqIndex()
    var ids: [String] = []
    for step in 0..<500 {
      let before = ids
      if step.isMultiple(of: 2) { ids.append("r\(ids.count)") }
      built.note(seq: step * 2 + 1, before: rows(before), after: rows(ids))
    }
    #expect(built.item(forSeq: 1) == 0)
    // seq 5 is step 2, the second appending event.
    #expect(built.item(forSeq: 5) == 1)
    // seq 4 appended nothing (it is not even an event) - round up to step 2's.
    #expect(built.item(forSeq: 4) == 1)
    #expect(built.item(forSeq: 997) == 249)
  }
}

@Suite("deepLinkSeqSurvives")
struct DeepLinkSeqSurvivesTests {
  @Test("a gateway that never names a log is trusted, as it was before the field existed")
  func bothAbsent() {
    #expect(deepLinkSeqSurvives(pushEpoch: nil, sessionEpoch: nil))
  }

  @Test("a session still on its first log is trusted")
  func sameEpoch() {
    #expect(deepLinkSeqSurvives(pushEpoch: 2, sessionEpoch: 2))
  }

  @Test("a push that sat on a lock screen across a wake is refused")
  func staleAcrossWake() {
    // The wake renumbers the log, so the payload's seq now names some unrelated row -
    // the failure the counts cannot see, because a small seq is a plausible one.
    #expect(!deepLinkSeqSurvives(pushEpoch: nil, sessionEpoch: 1))
    #expect(!deepLinkSeqSurvives(pushEpoch: 1, sessionEpoch: 2))
  }
}

@Suite("deepLinkPlacement")
struct DeepLinkPlacementTests {
  @Test("a row found while the replay is still filling is landed on but not followed")
  func rowFoundMidReplay() {
    #expect(
      deepLinkPlacement(item: 27, lastSeq: 1503, attachLastSeq: 8472) == .item(27, complete: false))
  }

  @Test("a row found once the stated seq is reached follows the tail if it is the tail")
  func rowFoundAfterLanding() {
    #expect(
      deepLinkPlacement(item: 27, lastSeq: 8472, attachLastSeq: 8472) == .item(27, complete: true))
    // A live session keeps moving past the attach frame's seq; that is still complete.
    #expect(
      deepLinkPlacement(item: 27, lastSeq: 8490, attachLastSeq: 8472) == .item(27, complete: true))
  }

  @Test("no row yet is a question to ask again on the next event")
  func noRowBeforeLanding() {
    #expect(deepLinkPlacement(item: nil, lastSeq: 1503, attachLastSeq: 8472) == .pending)
  }

  @Test("no row once the stated seq is reached is the tail, settled")
  func noRowAfterLanding() {
    #expect(deepLinkPlacement(item: nil, lastSeq: 8472, attachLastSeq: 8472) == .unplaceable)
  }
}
