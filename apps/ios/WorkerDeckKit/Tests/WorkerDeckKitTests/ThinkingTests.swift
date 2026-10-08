import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Thinking")
struct ThinkingTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)

  private func decodeBlock(_ json: String) throws -> ContentBlock {
    try JSONDecoder().decode(ContentBlock.self, from: Data(json.utf8))
  }

  @Test("an addressed thinking block decodes as a reply, a plain one stays thinking")
  func addressedDecodesAsText() throws {
    #expect(try decodeBlock(#"{"type":"thinking","thinking":"Two decisions from you.\n\n","addressed":true}"#) == .text("Two decisions from you."))
    #expect(try decodeBlock(#"{"type":"thinking","thinking":"reasoning"}"#) == .thinking("reasoning"))
    #expect(try decodeBlock(#"{"type":"thinking","thinking":" ","addressed":true}"#) == .thinking(" "))
  }

  @Test("a thought is one line until pressed, then the whole of it")
  func foldsToOneLine() {
    let item = TranscriptItem.thinking(id: "a1-0", text: "First line.\nSecond line.\n\n", parentToolUseId: nil)
    let row = TerminalRows.build(items: [item])[0]
    let collapsed = TerminalPlanner.plan(row, metrics: metrics, expansion: TerminalExpansion())
    #expect(collapsed.count == 1)
    #expect(collapsed[0].text == "First line.")
    #expect(collapsed[0].press == .toggle(.thinking("a1-0")))
    let open = TerminalPlanner.plan(row, metrics: metrics, expansion: TerminalExpansion(open: [.thinking("a1-0")]))
    #expect(open.map(\.text) == ["First line.", "Second line."])
  }

  @Test("a one-line thought carries no press")
  func shortThoughtHasNoPress() {
    let row = TerminalRows.build(items: [.thinking(id: "a1-0", text: "Short.\n\n", parentToolUseId: nil)])[0]
    let lines = TerminalPlanner.plan(row, metrics: metrics, expansion: TerminalExpansion())
    #expect(lines.count == 1)
    #expect(lines[0].press == nil)
  }

  @Test("hiding thinking drops its rows and keeps everything else")
  func hidesThinkingRows() {
    let items: [TranscriptItem] = [
      .thinking(id: "a1-0", text: "reasoning", parentToolUseId: nil),
      .assistantText(id: "a2-0", text: "Done.", streaming: false, parentToolUseId: nil),
    ]
    #expect(TerminalRows.build(items: items).count == 2)
    #expect(TerminalRows.build(items: items, hideThinking: true).count == 1)
  }
}
