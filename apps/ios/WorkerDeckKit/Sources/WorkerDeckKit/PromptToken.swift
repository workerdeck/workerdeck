import Foundation

/// The two prompt tokens the CLI understands — `@file` and `/command` — as one
/// set of rules, used by both halves of the app: the composer (which completes
/// them) and the transcript (which styles them once sent).
///
/// Pure string work, so it lives here rather than in the app: this package is the
/// part under test, and every interesting case is an edge — an `@` mid-word, a
/// token already terminated by a space, an email address, a slash that is really
/// an absolute path.
public struct PromptToken: Equatable, Sendable {
  public enum Kind: String, Equatable, Sendable {
    /// `@path` — valid anywhere a word starts.
    case file
    /// `/name` — also valid anywhere a word starts. The CLI runs a command only
    /// from the front of a message, but the picker is an editing aid: you reach
    /// for it mid-draft, and refusing to complete there just means typing the
    /// name out by hand.
    case command
  }

  public let kind: Kind
  /// Range in the text it was found in, prefix included.
  public let range: Range<String.Index>
  /// The token as written, prefix included (`@src/main.ts`, `/commit-message`).
  public let text: String

  /// The token without its prefix: the completion query, or the command name.
  public var query: String { String(text.dropFirst()) }

  public init(kind: Kind, range: Range<String.Index>, text: String) {
    self.kind = kind
    self.range = range
    self.text = text
  }
}

