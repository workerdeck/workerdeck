import Foundation

/// One top-level block of assistant text.
///
/// The split models what a phone transcript renders differently: fenced code,
/// headings, lists, blockquotes, thematic breaks. Everything else stays `prose`
/// and is rendered with inline markdown (bold/italic/code spans/links)
/// preserving whitespace — prose is the fallback, never a failure, so a
/// construct this parser doesn't model degrades to exactly what the app
/// shipped with rather than to lost text. Tables are deliberately in that
/// bucket: a faithful column renderer is disproportionate here, and a
/// half-rendered table (pipes stripped, columns gone) reads worse than the
/// literal one.
public enum MarkdownBlock: Equatable, Sendable {
  case prose(String)
  /// An ATX heading. `text` is the bare title — inline markdown inside it is
  /// the renderer's job. Setext headings (`Title` over `---`) are deliberately
  /// not modelled: under streaming a finished paragraph would snap into a
  /// heading a full line later, and models write ATX.
  case heading(level: Int, text: String)
  /// A run of list items, ordered and unordered alike — each item carries its
  /// own marker, so a marker change mid-list doesn't need a block break.
  case list(items: [MarkdownListItem])
  /// A quote, flattened to one level: nested `>` markers are stripped rather
  /// than modelled, because a second bar of indentation says nothing more on a
  /// phone-width line.
  case blockquote(String)
  case thematicBreak
  /// A fenced block. `isClosed` is false while the closing fence hasn't arrived,
  /// which during streaming is the common case — the block still renders.
  case code(language: String?, text: String, isClosed: Bool)
}

/// One list item. `ordinal` is the source's own number (models number
/// correctly; renumbering would repair mistakes nobody made) and nil for a
/// bullet. `depth` counts nesting levels inferred from indentation.
public struct MarkdownListItem: Equatable, Sendable {
  public let depth: Int
  public let ordinal: Int?
  public let text: String

  public init(depth: Int, ordinal: Int?, text: String) {
    self.depth = depth
    self.ordinal = ordinal
    self.text = text
  }
}

/// Block splitter for assistant text. Pure, so it lives here rather than in the
/// SwiftUI layer: this package is the only part of the app under test.
///
/// Streaming is the design constraint. Text arrives a token at a time, so every
/// block must render in its final shape from its first character: an open fence
/// is already code, a lone `-` is already a bullet, a lone `#` is already a
/// (still empty) heading. The classifier is line-based on purpose — a line's
/// kind is decided by its own leading characters, never by the line after it,
/// so a prefix of the document parses the same as the document does. The one
/// deliberate exception is `--` (prose until the third dash makes it a rule):
/// the alternative, guessing a rule from two dashes, would misread `--flag`.
public enum MarkdownBlocks {
  public static func parse(_ text: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var prose: [Substring] = []
    var code: [String] = []
    var fence: Fence?
    var items: [MarkdownListItem] = []
    var itemHead: (depth: Int, ordinal: Int?)?
    var itemLines: [Substring] = []
    // Marker indents of the open list's nesting levels, innermost last. Depth
    // is a level *rank*, not `indent / unit`: models indent by two, three or
    // four spaces depending on the parent marker's width, and any fixed unit
    // misreads two of the three. Decisions are per-line and left-to-right, so
    // every prefix of the text assigns the same depths the full text does.
    var listIndents: [Int] = []
    var quote: [Substring] = []
    var inQuote = false

    func flushProse() {
      let trimmed = trimBlankEdges(prose)
      prose.removeAll()
      guard !trimmed.isEmpty else { return }
      blocks.append(.prose(trimmed.joined(separator: "\n")))
    }

    func closeItem() {
      guard let head = itemHead else { return }
      itemHead = nil
      let lines = trimBlankEdges(itemLines)
      itemLines.removeAll()
      items.append(
        MarkdownListItem(depth: head.depth, ordinal: head.ordinal, text: lines.joined(separator: "\n")))
    }

    func flushList() {
      closeItem()
      listIndents.removeAll()
      guard !items.isEmpty else { return }
      blocks.append(.list(items: items))
      items.removeAll()
    }

    func flushQuote() {
      guard inQuote else { return }
      inQuote = false
      // A quote of nothing still renders (its bar is the shape the text will
      // fill in), matching how a just-opened fence is already a code block.
      blocks.append(.blockquote(trimBlankEdges(quote).joined(separator: "\n")))
      quote.removeAll()
    }

    // Only one of prose/list/quote is ever open, so order doesn't matter.
    func flushAll() {
      flushProse()
      flushList()
      flushQuote()
    }

    // `isNewline` rather than "\n": Swift treats CRLF as one Character, so
    // splitting on "\n" alone silently fails to split CRLF text at all.
    for line in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
      if let open = fence {
        if open.closes(line) {
          blocks.append(.code(language: open.language, text: code.joined(separator: "\n"), isClosed: true))
          code.removeAll()
          fence = nil
        } else {
          code.append(open.stripIndent(from: line))
        }
        continue
      }

      // The fence check outranks everything, as it always has — including a
      // fence indented inside a list item, which closes the list: nesting
      // blocks inside items isn't modelled, so the code block stands alone
      // and a following marker line starts a fresh list.
      if let open = Fence(opening: line) {
        flushAll()
        fence = open
        continue
      }

      switch classify(line) {
      case .blank:
        // A blank line ends a list or a quote but stays inside prose: a
        // multi-paragraph answer has always been one prose block with its
        // blank lines preserved, and splitting it would change spacing the
        // app shipped with. (A "loose" list becomes two list blocks, which
        // renders as the same gap the blank line asked for.)
        flushList()
        flushQuote()
        prose.append(line)
      case .thematicBreak:
        flushAll()
        blocks.append(.thematicBreak)
      case .heading(let level, let text):
        flushAll()
        blocks.append(.heading(level: level, text: text))
      case .listItem(let indent, let ordinal, let rest):
        flushProse()
        flushQuote()
        closeItem()
        // Two or more spaces past the current level nests; up to one space of
        // wobble is a sibling (and re-anchors the level, so consistent drift
        // doesn't compound); a dedent pops back to the level it matches.
        while let last = listIndents.last, indent <= last - 2 { listIndents.removeLast() }
        if let last = listIndents.last {
          if indent >= last + 2 {
            listIndents.append(indent)
          } else {
            listIndents[listIndents.count - 1] = indent
          }
        } else {
          listIndents = [indent]
        }
        itemHead = (listIndents.count - 1, ordinal)
        itemLines = [rest]
      case .quote(let content):
        flushProse()
        flushList()
        inQuote = true
        quote.append(content)
      case .text:
        if itemHead != nil {
          // Lazy continuation, as CommonMark has it: an unmarked line after a
          // list item is more of that item. Leading indentation is the item's
          // own alignment, not content.
          itemLines.append(line.drop(while: \.isWhitespace))
        } else {
          // No lazy continuation into quotes — only `>` lines belong. Models
          // prefix every quoted line, and the predictable reading beats the
          // CommonMark one where a quote silently swallows the paragraph
          // after it.
          flushQuote()
          prose.append(line)
        }
      }
    }

