import Foundation

/// Inline markdown, rendered once and shared by the measurer and the renderer.
///
/// This is the piece that makes the terminal theme's height claim honest on
/// iOS. The web client strips inline syntax with a regex chain (`stripInline` in
/// `height.ts`) so that `**bold**` is measured as the four characters the
/// browser will actually draw. A second implementation of "what does this
/// render as" is a second answer, and the two drift the moment either changes.
///
/// So there is one: `attributed` produces the styled run, `plain` is literally
/// `String(attributed.characters)`, and the height calculator wraps *that*. The
/// renderer then slices the same `AttributedString` at the same offsets. A row
/// cannot be measured as one string and drawn as another, because there is only
/// one string.
///
/// Block structure — headings, lists, quotes, fences, rules — is
/// ``MarkdownBlocks``' job; this is what renders the text *inside* each block.
/// `.inlineOnlyPreservingWhitespace` rather than full parsing for two reasons:
/// the full mode collapses whitespace, which a monospace grid cannot afford, and
/// it cannot be handed a half-streamed block.
public enum MarkdownInline {
  public static func attributed(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }

  /// The characters that will be drawn — what to wrap and measure.
  public static func plain(_ text: String) -> String {
    String(attributed(text).characters)
  }
}
