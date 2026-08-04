import WorkerDeckKit
import SwiftUI

/// Renders `@file` and `/command` tokens the way the CLI writes them: monospace
/// and tinted, no background — a bubble already has one, and a second fill inside
/// it reads as a button.
///
/// The recognition rules are `PromptTokens` in the kit, where they are unit-tested
/// and shared with the composer, so a token looks the same while it is being typed
/// and after it is sent. This file only decides what the styling *is*.
enum PromptTokenStyle {
  /// Style a plain, unparsed string — user messages, which are literal text.
  static func styled(_ text: String) -> AttributedString {
    apply(to: AttributedString(text))
  }

  /// Style an already-parsed string — assistant prose, after inline markdown.
  ///
  /// Scanning happens over the *rendered* characters rather than the source, so
  /// offsets survive markdown having eaten its own syntax (`**bold**` → `bold`).
  static func apply(to attributed: AttributedString) -> AttributedString {
    let plain = String(attributed.characters)
    let tokens = PromptTokens.scan(plain)
    guard !tokens.isEmpty else { return attributed }

    var result = attributed
    for token in tokens {
      let start = plain.distance(from: plain.startIndex, to: token.range.lowerBound)
      let end = plain.distance(from: plain.startIndex, to: token.range.upperBound)
      let lower = result.index(result.startIndex, offsetByCharacters: start)
      let upper = result.index(result.startIndex, offsetByCharacters: end)
      result[lower..<upper].font = font
      result[lower..<upper].foregroundColor = color(token.kind)
    }
    return result
  }

  /// Slightly tighter than body text: monospace runs wide, and a path in the
  /// middle of a sentence shouldn't outweigh it.
  static let font: Font = .system(.callout, design: .monospaced)

  /// Two tokens, two meanings — a file is a reference, a command is an action —
  /// so they are told apart by hue rather than by shape alone.
  static func color(_ kind: PromptToken.Kind) -> Color {
    switch kind {
    case .file: return .accentColor
    case .command: return .purple
    }
  }
}
