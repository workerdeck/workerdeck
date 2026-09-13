import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("TranscriptScrollGeometry")
struct TranscriptScrollGeometryTests {
  private func geometry(
    content: CGFloat, frame: CGFloat, insetTop: CGFloat = 0, insetBottom: CGFloat = 0
  ) -> TranscriptScrollGeometry {
    TranscriptScrollGeometry(
      contentHeight: content, frameHeight: frame, insetTop: insetTop, insetBottom: insetBottom)
  }

  @Test("the bottom is the last point above the bottom inset")
  func bottomOfTallContent() {
    let tall = geometry(content: 2329, frame: 633, insetTop: 100, insetBottom: 90)
    #expect(tall.top == -100)
    #expect(tall.bottom == 1786)
  }

  @Test("content shorter than the frame has its top for a bottom")
  func bottomOfShortContent() {
    let short = geometry(content: 85, frame: 633, insetTop: 100)
    #expect(short.bottom == short.top)
  }

  @Test("offsets clamp to the range")
  func clamps() {
    let tall = geometry(content: 2329, frame: 633, insetTop: 100)
    #expect(tall.clamped(-500) == -100)
    #expect(tall.clamped(300) == 300)
    #expect(tall.clamped(9999) == tall.bottom)
  }

  @Test("a jump within the threshold of the bottom pins; one above it does not")
  func jumpPinsFromWhereItLands() {
    let tall = geometry(content: 2329, frame: 633)
    #expect(tall.pinsAfterJump(to: tall.bottom, threshold: 44, complete: true))
    #expect(tall.pinsAfterJump(to: tall.bottom - 44, threshold: 44, complete: true))
    #expect(!tall.pinsAfterJump(to: tall.bottom - 45, threshold: 44, complete: true))
    #expect(!tall.pinsAfterJump(to: 0, threshold: 44, complete: true))
  }

  @Test("a jump into a transcript still filling never pins")
  func fillingTranscriptNeverPins() {
    // Measured on the simulator with the hold released at seq 1503 of 8472: the deep link's
    // row was the last of ten, 2295 into 2329 points, so the jump pinned and every event of
    // the remaining replay dragged the reader to the tail.
    let filling = geometry(content: 2329, frame: 0)
    #expect(filling.pinsAfterJump(to: 2295, threshold: 44, complete: true))
    #expect(!filling.pinsAfterJump(to: 2295, threshold: 44, complete: false))
    // The first row of a transcript shorter than the screen sits at its bottom too.
    let short = geometry(content: 85, frame: 633)
    #expect(short.pinsAfterJump(to: short.top, threshold: 44, complete: true))
    #expect(!short.pinsAfterJump(to: short.top, threshold: 44, complete: false))
  }
}
