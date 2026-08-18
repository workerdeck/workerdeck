import Foundation

/// How wide a string is in character cells, and where it wraps — the half of
/// `packages/ui/src/components/terminal/height.ts` that knows about text.
///
/// The terminal theme's premise is one cell and one line height, so a row's
/// height is derivable from its string with no layout pass at all. That is only
/// honest if this file agrees with what the renderer draws — which on iOS it
/// does **by construction**: the renderer draws the lines this file returns,
/// rather than handing the string to the text system and hoping it wraps the
/// same way. See ``wrapped(_:cols:)``.

/// A width in cells, plus whether we can be sure of it.
///
/// `exact == false` is the honesty flag, not a failure: emoji and CJK render
/// from fallback faces whose advance is not a whole cell, so a row containing
/// them may need a real measurement once it mounts.
public struct CellWidth: Equatable, Sendable {
  public var cells: Int
  public var exact: Bool
}

public enum TerminalCells {
  /// The surface sets `tab-size: 2`; a tab advances to the next 2-cell stop.
  public static let tabSize = 2

  /// Break *after* these when the next character is not a digit — which keeps
  /// `protocol-0.16.0` together while still breaking a long hyphenated phrase.
  /// `?` is included because it is where real browsers break long URLs.
  private static let breakAfter: Set<Character> = ["-", "–", "—", "?"]

  /// East Asian Wide / Fullwidth blocks, inclusive.
  private static let wideRanges: [ClosedRange<UInt32>] = [
    0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF,
    0x4E00...0x9FFF, 0xA000...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF,
    0xFE30...0xFE4F, 0xFF00...0xFF60, 0xFFE0...0xFFE6, 0x20000...0x3FFFD,
  ]

  /// How many cells one grapheme cluster occupies.
  public static func clusterCells(_ cluster: Character) -> CellWidth {
    var sawJoiner = false
    for scalar in cluster.unicodeScalars where scalar.value == 0x200D || scalar.value == 0xFE0F {
      sawJoiner = true
      break
    }
    if sawJoiner { return CellWidth(cells: 2, exact: false) }
    guard let first = cluster.unicodeScalars.first else { return CellWidth(cells: 0, exact: true) }
    if first.properties.isEmojiPresentation { return CellWidth(cells: 2, exact: false) }
    if wideRanges.contains(where: { $0.contains(first.value) }) {
      return CellWidth(cells: 2, exact: false)
    }
    if first.value < 0x20 { return CellWidth(cells: 0, exact: true) }
    return CellWidth(cells: 1, exact: true)
  }

  // MARK: - Tokenising

  private enum TokenKind { case word, space }
  private struct Token {
    var kind: TokenKind
    var width: Int
    var exact: Bool
    var text: Substring
  }

  private static func isPlainASCII(_ line: String) -> Bool {
    for scalar in line.unicodeScalars where scalar.value < 0x20 || scalar.value > 0x7e {
      return false
    }
    return true
  }

  /// Split a hard line into word and space tokens.
  ///
  /// Consecutive spaces coalesce into one token; each wide or pictographic
  /// cluster is its **own** word token, because a break may fall between any two
  /// of them. The ASCII fast path is not a different rule — it is the same rule
  /// without the grapheme walk, which measured as a full second of a thirty-
  /// second scroll sweep over a four-thousand-item transcript.
  private static func tokenize(_ line: String, startColumn: Int) -> [Token] {
    var tokens: [Token] = []
    let ascii = isPlainASCII(line)
    var column = startColumn

    var index = line.startIndex
    var wordStart = index
    var wordWidth = 0
    var wordExact = true

    func flushWord() {
      guard wordWidth > 0 || wordStart < index else { return }
      if wordStart < index {
        tokens.append(Token(kind: .word, width: wordWidth, exact: wordExact, text: line[wordStart..<index]))
      }
      wordWidth = 0
      wordExact = true
    }

    while index < line.endIndex {
      let character = line[index]
      let next = line.index(after: index)

      if character == " " || character == "\t" {
        flushWord()
        var width = 0
        var cursor = index
        while cursor < line.endIndex, line[cursor] == " " || line[cursor] == "\t" {
          if line[cursor] == "\t" {
            let stop = ((column + width) / tabSize + 1) * tabSize
            width += stop - (column + width)
          } else {
            width += 1
          }
          cursor = line.index(after: cursor)
        }
        tokens.append(Token(kind: .space, width: width, exact: true, text: line[index..<cursor]))
        column += width
        index = cursor
        wordStart = index
        continue
      }

      let size = ascii ? CellWidth(cells: 1, exact: true) : clusterCells(character)
      if size.cells > 1 {
        // A wide cluster is its own token: a break may fall on either side.
        flushWord()
        tokens.append(Token(kind: .word, width: size.cells, exact: size.exact, text: line[index..<next]))
        column += size.cells
        index = next
        wordStart = index
        continue
      }

      wordWidth += size.cells
      wordExact = wordExact && size.exact
      column += size.cells

      // Break *after* a dash or question mark, unless a digit follows.
      if breakAfter.contains(character) {
        let followsDigit = next < line.endIndex && line[next].isNumber
        if !followsDigit {
          let boundary = next
          tokens.append(
            Token(kind: .word, width: wordWidth, exact: wordExact, text: line[wordStart..<boundary]))
          wordWidth = 0
          wordExact = true
          index = next
          wordStart = index
          continue
        }
      }
      index = next
    }
    flushWord()
    return tokens
  }