    if let open = fence {
      // Unterminated: the model is still typing, or stopped mid-block. Either
      // way the content is code — emit it rather than dropping it.
      blocks.append(.code(language: open.language, text: code.joined(separator: "\n"), isClosed: false))
    } else {
      flushAll()
    }

    return blocks
  }

  private enum LineKind {
    case blank
    case thematicBreak
    case heading(level: Int, text: String)
    /// `indent` is raw leading whitespace; the parse loop turns it into a
    /// nesting depth, because depth depends on the lines that came before.
    case listItem(indent: Int, ordinal: Int?, rest: Substring)
    case quote(content: Substring)
    case text
  }

  /// Decide a line's kind from its own characters. Order encodes precedence:
  /// a thematic break beats a list item (`- - -` is a rule, not a bullet
  /// holding `- -`), and everything requires its CommonMark ≤3-space indent
  /// except list markers, whose indentation *is* the nesting.
  private static func classify(_ line: Substring) -> LineKind {
    if line.allSatisfy(\.isWhitespace) { return .blank }

    // A tab counts as one nesting unit (two spaces): models indent nested
    // items with spaces, and a tab that does appear means "one level in".
    var indent = 0
    var rest = line[...]
    while let first = rest.first, first == " " || first == "\t" {
      indent += first == "\t" ? 2 : 1
      rest = rest.dropFirst()
    }

    // Thematic break: the whole line is three-plus of one marker plus spaces.
    // Checked before list markers so `- - -` and `***` don't read as items.
    if indent <= 3, let marker = rest.first, marker == "-" || marker == "*" || marker == "_" {
      var count = 0
      var onlyMarkers = true
      for char in rest {
        if char == marker {
          count += 1
        } else if char != " " && char != "\t" {
          onlyMarkers = false
          break
        }
      }
      if onlyMarkers, count >= 3 { return .thematicBreak }
    }

    if indent <= 3, rest.first == "#" {
      let hashes = rest.prefix(while: { $0 == "#" })
      let after = rest.dropFirst(hashes.count)
      // The space is load-bearing: `#hashtag` is prose, and a model writing a
      // heading never omits it. Seven hashes is prose too (CommonMark).
      if hashes.count <= 6, after.isEmpty || after.first == " " || after.first == "\t" {
        return .heading(level: hashes.count, text: headingText(after))
      }
    }

    if let marker = rest.first, marker == "-" || marker == "*" || marker == "+" {
      let after = rest.dropFirst()
      if after.isEmpty {
        // A bare `-` at the streaming frontier is a bullet about to get its
        // text — rendering it as prose first and snapping to a bullet on the
        // next token is the flicker this parser exists to avoid. (It is also
        // CommonMark's reading: an empty item.)
        return .listItem(indent: indent, ordinal: nil, rest: after)
      }
      if after.first == " " || after.first == "\t" {
        return .listItem(indent: indent, ordinal: nil, rest: after.drop(while: \.isWhitespace))
      }
    }

    if rest.first?.isASCIIDigit == true {
      let digits = rest.prefix(while: \.isASCIIDigit)
      // ≤9 digits (CommonMark's own cap) keeps `Int` conversion total.
      if digits.count <= 9 {
        let afterDigits = rest.dropFirst(digits.count)
        if let delim = afterDigits.first, delim == "." || delim == ")" {
          let after = afterDigits.dropFirst()
          if after.isEmpty {
            return .listItem(indent: indent, ordinal: Int(digits), rest: after)
          }
          // The space is what separates `1. step` from `1.5 miles`.
          if after.first == " " || after.first == "\t" {
            return .listItem(
              indent: indent, ordinal: Int(digits), rest: after.drop(while: \.isWhitespace))
          }
        }
      }
    }

    if indent <= 3, rest.first == ">" {
      var content = rest
      // Strip every immediately nested marker — `> > deep` flattens to `deep`.
      // Only one space per marker is eaten, so intentional indentation inside
      // a quote survives.
      while content.first == ">" {
        content = content.dropFirst()
        if content.first == " " { content = content.dropFirst() }
      }
      return .quote(content: content)
    }

    return .text
  }

  /// The title after the hashes: trimmed, with CommonMark's optional closing
  /// run stripped (`## Title ##` → `Title`) — but only when a space precedes
  /// it, so `# C#` keeps its sharp.
  private static func headingText(_ after: Substring) -> String {
    var text = after.trimmingCharacters(in: .whitespaces)
    let closing = text.reversed().prefix(while: { $0 == "#" }).count
    if closing > 0 {
      let head = text.dropLast(closing)
      if head.isEmpty || head.last == " " {
        text = head.trimmingCharacters(in: .whitespaces)
      }
    }
    return text
  }

  /// Drop blank lines at both ends of a run — the blank line that separated
  /// it from the neighbouring block is a separator, not content.
  private static func trimBlankEdges(_ lines: [Substring]) -> [Substring] {
    var slice = lines[...]
    while let first = slice.first, first.allSatisfy(\.isWhitespace) { slice = slice.dropFirst() }
    while let last = slice.last, last.allSatisfy(\.isWhitespace) { slice = slice.dropLast() }
    return Array(slice)
  }
}

