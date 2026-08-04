import WorkerDeckKit
import SwiftUI
import UIKit

/// Cheap inline markdown for assistant text.
///
/// Only *inline* syntax is interpreted (bold, italic, code spans, links) and
/// whitespace is preserved, so lists and headings survive as literal text with
/// their original line breaks instead of being flattened into one paragraph.
/// Fenced code blocks are lifted out first by `MarkdownBlocks` and rendered by
/// `MarkdownText`; full block rendering (and syntax highlighting) is a later
/// phase. Zero dependencies.
enum Markdown {
  static func inline(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false,
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }
}

/// Assistant prose with its fenced code blocks rendered as code.
///
/// The blocks are re-parsed on every streamed delta. That is fine — the parser is
/// a single pass over the text a turn has produced so far, far cheaper than the
/// layout SwiftUI does with the result.
struct MarkdownText: View {
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(MarkdownBlocks.parse(text).enumerated()), id: \.offset) { _, block in
        switch block {
        case .prose(let prose):
          Text(Markdown.inline(prose))
            .font(.body)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .code(let language, let code, let isClosed):
          CodeBlock(language: language, code: code, isClosed: isClosed)
        }
      }
    }
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