  // MARK: - Wrapping

  /// Where one hard line breaks, as offsets into it, plus how many rendered
  /// lines that is.
  ///
  /// Preserved spaces **hang** at the end of a line rather than forcing a wrap
  /// (CSS Text 3, and what every terminal does). A word wider than the column
  /// first moves to its own line and only then fills whole lines.
  public static func wrap(_ line: String, cols: Int) -> (lines: [Substring], exact: Bool) {
    guard cols > 0 else { return ([line[...]], false) }
    let tokens = tokenize(line, startColumn: 0)
    guard !tokens.isEmpty else { return ([line[...]], true) }

    var out: [Substring] = []
    var exact = true
    var lineStart = line.startIndex
    var position = 0

    for token in tokens {
      exact = exact && token.exact
      if token.kind == .space {
        position += token.width
        continue
      }
      if position + token.width <= cols {
        position += token.width
        continue
      }
      if token.width <= cols {
        out.append(line[lineStart..<token.text.startIndex])
        lineStart = token.text.startIndex
        position = token.width
        continue
      }
      // break-word: the token moves to its own line, then fills whole lines.
      if position > 0 {
        out.append(line[lineStart..<token.text.startIndex])
        lineStart = token.text.startIndex
      }
      var cursor = token.text.startIndex
      var filled = 0
      var carried = 0
      while cursor < token.text.endIndex {
        let size = isPlainASCII(String(token.text)) ? 1 : clusterCells(token.text[cursor]).cells
        if carried + size > cols {
          out.append(line[lineStart..<cursor])
          lineStart = cursor
          carried = 0
          filled += 1
        }
        carried += size
        cursor = token.text.index(after: cursor)
      }
      _ = filled
      position = carried
    }
    out.append(line[lineStart...])
    return (out, exact)
  }

  /// How many rendered lines one hard line becomes.
  public static func wrapOne(_ line: String, cols: Int) -> (lines: Int, exact: Bool) {
    guard cols > 0 else { return (1, false) }
    let result = wrap(line, cols: cols)
    return (max(1, result.lines.count), result.exact)
  }

  /// How many rendered lines a whole string becomes, newlines included.
  public static func textLines(_ text: String, cols: Int) -> (lines: Int, exact: Bool) {
    var total = 0
    var exact = true
    for hard in text.components(separatedBy: "\n") {
      let result = wrapOne(hard, cols: cols)
      total += max(1, result.lines)
      exact = exact && result.exact
    }
    return (max(1, total), exact)
  }

  /// The rendered lines themselves — what the row **draws**.
  ///
  /// This is the iOS port's one real divergence from the web client, and it is a
  /// simplification rather than a compromise. On the web the browser wraps and
  /// `height.ts` predicts; here the calculator wraps and the renderer draws the
  /// result, so a row's height cannot disagree with its content. It also costs
  /// nothing extra: the wrap was computed to measure the row in the first place.
  public static func wrapped(_ text: String, cols: Int) -> [String] {
    text.components(separatedBy: "\n").flatMap { hard -> [String] in
      let result = wrap(hard, cols: cols)
      return result.lines.isEmpty ? [""] : result.lines.map(String.init)
    }
  }
}
