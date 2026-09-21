import WorkerDeckKit
import SwiftUI

/// Renders `@file` and `/command` tokens the way the CLI writes them: monospace
/// and tinted, no background - a bubble already has one, and a second fill inside
/// it reads as a button.
///
/// The recognition rules are `PromptTokens` in the kit, where they are unit-tested
/// and shared with the composer, so a token looks the same while it is being typed
/// and after it is sent. This file only decides what the styling *is*.
enum PromptTokenStyle {
  /// Style a plain, unparsed string - user messages, which are literal text.
  static func styled(_ text: String, names: PromptTokenNames = .none) -> AttributedString {
    apply(to: AttributedString(text), names: names)
  }

  /// Style an already-parsed string - assistant prose, after inline markdown.
  ///
  /// Scanning happens over the *rendered* characters rather than the source, so
  /// offsets survive markdown having eaten its own syntax (`**bold**` → `bold`).
  static func apply(to attributed: AttributedString, names: PromptTokenNames = .none)
    -> AttributedString
  {
    let plain = String(attributed.characters)
    let tokens = PromptTokens.scan(plain, skills: names.skills, sessions: names.sessions)
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

  /// Four tokens, four meanings - a file is a reference, a command is an action,
  /// a skill is a capability, a session is someone else - so they are told apart
  /// by hue rather than by shape alone.
  static func color(_ kind: PromptToken.Kind) -> Color {
    switch kind {
    case .file: return .accentColor
    case .command: return .purple
    case .skill: return .orange
    case .session: return .green
    }
  }
}

/// The two gated sigils' allowlists, carried down the transcript.
///
/// `$name` and `#Name` are ordinary prose far more often than they are tokens, so
/// each is styled only against a list this client holds: the skills the session
/// reported, the sessions the gateway listed. Empty means "style neither", which
/// is what a session with no skills and a gateway with no peers gets.
struct PromptTokenNames: Equatable {
  var skills: Set<String> = []
  var sessions: Set<String> = []

  static let none = PromptTokenNames()
}

private struct PromptTokenNamesKey: EnvironmentKey {
  static let defaultValue = PromptTokenNames.none
}

extension EnvironmentValues {
  var promptTokenNames: PromptTokenNames {
    get { self[PromptTokenNamesKey.self] }
    set { self[PromptTokenNamesKey.self] = newValue }
  }
}
