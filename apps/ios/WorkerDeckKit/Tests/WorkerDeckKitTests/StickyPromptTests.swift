import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("StickyPrompt")
struct StickyPromptTests {
  private let line: CGFloat = 18

  // Turns of a prompt row (a gap line, then one line) and an answer row (a gap line, then three lines).
  private struct Turns {
    var offsets: [CGFloat] = []
    var promptRows: [Int] = []
    var total: CGFloat = 0
  }

  private func turns(_ count: Int) -> Turns {
    var result = Turns()
    for _ in 0..<count {
      result.promptRows.append(result.offsets.count)
      result.offsets.append(result.total)
      result.total += 2 * line
      result.offsets.append(result.total)
      result.total += 4 * line
    }
    return result
  }

  private func resolve(_ turns: Turns, top: CGFloat, strip: CGFloat? = nil) -> StickyPrompt.Pin? {
    StickyPrompt.resolve(
      promptRows: turns.promptRows, contentTop: { turns.offsets[$0] + line }, top: top, line: line,
      stripHeight: strip)
  }

  @Test("nothing is pinned while the prompt is on screen in its own right")
  func noPinWhileVisible() {
    let three = turns(3)
    #expect(resolve(three, top: three.offsets[0] + line) == nil)
  }

  @Test("the prompt of the turn being read is the one pinned")
  func pinsTheTurnBeingRead() {
    let four = turns(4)
    for promptRow in four.promptRows {
      let pin = resolve(four, top: four.offsets[promptRow + 1] + 1)
      #expect(pin == StickyPrompt.Pin(row: promptRow, offset: 0))
    }
  }

  @Test("the next prompt lifts the pinned one out rather than sliding under it")
  func handsOffToTheNextPrompt() {
    let three = turns(3)
    let next = three.promptRows[1]
    let contentEdge = three.offsets[next] + line
    #expect(resolve(three, top: contentEdge - line) == StickyPrompt.Pin(row: 0, offset: 0))
    #expect(resolve(three, top: contentEdge - line / 2) == StickyPrompt.Pin(row: 0, offset: -line / 2))
    #expect(resolve(three, top: contentEdge) == nil)
    // Inside the blank line above the new prompt the old one still holds: that strip is the previous turn's.
    #expect(resolve(three, top: three.offsets[next])?.row == 0)
  }

  @Test("a taller strip hands off against its own height, not the grid line")
  func handsOffAgainstTheStripHeight() {
    let three = turns(3)
    let contentEdge = three.offsets[three.promptRows[1]] + line
    let strip = line + 10
    #expect(resolve(three, top: contentEdge - line, strip: strip) == StickyPrompt.Pin(row: 0, offset: line - strip))
    #expect(resolve(three, top: contentEdge - strip, strip: strip)?.offset == 0)
  }

  @Test("the lift never exceeds one line")
  func liftIsBounded() {
    let three = turns(3)
    for top in stride(from: 0.0, through: three.total, by: 3) {
      guard let pin = resolve(three, top: top) else { continue }
      #expect(pin.offset <= 0)
      #expect(pin.offset >= -line)
    }
  }

  @Test("no prompts pin nothing, and a long transcript resolves")
  func degenerateAndLong() {
    #expect(resolve(Turns(), top: 999) == nil)
    let many = turns(4_000)
    let last = many.promptRows[3_999]
    #expect(resolve(many, top: many.offsets[last + 1] + 1)?.row == last)
  }
}
