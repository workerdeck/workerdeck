import Foundation
import Testing

@testable import WorkerDeckKit

/// The sticky prompt — which turn's prompt is held at the top, and the hand-off
/// as the next one arrives.
///
/// The whole feature is this arithmetic; the view draws what it returns. That
/// split exists because a `UIViewRepresentable` overlay cannot be driven by a
/// test and this is the part that can be wrong.
@Suite("StickyPrompt")
struct StickyPromptTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)

  private func user(_ id: String, _ text: String, parent: String? = nil) -> TranscriptItem {
    .user(id: id, text: text, attachments: nil, parentToolUseId: parent)
  }
  private func answer(_ id: String, _ text: String = "an answer") -> TranscriptItem {
    .assistantText(id: id, text: text, streaming: false, parentToolUseId: nil)
  }

  /// Three turns, each a prompt followed by an answer.
  private func transcript(turns: Int) -> TerminalRows {
    var items: [TranscriptItem] = []
    for turn in 0..<turns {
      items.append(user("u\(turn)", "prompt \(turn)"))
      items.append(answer("a\(turn)"))
    }
    return TerminalRows.build(items: items)
  }

  private func book(_ rows: TerminalRows) -> TerminalHeightBook {
    TerminalHeightBook(rows: rows, metrics: metrics)
  }

  @Test("a subagent's brief is not the human's prompt")
  func subagentBriefIsNotAPrompt() {
    // It really is a `user_message` on the wire — which is why it once rendered
    // with the human's own `❯` — but it is the parent agent talking to its
    // child. A turn is a thing a person started.
    let rows = TerminalRows.build(items: [
      user("u0", "do the thing"),
      .toolCall(
        ToolCallItem(id: "t1", name: "Task", input: .object([:]), status: .running)),
      user("brief", "explore the repo", parent: "t1"),
      answer("a0"),
    ])
    let prompts = rows.promptRows
    #expect(prompts.count == 1)
    #expect(rows.rowIndex(forItem: 0) == prompts[0])
  }

  @Test("nothing is pinned while the prompt is on screen in its own right")
  func noPinWhileVisible() {
    // Two identical lines a pixel apart is the seam this theme exists not to
    // have, so the pin takes over only once the real line has left.
    let rows = transcript(turns: 3)
    let heights = book(rows)
    let first = rows.promptRows[0]
    #expect(
      StickyPrompt.resolve(
        promptRows: rows.promptRows, rows: rows, book: heights,
        top: heights.offset(at: first), line: metrics.line) == nil)
  }

  @Test("the prompt of the turn being read is the one pinned")
  func pinsTheTurnBeingRead() {
    let rows = transcript(turns: 4)
    let heights = book(rows)
    let prompts = rows.promptRows
    for (turn, promptRow) in prompts.enumerated() {
      // A point just inside the turn's own answer.
      let top = heights.offset(at: promptRow) + heights.height(at: promptRow) + 1
      let pin = StickyPrompt.resolve(
        promptRows: prompts, rows: rows, book: heights, top: top, line: metrics.line)
      #expect(pin?.row == promptRow, "turn \(turn)")
      #expect(pin?.offset == 0, "turn \(turn) is fully pinned mid-answer")
    }
  }

  @Test("the next prompt lifts the pinned one out rather than sliding under it")
  func handsOffToTheNextPrompt() {
    let rows = transcript(turns: 3)
    let heights = book(rows)
    let prompts = rows.promptRows
    let next = prompts[1]
    let gap = rows.gapBefore(next) ? metrics.line : 0
    // The next prompt's content edge, walked up to the viewport's top edge.
    let contentEdge = heights.offset(at: next) + gap

    // A whole line out: still fully pinned.
    var pin = StickyPrompt.resolve(
      promptRows: prompts, rows: rows, book: heights, top: contentEdge - metrics.line,
      line: metrics.line)
    #expect(pin?.row == prompts[0])
    #expect(pin?.offset == 0)

    // Half a line in: half lifted, and it is still the *old* prompt being drawn.
    pin = StickyPrompt.resolve(
      promptRows: prompts, rows: rows, book: heights, top: contentEdge - metrics.line / 2,
      line: metrics.line)
    #expect(pin?.row == prompts[0])
    #expect(pin?.offset == -metrics.line / 2)

    // At its content edge: the new prompt's own line is at the top, so nothing
    // is pinned — `noPinWhileVisible`'s rule, arrived at from the other side.
    pin = StickyPrompt.resolve(
      promptRows: prompts, rows: rows, book: heights, top: contentEdge, line: metrics.line)
    #expect(pin == nil)

    // And one line *earlier* — inside the blank line above the new prompt —
    // the old one is still fully pinned. That strip is the previous turn's, and
    // reading the frame offset instead of the content offset handed over here.
    pin = StickyPrompt.resolve(
      promptRows: prompts, rows: rows, book: heights, top: heights.offset(at: next),
      line: metrics.line)
    #expect(pin?.row == prompts[0])
  }

  @Test("a taller strip hands off against its own height, not the grid line")
  func handsOffAgainstTheStripHeight() {
    // The strip carries air above and below its line and a rule under it, so it
    // is taller than a row. Measuring the hand-off against the grid line would
    // let the next prompt slide under that padding before the lift began.
    let rows = transcript(turns: 3)
    let heights = book(rows)
    let prompts = rows.promptRows
    let next = prompts[1]
    let strip = metrics.line + 10
    let contentEdge = heights.offset(at: next) + (rows.gapBefore(next) ? metrics.line : 0)

    // A grid line out — inside the strip's height, so the lift has begun.
    let pin = StickyPrompt.resolve(
      promptRows: prompts, rows: rows, book: heights, top: contentEdge - metrics.line,
      line: metrics.line, stripHeight: strip)
    #expect(pin?.row == prompts[0])
    #expect(pin?.offset == metrics.line - strip)

    // A whole strip out: untouched.
    #expect(
      StickyPrompt.resolve(
        promptRows: prompts, rows: rows, book: heights, top: contentEdge - strip,
        line: metrics.line, stripHeight: strip)?.offset == 0)
  }

  @Test("the lift never exceeds one line")
  func liftIsBounded() {
    // Anything past a line would draw the pinned copy over the row above the
    // fold, which is not the transcript's own content.
    let rows = transcript(turns: 3)
    let heights = book(rows)
    let prompts = rows.promptRows
    for step in stride(from: 0.0, through: heights.totalHeight, by: 3) {
      guard
        let pin = StickyPrompt.resolve(
          promptRows: prompts, rows: rows, book: heights, top: step, line: metrics.line)
      else { continue }
      #expect(pin.offset <= 0)
      #expect(pin.offset >= -metrics.line)
    }
  }

  @Test("an empty transcript and a transcript with no prompts pin nothing")
  func degenerateCases() {
    let empty = TerminalRows(rows: [])
    #expect(
      StickyPrompt.resolve(
        promptRows: [], rows: empty, book: book(empty), top: 0, line: metrics.line) == nil)
    let answersOnly = TerminalRows.build(items: [answer("a0"), answer("a1")])
    #expect(answersOnly.promptRows.isEmpty)
    #expect(
      StickyPrompt.resolve(
        promptRows: answersOnly.promptRows, rows: answersOnly, book: book(answersOnly),
        top: 999, line: metrics.line) == nil)
  }

  @Test("a long transcript resolves by binary search, not by walking")
  func scalesToALongTranscript() {
    let rows = transcript(turns: 4_000)
    let heights = book(rows)
    let prompts = rows.promptRows
    #expect(prompts.count == 4_000)
    let last = prompts[prompts.count - 1]
    let pin = StickyPrompt.resolve(
      promptRows: prompts, rows: rows, book: heights, top: heights.totalHeight,
      line: metrics.line)
    #expect(pin?.row == last)
  }
}
