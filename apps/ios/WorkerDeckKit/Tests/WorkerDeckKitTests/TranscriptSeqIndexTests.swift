import Testing

@testable import WorkerDeckKit

/// The seq → item lookup behind the push deep link. Everything the app layer
/// does with it is a scroll nobody can assert on, so the arithmetic is tested
/// here and the app is left with plumbing.
@Suite("TranscriptSeqIndex")
struct TranscriptSeqIndexTests {
  /// Fold a script of `(seq, appended)` into an index.
  private func index(_ script: [(seq: Int, appended: Int)]) -> TranscriptSeqIndex {
    var index = TranscriptSeqIndex()
    var count = 0
    for step in script {
      let before = count
      count += step.appended
      index.note(seq: step.seq, itemsBefore: before, itemsAfter: count)
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
    var built = TranscriptSeqIndex()
    built.note(seq: 2, itemsBefore: 0, itemsAfter: 1)
    built.note(seq: 6, itemsBefore: 1, itemsAfter: 1)
    built.note(seq: 9, itemsBefore: 1, itemsAfter: 2)
    #expect(built.item(forSeq: 6) == 1)
    #expect(built.count == 2)
  }

  @Test("a seq older than anything held lands on the top of what there is")
  func olderThanRetained() {
    // The gateway's retention dropped the head of the session, so the transcript
    // starts at seq 40 — a notification about seq 3 can only offer the first row.
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
    built.note(seq: 2, itemsBefore: 0, itemsAfter: 1)
    built.note(seq: 5, itemsBefore: 1, itemsAfter: 3)
    // conversation_reset empties `items`; every recorded index now points past
    // the end of the list.
    built.note(seq: 8, itemsBefore: 3, itemsAfter: 0)
    #expect(built.isEmpty)
    #expect(built.item(forSeq: 2) == nil)
    built.note(seq: 11, itemsBefore: 0, itemsAfter: 1)
    #expect(built.item(forSeq: 11) == 0)
  }

  @Test("a reset that leaves rows behind starts them at zero")
  func resetLeavingRows() {
    var built = TranscriptSeqIndex()
    built.note(seq: 2, itemsBefore: 0, itemsAfter: 4)
    built.note(seq: 8, itemsBefore: 4, itemsAfter: 1)
    #expect(built.count == 1)
    #expect(built.item(forSeq: 8) == 0)
  }

  @Test("a seq that does not advance is refused")
  func nonAdvancingSeq() {
    var built = TranscriptSeqIndex()
    built.note(seq: 5, itemsBefore: 0, itemsAfter: 1)
    built.note(seq: 5, itemsBefore: 1, itemsAfter: 2)
    #expect(built.count == 1)
    #expect(built.item(forSeq: 5) == 0)
  }

  @Test("the lookup binary-searches a long history correctly")
  func longHistory() {
    // Every second event appends, so the answer is checkable in closed form and
    // the search is exercised well past the point a walk would still pass.
    var built = TranscriptSeqIndex()
    var count = 0
    for step in 0..<500 {
      let seq = step * 2 + 1
      let before = count
      count += step.isMultiple(of: 2) ? 1 : 0
      built.note(seq: seq, itemsBefore: before, itemsAfter: count)
    }
    #expect(built.item(forSeq: 1) == 0)
    // seq 5 is step 2, the second appending event.
    #expect(built.item(forSeq: 5) == 1)
    // seq 4 appended nothing (it is not even an event) — round up to step 2's.
    #expect(built.item(forSeq: 4) == 1)
    #expect(built.item(forSeq: 997) == 249)
  }
}
