import Testing

@testable import WorkerDeckKit

/// The unread model — a port of `packages/react/test/watermarks.test.ts`.
@Suite("Watermarks")
struct WatermarksTests {
  /// An in-memory store standing in for UserDefaults, counting writes.
  private final class StoreBox {
    var data: [String: Watermark]
    var writes = 0

    init(_ initial: [String: Watermark] = [:]) {
      data = initial
    }

    var seam: WatermarkStore {
      WatermarkStore(
        read: { [self] in data },
        write: { [self] marks in
          data = marks
          writes += 1
        })
    }
  }

  // MARK: - mark

  @Test func neverWalksAMarkBackwards() {
    // A transcript that shrank — a compaction, or a fresh attach mid-replay —
    // must not resurrect rows the user already read.
    let box = StoreBox()
    let marks = Watermarks(store: box.seam)
    marks.mark(hostId: "mac", sessionId: "a", itemCount: 40, activity: 40, turns: 5, now: 1_000)
    marks.mark(hostId: "mac", sessionId: "a", itemCount: 3, activity: 3, turns: 1, now: 2_000)
    let mark = marks.get(hostId: "mac", sessionId: "a")
    #expect(mark?.itemCount == 40)
    #expect(mark?.activity == 40)
    #expect(mark?.turns == 5)
  }

  @Test func reportsWhetherItMovedBecauseNothingElseWillSaySo() {
    // Reading rows on the session screen is silent: no poll, no event. A caller
    // that doesn't hear about this holds a stale unread badge indefinitely.
    let marks = Watermarks(store: StoreBox().seam)
    #expect(marks.mark(hostId: "mac", sessionId: "a", activity: 10, now: 1_000))
    #expect(!marks.mark(hostId: "mac", sessionId: "a", activity: 10, now: 1_500))
    #expect(marks.mark(hostId: "mac", sessionId: "a", activity: 11, now: 1_600))
  }

  @Test func touchesOnceAMinuteSoLastHereStaysHonest() {
    let marks = Watermarks(store: StoreBox().seam)
    marks.mark(hostId: "mac", sessionId: "a", activity: 10, now: 1_000)
    #expect(!marks.mark(hostId: "mac", sessionId: "a", activity: 10, now: 1_000 + 59_000))
    #expect(marks.mark(hostId: "mac", sessionId: "a", activity: 10, now: 1_000 + 61_000))
  }

  @Test func prunesMarksOlderThanThirtyDaysOnWrite() {
    let now: Double = 100 * 24 * 60 * 60 * 1000
    let box = StoreBox(["mac:ancient": Watermark(itemCount: 1, activity: 1, turns: 1, seenAt: 0)])
    let marks = Watermarks(store: box.seam)
    marks.mark(hostId: "mac", sessionId: "fresh", activity: 1, now: now)
    #expect(Array(box.data.keys) == ["mac:fresh"])
  }

  @Test func forgetsADeletedSession() {
    let box = StoreBox()
    let marks = Watermarks(store: box.seam)
    marks.mark(hostId: "mac", sessionId: "a", activity: 3, now: 1_000)
    marks.forget(hostId: "mac", sessionId: "a")
    #expect(marks.get(hostId: "mac", sessionId: "a") == nil)
    // A forget for something absent must not write — it would churn storage on
    // every poll that sees a session already gone.
    let before = box.writes
    marks.forget(hostId: "mac", sessionId: "a")
    #expect(box.writes == before)
  }

  // MARK: - unseenCount

  private let mark = Watermark(itemCount: 40, activity: 40, turns: 5, seenAt: 0)

  @Test func countsRowsNotTurnsWhenTheGatewayReportsThem() {
    // Five tool calls in one turn is one turn and eight rows; the badge that
    // says "1" for it is the one nobody believes.
    #expect(unseenCount(mark: mark, activityCount: 48, turns: 6) == 8)
  }

  @Test func fallsBackToTurnsForAGatewayTooOldToReportRows() {
    #expect(unseenCount(mark: mark, activityCount: nil, turns: 7) == 2)
  }

  @Test func isZeroForASessionNeverVisited() {
    // "Never opened" is not "unread" — a badge counting every session's whole
    // history on first launch is noise on the one day it should be quiet.
    #expect(unseenCount(mark: nil, activityCount: 900, turns: nil) == 0)
  }

  @Test func neverGoesNegativeWhenTheRollupLagsTheMark() {
    #expect(unseenCount(mark: mark, activityCount: 12, turns: nil) == 0)
  }

  // MARK: - unseenCount, prose

  @Test func prefersProseOverRowsSoAToolLoopingSessionBadgesNothing() {
    let read = Watermark(itemCount: 40, activity: 40, prose: 4, turns: 5, seenAt: 0)
    // Eight new rows, none of them anything a person is waiting to read.
    #expect(unseenCount(mark: read, proseCount: 4, activityCount: 48, turns: 6) == 0)
    #expect(unseenCount(mark: read, proseCount: 5, activityCount: 48, turns: 6) == 1)
  }

  @Test func readsAPreProseMarkAsCaughtUpRatherThanAWholeUnreadHistory() {
    #expect(unseenCount(mark: mark, proseCount: 12, activityCount: 40, turns: nil) == 0)
  }

  @Test func leavesAStoredProseMarkAloneWhenTheCallerHasNothingToSayAboutProse() {
    let box = StoreBox()
    let marks = Watermarks(store: box.seam)
    marks.mark(hostId: "mac", sessionId: "a", activity: 10, prose: 3, now: 1_000)
    // An older gateway drops out of the rollup: `prose` nil must not read as 0.
    marks.mark(hostId: "mac", sessionId: "a", activity: 12, now: 200_000)
    #expect(marks.get(hostId: "mac", sessionId: "a")?.prose == 3)
  }

  @Test func movesOnProseAloneSoReadingAParagraphClearsTheBadge() {
    let box = StoreBox()
    let marks = Watermarks(store: box.seam)
    marks.mark(hostId: "mac", sessionId: "a", activity: 10, prose: 3, now: 1_000)
    #expect(marks.mark(hostId: "mac", sessionId: "a", activity: 10, prose: 4, now: 1_500))
  }
}