public enum PromptTokens {
  /// Characters a command name may contain after the slash. Deliberately excludes
  /// `/`, so an absolute path pasted at the start of a message (`/Users/me/…`) is
  /// not mistaken for a command; `:` is in because namespaced skills (`dev:wrapup`)
  /// are spelled that way.
  private static let commandCharacters = CharacterSet(
    charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:")

  /// Trailing punctuation that belongs to the sentence, not the token — so
  /// "see @README.md." styles the path and leaves the period alone. Applied only
  /// when *scanning* finished text; a draft being typed is left exactly as typed.
  private static let sentenceTail = CharacterSet(charactersIn: ".,;:!?)]}\"'")

  // MARK: - Finished text

  /// Every token in text that has already been sent — what the transcript styles.
  ///
  /// Stricter than ``active(in:at:)`` on purpose: a bare `@` is a token being
  /// typed, but in a sent message it is just an at sign.
  public static func scan(_ text: String) -> [PromptToken] {
    var tokens: [PromptToken] = []
    for word in words(in: text) {
      guard let kind = kind(ofWordAt: word.lowerBound, in: text) else { continue }
      let range = word.lowerBound..<trimmedEnd(of: word, in: text)
      let body = text[text.index(after: range.lowerBound)..<range.upperBound]
      guard !body.isEmpty else { continue }
      if kind == .command, body.unicodeScalars.contains(where: { !commandCharacters.contains($0) }) {
        continue
      }
      tokens.append(PromptToken(kind: kind, range: range, text: String(text[range])))
    }
    return tokens
  }

  /// Tokens in a draft that are *finished* — the ones a composer styles.
  ///
  /// A token counts as confirmed once something follows it, which is exactly the
  /// space that accepting a suggestion appends (and the space a typist hits after
  /// spelling one out). The word still being typed at the very end of the draft is
  /// left alone: styling it as the user types would flicker between plain and
  /// styled on every keystroke, and would claim a path exists before it does.
  public static func confirmed(in text: String) -> [PromptToken] {
    scan(text).filter { $0.range.upperBound < text.endIndex }
  }

  // MARK: - Drafts

  /// The token the cursor is sitting in, or nil. This is what drives the
  /// suggestion list, so it is permissive: a bare `@` counts (query `""`, which
  /// the server answers with the shallowest files), and a half-typed command is
  /// not charset-checked — the command list filters it anyway.
  ///
  /// The whole word is returned even when the cursor is mid-word, so accepting a
  /// suggestion replaces what was typed rather than splicing into it.
  public static func active(in text: String, at cursor: String.Index) -> PromptToken? {
    let start = wordStart(before: cursor, in: text)
    guard let kind = kind(ofWordAt: start, in: text) else { return nil }
    let end = wordEnd(from: start, in: text)
    // The cursor has to be inside the token, not just after the word it follows.
    guard cursor > start, cursor <= end else { return nil }
    let range = start..<end
    return PromptToken(kind: kind, range: range, text: String(text[range]))
  }

  /// Convenience for callers with no cursor: read the token off the end.
  public static func active(in text: String) -> PromptToken? {
    active(in: text, at: text.endIndex)
  }

  /// Replace `token` with `value` (given without its prefix), plus a trailing
  /// space — that is what closes the suggestion list and starts the next word
  /// cleanly. A completion accepted mid-message reuses the space already there
  /// rather than doubling it. Returns the new text and where the caret belongs.
  public static func apply(_ value: String, replacing token: PromptToken, in text: String)
    -> (text: String, cursor: String.Index)
  {
    let prefix = token.kind == .file ? "@" : "/"
    let followedBySpace =
      token.range.upperBound < text.endIndex && text[token.range.upperBound].isWhitespace
    let replacement = "\(prefix)\(value)\(followedBySpace ? "" : " ")"
    var next = text
    next.replaceSubrange(token.range, with: replacement)
    let offset = text.distance(from: text.startIndex, to: token.range.lowerBound)
      + replacement.count + (followedBySpace ? 1 : 0)
    return (next, next.index(next.startIndex, offsetBy: offset))
  }

  /// Replace `token` with a **literal** — the prefix included, nothing appended.
  ///
  /// The sibling of ``apply(_:replacing:in:)`` for a suggestion that is a typing
  /// aid rather than a token: picking a skill types ordinary prose where the
  /// `/name` was, and what lands must not read back as a token at all (`scan`
  /// would style it, and there is no command by that name to style). The caret
  /// is left at the end of the inserted text.
  public static func replace(with literal: String, replacing token: PromptToken, in text: String)
    -> (text: String, cursor: String.Index)
  {
    var next = text
    next.replaceSubrange(token.range, with: literal)
    let offset =
      text.distance(from: text.startIndex, to: token.range.lowerBound) + literal.count
    return (next, next.index(next.startIndex, offsetBy: offset))
  }

  // MARK: - Word geometry

  /// Word starts: the beginning of the text, and every position after whitespace.
  private static func words(in text: String) -> [Range<String.Index>] {
    var ranges: [Range<String.Index>] = []
    var index = text.startIndex
    while index < text.endIndex {
      if text[index].isWhitespace {
        index = text.index(after: index)
        continue
      }
      let end = wordEnd(from: index, in: text)
      ranges.append(index..<end)
      index = end
    }
    return ranges
  }

  private static func wordStart(before cursor: String.Index, in text: String) -> String.Index {
    var index = cursor
    while index > text.startIndex {
      let previous = text.index(before: index)
      if text[previous].isWhitespace { break }
      index = previous
    }
    return index
  }

  private static func wordEnd(from start: String.Index, in text: String) -> String.Index {
    var index = start
    while index < text.endIndex, !text[index].isWhitespace {
      index = text.index(after: index)
    }
    return index
  }

  /// Which token a word starting at `start` is, if any. Both need a word boundary
  /// and nothing more: an absolute path is kept out of the way by the charset
  /// check in ``scan(_:)`` (a command name may not contain a slash),
  /// not by where in the message it appears.
  private static func kind(ofWordAt start: String.Index, in text: String) -> PromptToken.Kind? {
    guard start < text.endIndex else { return nil }
    switch text[start] {
    case "@": return .file
    case "/": return .command
    default: return nil
    }
  }

  private static func trimmedEnd(of word: Range<String.Index>, in text: String) -> String.Index {
    var end = word.upperBound
    while end > word.lowerBound {
      let previous = text.index(before: end)
      guard let scalar = text[previous].unicodeScalars.first,
        text[previous].unicodeScalars.count == 1, sentenceTail.contains(scalar)
      else { break }
      end = previous
    }
    return end
  }
}
