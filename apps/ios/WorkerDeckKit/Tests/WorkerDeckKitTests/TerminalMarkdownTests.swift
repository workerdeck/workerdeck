import Foundation
import Testing

@testable import WorkerDeckKit

/// Inline markdown, where the measurer and the renderer have to agree.
///
/// The web client strips inline syntax with a regex chain so that `**bold**` is
/// measured as the four characters the browser draws. We instead render once and
/// measure the result, which removes the class of bug entirely — but only if the
/// styled run and the plain string really are the same characters at the same
/// offsets. That is what this suite pins down.
@Suite("TerminalMarkdown")
struct TerminalMarkdownTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 22, fontSize: 13)

  @Test("a row is measured as what it draws, not as its source")
  func measuredAsRendered() {
    // Four characters, not eight: `**bold**` is never drawn.
    #expect(MarkdownInline.plain("a **bold** word") == "a bold word")
    #expect(MarkdownInline.plain("`code` here") == "code here")
    #expect(MarkdownInline.plain("[text](http://x)") == "text")
    #expect(MarkdownInline.plain("![alt](http://x)") == "alt")
  }

  @Test("newlines survive inline parsing")
  func newlinesSurvive() {
    // `.inlineOnlyPreservingWhitespace` rather than full parsing: the full mode
    // collapses whitespace, which a monospace grid cannot afford, and a hard
    // line break inside a prose block is a line the reader put there.
    #expect(MarkdownInline.plain("alpha\nbeta") == "alpha\nbeta")
    #expect(TerminalCells.textLines(MarkdownInline.plain("alpha\nbeta"), cols: 80).lines == 2)
  }

  @Test("every styled slice holds exactly its line's characters")
  func slicesStayInStep() {
    // If these ever drift, a bolded word lands on the wrong line — silently, and
    // only for text that wraps.
    let source = "the **quick** brown fox jumps over the lazy dog and then some more"
    let lines = TerminalPlanner.inlineBody(source, metrics: metrics, tone: .fg)
    #expect(lines.count > 1)
    for line in lines {
      guard let attributed = line.attributed else {
        Issue.record("a styled line lost its run")
        return
      }
      #expect(String(attributed.characters) == line.text)
    }
  }

  @Test("wrapping a styled block loses no words")
  func nothingIsDropped() {
    let source = "alpha **beta** gamma delta epsilon zeta eta theta iota kappa lambda"
    let drawn = TerminalPlanner.inlineBody(source, metrics: metrics, tone: .fg)
      .map(\.text).joined(separator: " ")
    for word in ["alpha", "beta", "gamma", "kappa", "lambda"] {
      #expect(drawn.contains(word), "lost \(word)")
    }
  }

  @Test("a nested list item is indented by its ancestors' gutters")
  func listIndentIsCumulative() {
    // `1. ` is three cells and `- ` is two, so a bullet under an ordered item
    // starts one cell further in than one under a bullet. Depth times a constant
    // gets this wrong for every mixed list.
    let items = [
      MarkdownListItem(depth: 0, ordinal: 1, text: "first"),
      MarkdownListItem(depth: 1, ordinal: nil, text: "nested under an ordered item"),
    ]
    let lines = TerminalPlanner.planList(items, metrics: metrics, nested: false)
    #expect(lines[0].indent == 0)
    #expect(lines[0].columns == 3)
    #expect(lines[1].indent == 3)
    #expect(lines[1].columns == 2)
  }

  @Test("markdown blocks are separated by one blank line")
  func blocksAreSeparatedByALine() {
    let plan = TerminalPlanner.planMarkdown(
      "first paragraph\n\nsecond paragraph", metrics: metrics, gutter: TermGlyph.bullet,
      gutterTone: .fg, nested: false)
    // Whatever each paragraph wraps to, exactly one empty line sits between them.
    #expect(plan.filter { $0.text.isEmpty }.count == 1)
    #expect(plan.first?.gutter == TermGlyph.bullet)
  }
}
