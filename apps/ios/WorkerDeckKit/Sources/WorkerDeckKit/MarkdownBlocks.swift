import Foundation

/// One top-level block of assistant text.
///
/// Only the fenced-code split is modelled. Everything else stays `prose` and is
/// rendered with inline markdown (bold/italic/code spans/links) preserving
/// whitespace, so headings and lists survive as literal text with their line
/// breaks — the same tradeoff the app shipped with, minus the one case where it
/// was actually wrong: a code block flattened into body text.
public enum MarkdownBlock: Equatable, Sendable {
  case prose(String)
  /// A fenced block. `isClosed` is false while the closing fence hasn't arrived,
  /// which during streaming is the common case — the block still renders.
  case code(language: String?, text: String, isClosed: Bool)
}

/// Block splitter for assistant text. Pure, so it lives here rather than in the
/// SwiftUI layer: this package is the only part of the app under test.
///
/// Streaming is the design constraint. Text arrives a token at a time, so a fence
/// that has opened but not closed must already render as code — waiting for the
/// terminator would make every code block appear as garbled prose first and then
/// snap into place.
public enum MarkdownBlocks {
  public static func parse(_ text: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var prose: [Substring] = []
    var code: [String] = []
    var fence: Fence?

    func flushProse() {
      let trimmed = trimBlankEdges(prose)
      prose.removeAll()
      guard !trimmed.isEmpty else { return }
      blocks.append(.prose(trimmed.joined(separator: "\n")))
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

      if let open = Fence(opening: line) {
        flushProse()
        fence = open
        continue
      }

      prose.append(line)
    }

    if let open = fence {
      // Unterminated: the model is still typing, or stopped mid-block. Either
      // way the content is code — emit it rather than dropping it.
      blocks.append(.code(language: open.language, text: code.joined(separator: "\n"), isClosed: false))
    } else {
      flushProse()
    }

    return blocks
  }

  /// Drop blank lines at both ends of a prose run — the blank line that separated
  /// it from a fence is a separator, not content.
  private static func trimBlankEdges(_ lines: [Substring]) -> [Substring] {
    var slice = lines[...]
    while let first = slice.first, first.allSatisfy(\.isWhitespace) { slice = slice.dropFirst() }
    while let last = slice.last, last.allSatisfy(\.isWhitespace) { slice = slice.dropLast() }
    return Array(slice)
  }
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
