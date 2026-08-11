import WorkerDeckKit
import SwiftUI
import UIKit

/// Cheap inline markdown for assistant text.
///
/// Only *inline* syntax is interpreted here (bold, italic, code spans, links)
/// and whitespace is preserved. Block structure — headings, lists, quotes,
/// fences, rules — is `MarkdownBlocks`' job; this is what renders the text
/// *inside* each block. `.inlineOnlyPreservingWhitespace` rather than full
/// parsing because the full mode collapses whitespace and cannot be fed a
/// half-streamed block; the block splitter exists so it never has to be.
/// Zero dependencies.
enum Markdown {
  static func inline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }

  /// Inline markdown plus `@file`/`/command` tinting — the one pipeline every
  /// block's text goes through, so a path in a bullet or a heading reads the
  /// same as one in a paragraph.
  static func styledInline(_ text: String) -> AttributedString {
    PromptTokenStyle.apply(to: inline(text))
  }
}

/// Assistant text with its block structure rendered: headings, lists, quotes,
/// rules, and fenced code. Anything the splitter doesn't model (tables
/// included — see `MarkdownBlocks`) arrives as prose and renders as it always
/// has: inline markdown, whitespace preserved.
///
/// The blocks are re-parsed on every streamed delta. That is fine — the parser
/// is a single pass over the text a turn has produced so far, far cheaper than
/// the layout SwiftUI does with the result.
struct MarkdownText: View {
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(MarkdownBlocks.parse(text).enumerated()), id: \.offset) { _, block in
        switch block {
        case .prose(let prose):
          Text(Markdown.styledInline(prose))
            .font(.body)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let heading):
          Text(Markdown.styledInline(heading))
            .font(headingFont(level))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .list(let items):
          ListBlock(items: items)
        case .blockquote(let quote):
          QuoteBlock(text: quote)
        case .thematicBreak:
          Divider().padding(.vertical, 2)
        case .code(let language, let code, let isClosed):
          CodeBlock(language: language, code: code, isClosed: isClosed)
        }
      }
    }
  }

  /// Transcript-scaled: an h1 in a chat bubble is a section label, not a page
  /// title, so the ramp tops out at `.title2` and h4–h6 settle on emphasis
  /// rather than shrinking below body text.
  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: return .title2.weight(.bold)
    case 2: return .title3.weight(.semibold)
    case 3: return .headline
    default: return .subheadline.weight(.semibold)
    }
  }
}

/// List items with a marker gutter. `firstTextBaseline` keeps the marker on
/// the first line when an item wraps; the min-width keeps `•` and `10.`
/// gutters from producing two different text edges in the same list.
private struct ListBlock: View {
  let items: [MarkdownListItem]

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(marker(for: item))
            .font(.body.monospacedDigit())
            .foregroundStyle(.secondary)
            .frame(minWidth: 14, alignment: .trailing)
          Text(Markdown.styledInline(item.text))
            .font(.body)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Depth capped at render time, not parse time: the parser reports what
        // the text said, but a phone column can't afford six real indents.
        .padding(.leading, CGFloat(min(item.depth, 4)) * 16)
      }
    }
  }

  private func marker(for item: MarkdownListItem) -> String {
    if let ordinal = item.ordinal { return "\(ordinal)." }
    switch item.depth {
    case 0: return "•"
    case 1: return "◦"
    default: return "▪"
    }
  }
}

/// A quote: the conventional bar, content dimmed a step so quoted material
/// reads as reference rather than as the assistant speaking.
private struct QuoteBlock: View {
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      RoundedRectangle(cornerRadius: 1.5)
        .fill(Color.secondary.opacity(0.35))
        .frame(width: 3)
      Text(Markdown.styledInline(text))
        .font(.body)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .fixedSize(horizontal: false, vertical: true)
  }
}

/// A fenced block: language chip, copy button, and the code itself scrolling
/// sideways rather than wrapping — wrapped code is unreadable, and a nested
/// *vertical* scroll inside the transcript would steal the outer gesture.
private struct CodeBlock: View {
  let language: String?
  let code: String
  let isClosed: Bool

  @State private var didCopy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        if let language, !language.isEmpty {
          Text(language)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
        // Nothing to copy yet while the block is still arriving, and a copy
        // taken mid-stream would be a truncated snippet.
        if isClosed {
          Button {
            UIPasteboard.general.string = code
            didCopy = true
          } label: {
            Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
              .font(.caption2)
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .accessibilityLabel(didCopy ? "Copied" : "Copy code")
        } else {
          ProgressView()
            .controlSize(.mini)
            .accessibilityLabel("Still writing")
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 5)

      Divider()

      ScrollView(.horizontal, showsIndicators: false) {
        Text(code)
          .font(.caption.monospaced())
          .textSelection(.enabled)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
      }
    }
    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(Color.secondary.opacity(0.15)))
  }
}
