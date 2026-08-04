import Testing

@testable import WorkerDeckKit

@Suite("MarkdownBlocks")
struct MarkdownBlocksTests {
  @Test func returnsPlainTextAsASingleProseBlock() {
    #expect(MarkdownBlocks.parse("Just **text**.") == [.prose("Just **text**.")])
  }

  @Test func splitsAFencedBlockOutOfSurroundingProse() {
    let blocks = MarkdownBlocks.parse(
      """
      Here you go:

      ```swift
      let x = 1
      ```

      Done.
      """)
    #expect(
      blocks == [
        .prose("Here you go:"),
        .code(language: "swift", text: "let x = 1", isClosed: true),
        .prose("Done."),
      ])
  }

  @Test func keepsBlankLinesInsideBlocks() {
    let blocks = MarkdownBlocks.parse(
      """
      ```
      a

      b
      ```
      """)
    #expect(blocks == [.code(language: nil, text: "a\n\nb", isClosed: true)])
  }

  @Test func emitsAnUnterminatedFenceAsStillStreamingCode() {
    let blocks = MarkdownBlocks.parse(
      """
      Writing it now:

      ```ts
      const a = 1
      """)
    #expect(
      blocks == [
        .prose("Writing it now:"),
        .code(language: "ts", text: "const a = 1", isClosed: false),
      ])
  }

  @Test func treatsAJustOpenedFenceAsAnEmptyCodeBlock() {
    #expect(MarkdownBlocks.parse("```") == [.code(language: nil, text: "", isClosed: false)])
  }

  @Test func lowercasesTheLanguageAndIgnoresTheRestOfTheInfoString() {
    let blocks = MarkdownBlocks.parse("```Swift title=foo.swift\nx\n```")
    #expect(blocks == [.code(language: "swift", text: "x", isClosed: true)])
  }

  @Test func doesNotCloseOnAShorterFenceRun() {
    let blocks = MarkdownBlocks.parse("````\n```\nnested\n````")
    #expect(blocks == [.code(language: nil, text: "```\nnested", isClosed: true)])
  }

  @Test func supportsTildeFences() {
    let blocks = MarkdownBlocks.parse("~~~py\nx = 1\n~~~")
    #expect(blocks == [.code(language: "py", text: "x = 1", isClosed: true)])
  }

  @Test func ignoresAnInlineCodeSpanThatLooksLikeAFence() {
    // A backtick fence's info string may not contain a backtick, so this is one
    // prose line with two code spans, not an opening fence.
    #expect(MarkdownBlocks.parse("```a``` and more") == [.prose("```a``` and more")])
  }

  @Test func requiresAtLeastThreeMarkers() {
    #expect(MarkdownBlocks.parse("``x``") == [.prose("``x``")])
  }

  @Test func stripsTheFencesOwnIndentationFromItsContent() {
    let blocks = MarkdownBlocks.parse("  ```\n  a\n      b\n  ```")
    #expect(blocks == [.code(language: nil, text: "a\n    b", isClosed: true)])
  }

  @Test func doesNotTreatAFourSpaceIndentedLineAsAFence() {
    let blocks = MarkdownBlocks.parse("    ```\n    a")
    #expect(blocks == [.prose("    ```\n    a")])
  }

  @Test func dropsTheBlankSeparatorLinesAroundAFence() {
    let blocks = MarkdownBlocks.parse("intro\n\n\n```\nx\n```\n\n")
    #expect(blocks == [.prose("intro"), .code(language: nil, text: "x", isClosed: true)])
  }

  @Test func handlesCarriageReturns() {
    let blocks = MarkdownBlocks.parse("a\r\n```\r\nx\r\n```\r\n")
    #expect(blocks == [.prose("a"), .code(language: nil, text: "x", isClosed: true)])
  }

  @Test func returnsNothingForEmptyText() {
    #expect(MarkdownBlocks.parse("").isEmpty)
    #expect(MarkdownBlocks.parse("\n \n").isEmpty)
  }
}