extension Character {
  fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}

/// An open fence: which character, how long, how far indented, what language.
private struct Fence {
  let marker: Character
  let length: Int
  let indent: Int
  let language: String?

  /// CommonMark, minus the parts that never appear in model output: up to three
  /// leading spaces, three or more `` ` `` or `~`, and — for backtick fences —
  /// no backtick in the info string (that spelling is a code span, not a fence).
  init?(opening line: Substring) {
    var indent = 0
    var rest = line[...]
    while indent < 4, let first = rest.first, first == " " {
      indent += 1
      rest = rest.dropFirst()
    }
    guard indent < 4, let marker = rest.first, marker == "`" || marker == "~" else { return nil }

    let run = rest.prefix { $0 == marker }
    guard run.count >= 3 else { return nil }

    let info = rest.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
    guard marker != "`" || !info.contains("`") else { return nil }

    self.marker = marker
    self.length = run.count
    self.indent = indent
    // Only the language word matters; the rest of the info string (highlight
    // ranges, filenames) is metadata we don't render.
    self.language = info.split(separator: " ").first.map { String($0).lowercased() }
  }

  func closes(_ line: Substring) -> Bool {
    var rest = line[...]
    var seen = 0
    while seen < 4, let first = rest.first, first == " " {
      seen += 1
      rest = rest.dropFirst()
    }
    guard seen < 4 else { return false }
    let run = rest.prefix { $0 == marker }
    guard run.count >= length else { return false }
    return rest.dropFirst(run.count).allSatisfy(\.isWhitespace)
  }

  /// Content keeps its own indentation, minus the fence's — a fence indented two
  /// spaces inside a list item shouldn't push every line of code right.
  func stripIndent(from line: Substring) -> String {
    var dropped = 0
    var rest = line[...]
    while dropped < indent, let first = rest.first, first == " " {
      dropped += 1
      rest = rest.dropFirst()
    }
    return String(rest)
  }
}
