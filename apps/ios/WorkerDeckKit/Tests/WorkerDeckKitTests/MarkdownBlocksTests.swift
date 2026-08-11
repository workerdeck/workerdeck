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

  // MARK: - Headings

  @Test func parsesAtxHeadingsAtEveryLevel() {
    for level in 1...6 {
      let hashes = String(repeating: "#", count: level)
      #expect(MarkdownBlocks.parse("\(hashes) Title") == [.heading(level: level, text: "Title")])
    }
  }

  @Test func sevenHashesIsProse() {
    // CommonMark stops at six; past that the hashes are the content.
    #expect(MarkdownBlocks.parse("####### deep") == [.prose("####### deep")])
  }

  @Test func requiresASpaceAfterTheHashes() {
    // `#hashtag` and `#42` are prose someone typed, not headings — a model
    // writing a heading never omits the space.
    #expect(MarkdownBlocks.parse("#hashtag") == [.prose("#hashtag")])
    #expect(MarkdownBlocks.parse("Fixes #42") == [.prose("Fixes #42")])
  }

  @Test func treatsBareHashesAsAHeadingStillArriving() {
    // The streaming frontier: the hashes land before the title. An empty
    // heading renders as nothing and fills in — never as literal `##` that
    // snaps into a heading a token later. The level may still deepen (`#` →
    // `##`), but the block never changes kind.
    #expect(MarkdownBlocks.parse("#") == [.heading(level: 1, text: "")])
    #expect(MarkdownBlocks.parse("##") == [.heading(level: 2, text: "")])
    #expect(MarkdownBlocks.parse("## R") == [.heading(level: 2, text: "R")])
  }

  @Test func stripsAClosingHashRunButNotAHashTheTitleEndsWith() {
    #expect(MarkdownBlocks.parse("## Title ##") == [.heading(level: 2, text: "Title")])
    // The closing run must be preceded by a space — `C#` is the title.
    #expect(MarkdownBlocks.parse("# C#") == [.heading(level: 1, text: "C#")])
  }

  @Test func allowsUpToThreeSpacesOfHeadingIndentLikeAFence() {
    #expect(MarkdownBlocks.parse("   # ok") == [.heading(level: 1, text: "ok")])
    #expect(MarkdownBlocks.parse("    # not") == [.prose("    # not")])
  }

  @Test func aHeadingSplitsTheSurroundingProse() {
    let blocks = MarkdownBlocks.parse("intro\n## Next\noutro")
    #expect(blocks == [.prose("intro"), .heading(level: 2, text: "Next"), .prose("outro")])
  }

  // MARK: - Thematic breaks

  @Test func parsesThematicBreaks() {
    for line in ["---", "***", "___", "- - -", "----------", "  ---"] {
      #expect(MarkdownBlocks.parse(line) == [.thematicBreak], "line: \(line)")
    }
  }

  @Test func twoDashesStayProse() {
    // The one deliberate streaming flicker: `--` is prose until the third dash
    // arrives, because guessing a rule from two would misread `--flag`. A rule
    // is a one-line block, so the flicker lasts exactly one token.
    #expect(MarkdownBlocks.parse("--") == [.prose("--")])
    #expect(MarkdownBlocks.parse("--verbose") == [.prose("--verbose")])
  }

  @Test func mixedMarkersAreNotABreak() {
    #expect(MarkdownBlocks.parse("-*-") == [.prose("-*-")])
  }

  @Test func aRuleAfterAParagraphIsARuleNotASetextHeading() {
    // CommonMark would read this as a setext h2 — a paragraph that snaps into
    // a huge heading one full line later, the worst possible streaming shape.
    // Models write ATX headings and use `---` as a separator, so the separator
    // reading wins.
    let blocks = MarkdownBlocks.parse("Title\n---")
    #expect(blocks == [.prose("Title"), .thematicBreak])
  }

  @Test func aBreakBeatsAListItem() {
    // `- - -` could be a bullet holding `- -`; CommonMark gives the break
    // precedence and so do we.
    #expect(MarkdownBlocks.parse("- a\n- - -\n- b") == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "a")]),
      .thematicBreak,
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "b")]),
    ])
  }

  @Test func anEmphasisLineStaysProse() {
    // `**Note:**` shares its first characters with a `*` bullet and a `***`
    // rule; neither may claim it.
    #expect(MarkdownBlocks.parse("**Note:** careful") == [.prose("**Note:** careful")])
    #expect(MarkdownBlocks.parse("*emphasis*") == [.prose("*emphasis*")])
  }

  // MARK: - Lists

  @Test func parsesUnorderedItemsWithAnyMarkerIntoOneList() {
    // One block even when the marker character changes: each item renders its
    // own marker, so a block break would only add a gap nobody asked for.
    let blocks = MarkdownBlocks.parse("- a\n* b\n+ c")
    #expect(blocks == [
      .list(items: [
        MarkdownListItem(depth: 0, ordinal: nil, text: "a"),
        MarkdownListItem(depth: 0, ordinal: nil, text: "b"),
        MarkdownListItem(depth: 0, ordinal: nil, text: "c"),
      ])
    ])
  }

  @Test func keepsTheSourceOrdinals() {
    // Renumbering would repair mistakes nobody made — models number correctly,
    // and when one starts a list at 3 it means 3.
    let blocks = MarkdownBlocks.parse("1. a\n2. b\n7. c")
    #expect(blocks == [
      .list(items: [
        MarkdownListItem(depth: 0, ordinal: 1, text: "a"),
        MarkdownListItem(depth: 0, ordinal: 2, text: "b"),
        MarkdownListItem(depth: 0, ordinal: 7, text: "c"),
      ])
    ])
  }

  @Test func acceptsTheParenOrderedDelimiter() {
    #expect(MarkdownBlocks.parse("1) a") == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: 1, text: "a")])
    ])
  }

  @Test func readsIndentationAsNestingWhateverTheUnit() {
    // Depth is a level rank, not indent-divided-by-two: models indent by two,
    // three or four spaces depending on the parent marker's width, and all of
    // them mean "one level in".
    let two = MarkdownBlocks.parse("- a\n  - b\n    - c")
    #expect(two == [
      .list(items: [
        MarkdownListItem(depth: 0, ordinal: nil, text: "a"),
        MarkdownListItem(depth: 1, ordinal: nil, text: "b"),
        MarkdownListItem(depth: 2, ordinal: nil, text: "c"),
      ])
    ])
    let four = MarkdownBlocks.parse("- a\n    - b")
    #expect(four == [
      .list(items: [
        MarkdownListItem(depth: 0, ordinal: nil, text: "a"),
        MarkdownListItem(depth: 1, ordinal: nil, text: "b"),
      ])
    ])
    // An ordered parent's content column is three characters in.
    let ordered = MarkdownBlocks.parse("1. a\n   - b\n1. c")
    #expect(ordered == [
      .list(items: [
        MarkdownListItem(depth: 0, ordinal: 1, text: "a"),
        MarkdownListItem(depth: 1, ordinal: nil, text: "b"),
        MarkdownListItem(depth: 0, ordinal: 1, text: "c"),
      ])
    ])
  }

  @Test func treatsABareDashAsABulletStillArriving() {
    // The streaming frontier again: a lone `-` is a bullet about to get its
    // text. Rendering it as prose and snapping to a bullet on the next token
    // is exactly the flicker the parser exists to avoid.
    #expect(MarkdownBlocks.parse("-") == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "")])
    ])
    #expect(MarkdownBlocks.parse("- done\n-") == [
      .list(items: [
        MarkdownListItem(depth: 0, ordinal: nil, text: "done"),
        MarkdownListItem(depth: 0, ordinal: nil, text: ""),
      ])
    ])
    // Same for an ordered marker — `1.` alone is an empty item, and its empty
    // render happens to be the literal characters anyway.
    #expect(MarkdownBlocks.parse("1.") == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: 1, text: "")])
    ])
  }

  @Test func requiresASpaceAfterTheMarker() {
    // `-item` is a typo or a flag, `1.5` is a number. The space is the whole
    // distinction between a marker and a word that starts with one.
    #expect(MarkdownBlocks.parse("-item") == [.prose("-item")])
    #expect(MarkdownBlocks.parse("1.5 miles left") == [.prose("1.5 miles left")])
  }

  @Test func capsOrdinalsAtNineDigits() {
    // CommonMark's own limit, and what keeps the Int conversion total.
    #expect(MarkdownBlocks.parse("1234567890. x") == [.prose("1234567890. x")])
  }

  @Test func unmarkedLinesContinueTheOpenItem() {
    // CommonMark's lazy continuation: a wrapped or unmarked line after an item
    // is more of that item, indented or not.
    let blocks = MarkdownBlocks.parse("- first line\n  wrapped\nlazy")
    #expect(blocks == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "first line\nwrapped\nlazy")])
    ])
  }

  @Test func aBlockMarkerInterruptsAListInsteadOfContinuingIt() {
    // Continuation only swallows plain text — a heading after a list is a
    // heading, exactly as it would be after a paragraph.
    let blocks = MarkdownBlocks.parse("- a\n# Next")
    #expect(blocks == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "a")]),
      .heading(level: 1, text: "Next"),
    ])
  }

  @Test func aBlankLineEndsTheListBlock() {
    // A "loose" list becomes two blocks. The render is the same picture — the
    // block gap stands in for the blank line — and it keeps the parser free of
    // lookahead, which is what streaming needs.
    let blocks = MarkdownBlocks.parse("- a\n\n- b")
    #expect(blocks == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "a")]),
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "b")]),
    ])
  }

  @Test func aFenceInterruptsAList() {
    // The fence outranks the list it sits in: nesting blocks inside items is
    // not modelled, so the code block stands alone and the next marker starts
    // a fresh list.
    let blocks = MarkdownBlocks.parse("- a\n```\ncode\n```\n- b")
    #expect(blocks == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "a")]),
      .code(language: nil, text: "code", isClosed: true),
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "b")]),
    ])
  }

  @Test func aParagraphAfterABlankLineLeavesTheList() {
    let blocks = MarkdownBlocks.parse("- a\n\nafterword")
    #expect(blocks == [
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "a")]),
      .prose("afterword"),
    ])
  }

  @Test func handlesCarriageReturnsInLists() {
    let blocks = MarkdownBlocks.parse("- a\r\n- b\r\n")
    #expect(blocks == [
      .list(items: [
        MarkdownListItem(depth: 0, ordinal: nil, text: "a"),
        MarkdownListItem(depth: 0, ordinal: nil, text: "b"),
      ])
    ])
  }

  // MARK: - Blockquotes

  @Test func parsesABlockquote() {
    #expect(MarkdownBlocks.parse("> quoted") == [.blockquote("quoted")])
    #expect(MarkdownBlocks.parse("> a\n> b") == [.blockquote("a\nb")])
  }

  @Test func allowsTheSpacelessQuoteMarker() {
    // CommonMark makes the space optional, and models occasionally skip it.
    #expect(MarkdownBlocks.parse(">tight") == [.blockquote("tight")])
  }

  @Test func treatsABareAngleAsAQuoteStillArriving() {
    // Same shape-first rule as the just-opened fence: the bar renders
    // immediately and the text fills in.
    #expect(MarkdownBlocks.parse(">") == [.blockquote("")])
  }

  @Test func flattensNestedQuotes() {
    // A second bar of indentation says nothing more on a phone-width line, so
    // the inner markers are stripped rather than modelled.
    #expect(MarkdownBlocks.parse("> > deep") == [.blockquote("deep")])
  }

  @Test func keepsBlankQuoteLinesInside() {
    // `>` on its own line is a paragraph break inside the quote, not the end
    // of it.
    #expect(MarkdownBlocks.parse("> a\n>\n> b") == [.blockquote("a\n\nb")])
  }

  @Test func aPlainLineEndsTheQuote() {
    // No lazy continuation into quotes — deliberately not CommonMark, where a
    // quote silently swallows the paragraph under it. Models prefix every
    // quoted line, and the predictable reading wins.
    let blocks = MarkdownBlocks.parse("> q\nplain")
    #expect(blocks == [.blockquote("q"), .prose("plain")])
  }

  @Test func aQuoteAndAListSeparateCleanly() {
    let blocks = MarkdownBlocks.parse("> q\n- item")
    #expect(blocks == [
      .blockquote("q"),
      .list(items: [MarkdownListItem(depth: 0, ordinal: nil, text: "item")]),
    ])
  }

  // MARK: - Prose is the fallback, never a failure

  @Test func keepsAMultiParagraphAnswerAsOneProseBlock() {
    // The shipped behavior: blank lines inside prose are content, not block
    // separators. Splitting paragraphs into blocks would change the spacing
    // of every plain answer for no rendering gain.
    #expect(MarkdownBlocks.parse("one\n\ntwo") == [.prose("one\n\ntwo")])
  }

  @Test func rendersTablesAsLiteralProse() {
    // Deliberate: a faithful column renderer is disproportionate on a phone,
    // and a half-rendered table (pipes stripped, alignment gone) reads worse
    // than the literal one. Every pipe must survive.
    let table = "| a | b |\n|---|---|\n| 1 | 2 |"
    #expect(MarkdownBlocks.parse(table) == [.prose(table)])
  }

  @Test func setextUnderlinesDoNotEatTheirParagraph() {
    // `===` is nothing to this parser; the paragraph above it must survive
    // untouched.
    #expect(MarkdownBlocks.parse("Title\n===") == [.prose("Title\n===")])
  }

  // MARK: - Streaming

  @Test func everyPrefixKeepsTheLatestCharacterOnScreen() {
    // The streaming guarantee, stated as an invariant rather than a case list:
    // cut the document anywhere, and the character just typed is in the parse
    // — in the last block's text (or, on a fence line, its info string). A
    // failure here is the exact bug this parser exists to prevent: a delta
    // that makes text vanish until more of it arrives.
    let doc = """
      ## Plan

      - step one
        - nested two

      > a quote

      ```swift
      let x = 1
      ```

      1. first
      2. second

      Done.
      """
    for end in doc.indices {
      let prefix = String(doc[...end])
      guard let last = prefix.last, last.isLetter || last.isNumber else { continue }
      let tails = MarkdownBlocks.parse(prefix).last.map(visibleTails) ?? []
      #expect(
        tails.contains { $0.last == last },
        "lost \(String(last).debugDescription) at end of \(prefix.debugDescription)")
    }
  }

  /// Where a block's most recently streamed character can legitimately be.
  private func visibleTails(_ block: MarkdownBlock) -> [String] {
    switch block {
    case .prose(let text), .blockquote(let text): return [text]
    case .heading(_, let text): return [text]
    case .list(let items): return [items.last?.text ?? ""]
    case .code(let language, let text, _): return [text, language ?? ""]
    case .thematicBreak: return []
    }
  }
}
