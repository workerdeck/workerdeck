import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Live tool output")
struct LiveToolTests {
  private let started: Double = 1_722_300_000_000

  // MARK: - Reducer

  // MARK: - Rules

  @Test func elapsedWaitsFiveSecondsAndFloorsToWholeSeconds() {
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 4999) == nil)
    #expect(LiveTool.elapsedLabel(startedAt: nil, now: started + 60_000) == nil)
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 5900) == "5.0s")
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 375_400) == "6m 15s")
  }

  @Test func theElapsedLabelStartsAfterTheTextAndItsWideCells() {
    let line = TermLine(text: "● 漢字  ", elapsedSince: started)
    #expect(LiveTool.elapsedColumn(line) == 6)
    #expect(LiveTool.elapsedText(line, now: started + 7000) == " · 7.0s")
    #expect(LiveTool.elapsedText(TermLine(text: "", elapsedSince: started), now: started + 7000) == "7.0s")
    #expect(LiveTool.elapsedText(line, now: started + 1000) == nil)
  }
}
