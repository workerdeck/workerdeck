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
  /// Assistant prose is the biggest block of text on screen, so it is where the
  /// `lines` variant's one-size rule matters most.
  @Environment(\.transcriptVariant) private var variant

  let text: String

  var body: some View {
    // Tighter in `lines`: a terminal separates blocks by one line, not by a
    // paragraph's worth of air, and a heading that is only bold needs less room
    // around it than one that was also bigger.
    VStack(alignment: .leading, spacing: variant.isLines ? 6 : 10) {
      ForEach(Array(MarkdownBlocks.parse(text).enumerated()), id: \.offset) { _, block in
        switch block {
        case .prose(let prose):
          Text(Markdown.styledInline(prose))
            .font(bodyFont)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let heading):
          Text(Markdown.styledInline(heading))
            .font(headingFont(level))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .list(let items):
          ListBlock(items: items, font: bodyFont, ascii: variant.isLines)
        case .blockquote(let quote):
          QuoteBlock(text: quote, font: bodyFont)
        case .thematicBreak:
          Divider().padding(.vertical, 2)
        case .code(let language, let code, let isClosed):
          CodeBlock(language: language, code: code, isClosed: isClosed)
        }
      }
    }
  }

  /// Body text for every block. In `lines` it is the transcript's one size, so a
  /// bullet and the prompt above it are set in the same type; in `cards` it stays
  /// `.body`, which is what a chat bubble wants.
  private var bodyFont: Font { variant.isLines ? lineTextStyle : .body }

  /// Transcript-scaled: an h1 in a chat bubble is a section label, not a page
  /// title, so the ramp tops out at `.title2` and h4–h6 settle on emphasis
  /// rather than shrinking below body text.
  ///
  /// In `lines` the ramp collapses to weight alone: a terminal marks a heading by
  /// making it bold, not by making it bigger, and a `.title2` in a column of
  /// one-size rows is the loudest thing on the screen.
  private func headingFont(_ level: Int) -> Font {
    if variant.isLines { return lineTextStyle.weight(level <= 2 ? .bold : .semibold) }
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
  /// Handed down rather than read from the environment: the marker and the item
  /// share one size, and the parent already decided what it is.
  let font: Font
  /// `lines` writes its lists the way a terminal does — `- item`, one character
  /// and one space — rather than with a typographic bullet in a right-aligned
  /// gutter. Same reason the row markers are characters: this variant does not
  /// draw, it types.
  var ascii = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        HStack(alignment: .firstTextBaseline, spacing: ascii ? 0 : 6) {
          Text(marker(for: item))
            .font(font.monospacedDigit())
            .foregroundStyle(.secondary)
            // A right-aligned gutter is what keeps `•` and `10.` producing one
            // text edge. In ascii the marker is one character followed by one
            // space — the literal form — so it needs no gutter at all.
            .frame(minWidth: ascii ? nil : 14, alignment: ascii ? .leading : .trailing)
          Text(Markdown.styledInline(item.text))
            .font(font)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Depth capped at render time, not parse time: the parser reports what
        // the text said, but a phone column can't afford six real indents.
        .padding(.leading, CGFloat(min(item.depth, 4)) * 16)
        // The row is an `HStack`, and that is the whole reason this is here: a
        // `Text`'s *ideal* height is one line, so the stack sizes itself to one
        // line and the item truncates with an ellipsis instead of wrapping. Prose
        // and headings escape it by being direct children of the outer `VStack`;
        // `QuoteBlock` is an `HStack` too and already carries the same line.
        .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func marker(for item: MarkdownListItem) -> String {
    if let ordinal = item.ordinal { return ascii ? "\(ordinal). " : "\(ordinal)." }
    if ascii {
      // The three markdown source characters, in source order — what the model
      // most likely typed, and what a terminal would have shown back.
      switch item.depth {
      case 0: return "- "
      case 1: return "* "
      default: return "+ "
      }
    }
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
  let font: Font

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      RoundedRectangle(cornerRadius: 1.5)
        .fill(Color.secondary.opacity(0.35))
        .frame(width: 3)
      Text(Markdown.styledInline(text))
        .font(font)
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
  @Environment(\.transcriptVariant) private var variant

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
            // A character in `lines`, like every other marker in it.
            if variant.isLines {
              Text(didCopy ? "✓" : "⧉").font(.caption.monospaced())
            } else {
              Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                .font(.caption2)
            }
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .accessibilityLabel(didCopy ? "Copied" : "Copy code")
        } else if variant.isLines {
          PulseGlyph()
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .accessibilityLabel("Still writing")
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
