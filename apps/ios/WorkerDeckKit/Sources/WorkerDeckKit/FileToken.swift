import Foundation

/// The text half of `@`-prefixed file completion in the composer, the way the
/// Claude Code CLI does it: type `@`, keep typing to filter, pick a file, and the
/// path lands in the prompt.
///
/// Pure string work, so it lives here rather than in the app — this package is
/// the part under test, and the interesting cases are all edges: an `@` mid-word,
/// a token already terminated by a space, an email address.
///
/// The token is read off the **end** of the draft rather than around a cursor.
/// SwiftUI's `TextField` exposes no selection, and the alternative — wrapping
/// `UITextView` in a `UIViewRepresentable` — is a lot of machinery for a case that
/// barely happens: on a phone you type at the end. Editing an `@token` in the
/// middle of an existing message simply doesn't trigger completion, which is a
/// missing affordance rather than a wrong one.
public enum FileToken {
  /// The trailing `@…` token, or nil when the draft doesn't end in one.
  ///
  /// A token runs from an `@` at a word boundary to the end of the text, so
  /// `@src/Ses` is one and `@src/Ses ` is none — accepting a completion appends a
  /// space, which is also what closes the suggestion list. `you@example.com` is
  /// not a token either: the `@` has to start the word.
  public static func trailing(in text: String) -> Range<String.Index>? {
    let start =
      text.lastIndex(where: { $0.isWhitespace }).map { text.index(after: $0) } ?? text.startIndex
    guard start < text.endIndex, text[start] == "@" else { return nil }
    return start..<text.endIndex
  }

  /// What to search for: the token without its `@`. Empty right after `@`, which
  /// the server answers with the shallowest files in the directory.
  public static func query(in text: String) -> String? {
    guard let range = trailing(in: text) else { return nil }
    return String(text[range].dropFirst())
  }

  /// Replace the trailing token with the chosen path, plus a trailing space so the
  /// next word starts cleanly and the suggestion list closes on its own.
  public static func apply(_ relativePath: String, to text: String) -> String {
    guard let range = trailing(in: text) else { return text }
    return text.replacingCharacters(in: range, with: "@\(relativePath) ")
  }
}
