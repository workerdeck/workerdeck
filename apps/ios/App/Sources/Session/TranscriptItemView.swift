import WorkerDeckKit
import SwiftUI

extension TranscriptItem {
  /// Stable row identity. `id` alone is not unique — the reducer upserts on id
  /// *and* kind, so two items may legitimately share an id across kinds.
  var rowID: String { "\(kind.rawValue)#\(id)" }
}

/// One transcript row. A thin switch; each case is its own small view so the
/// interesting ones (tool calls) can hold their own layout without this growing.
struct TranscriptItemView: View {
  let item: TranscriptItem
  /// Expansion for the collapsible kinds (thinking, tool calls). Hoisted into the
  /// list so a row that scrolls out of a `LazyVStack` doesn't forget it was open.
  @Binding var isExpanded: Bool

  var body: some View {
    switch item {
    case .user(_, let text, let attachments):
      UserBubble(text: text, attachments: attachments ?? [])
    case .assistantText(_, let text, let streaming, let parentToolUseId):
      AssistantText(text: text, streaming: streaming)
        .nested(parentToolUseId != nil)
    case .thinking(_, let text, let parentToolUseId):
      ThinkingRow(text: text, isExpanded: $isExpanded)
        .nested(parentToolUseId != nil)
    case .toolCall(let call):
      ToolCallCard(call: call, isExpanded: $isExpanded)
        .nested(call.parentToolUseId != nil)
    case .turnResult(_, _, let isError, let durationMs, let totalCostUsd, let errors):
      TurnResultRow(
        isError: isError, durationMs: durationMs, totalCostUsd: totalCostUsd, errors: errors)
    case .notice(_, let level, let text):
      NoticeRow(level: level, text: text)
    case .fileDelivered(_, let path, let bytes, let description):
      FileDeliveredCard(path: path, bytes: bytes, description: description)
    }
  }
}

extension View {
  /// Indent rows produced inside a subagent (`parentToolUseId != nil`).
  @ViewBuilder
  fileprivate func nested(_ isNested: Bool) -> some View {
    if isNested {
      padding(.leading, 16)
    } else {
      self
    }
  }
}

// MARK: - Line gutter

/// The left gutter of a line item: one glyph in a fixed-width box, so every row's
/// text starts on the same column no matter which kind of event it is. Decorative
/// — the row's own text says what it is.
///
/// The glyph vocabulary is the web transcript's (`❯` typed, `●` said, `✻`
/// thinking, `·` turn result, `!` notice, `◇` file), so the two surfaces read the
/// same. Unlike a terminal, a fixed frame here makes the ambiguous-width
/// characters safe.
struct LineGlyph: View {
  let glyph: String
  var color: Color = .secondary

  static let width: CGFloat = 14

  var body: some View {
    LineGlyphBox(color: color) { Text(glyph) }
  }
}

/// The gutter's box on its own, for a marker that is not a constant string —
/// the pulse. Same width, same font, same baseline, so it holds the column.
struct LineGlyphBox<Content: View>: View {
  var color: Color = .secondary
  @ViewBuilder let content: Content

  var body: some View {
    content
      // The row's own text size, not a smaller one: `LineRow` aligns on the
      // first baseline, and two different sizes on one baseline put the glyph's
      // optical centre above the text's. Same size, same centre.
      .font(lineTextStyle.monospaced())
      .foregroundStyle(color)
      .frame(width: LineGlyph.width)
      .accessibilityHidden(true)
  }
}

/// The brand mark's own pulse — `⋄ ◇ ◈ ◆` at 150ms, the same four frames on the
/// same clock as the web transcript's `pulse.tsx`, so a working row beats the
/// same way on both surfaces.
///
/// It is what a running tool wears in the gutter, which is why `lines` needs no
/// spinner anywhere: a spinner is a drawn control, and this variant's whole claim
/// is that a character can do the job. Rests on `◆` under Reduce Motion, free —
/// the last frame *is* the mark.
struct PulseGlyph: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let frames = ["⋄", "◇", "◈", "◆"]
  private static let interval: TimeInterval = 0.15

  var body: some View {
    if reduceMotion {
      Text(Self.frames[3])
    } else {
      TimelineView(.periodic(from: .now, by: Self.interval)) { context in
        let step = Int(context.date.timeIntervalSinceReferenceDate / Self.interval)
        Text(Self.frames[((step % 4) + 4) % 4])
      }
    }
  }
}

/// One `lines` row: a glyph gutter and the content beside it, full width.
struct LineRow<Content: View>: View {
  let glyph: String
  var color: Color = .secondary
  @ViewBuilder let content: Content

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      LineGlyph(glyph: glyph, color: color)
      content
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

// MARK: - Rows

private struct UserBubble: View {
  let text: String
  /// Sent with the message; references only, so the thumbnails are fetched.
  let attachments: [MessageAttachment]

  @Environment(\.transcriptVariant) private var variant

  var body: some View {
    if variant.isLines {
      lines
    } else {
      cards
    }
  }

  /// Left-aligned behind a `❯`, on a band of its own — the CLI's own treatment.
  /// No bubble: a prompt is already distinguishable by its marker, and the
  /// bubble's padding is vertical space this variant refuses to spend.
  private var lines: some View {
    LineRow(glyph: "❯", color: .accentColor) {
      VStack(alignment: .leading, spacing: 6) {
        if !attachments.isEmpty {
          SentAttachmentsView(attachments: attachments)
        }
        if !text.isEmpty {
          Text(PromptTokenStyle.styled(text))
            .font(lineTextStyle)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  private var cards: some View {
    HStack {
      Spacer(minLength: 44)
      VStack(alignment: .trailing, spacing: 6) {
        if !attachments.isEmpty {
          SentAttachmentsView(attachments: attachments)
        }
        // A photo can be the whole message: an empty bubble under it would be a
        // rectangle saying nothing.
        if !text.isEmpty {
          // Literal text, not markdown — what was typed is what was sent. The one
          // pass over it is token styling, so a message reads the same after sending
          // as it did in the composer.
          Text(PromptTokenStyle.styled(text))
            .font(.body)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 14))
            .multilineTextAlignment(.leading)
        }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }
}

private struct AssistantText: View {
  let text: String
  let streaming: Bool

  @Environment(\.transcriptVariant) private var variant

  var body: some View {
    if variant.isLines {
      LineRow(glyph: "●") { content }
    } else {
      content
    }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 4) {
      MarkdownText(text: text)
        .frame(maxWidth: .infinity, alignment: .leading)
      if streaming {
        // Subtle: a caret-sized bar, not a spinner — the text itself is the
        // progress indicator.
        Capsule()
          .fill(Color.secondary.opacity(0.5))
          .frame(width: 22, height: 3)
          .accessibilityLabel("Still writing")
      }
    }
  }
}

private struct ThinkingRow: View {
  let text: String
  @Binding var isExpanded: Bool

  @Environment(\.transcriptVariant) private var variant

  var body: some View {
    if variant.isLines {
      LineRow(glyph: "✻") { content }
    } else {
      content
    }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        isExpanded.toggle()
      } label: {
        HStack(spacing: 6) {
          // `lines` draws no SF Symbols: the gutter's `✻` already says what this
          // row is, and the disclosure is a character like everything else here.
          if !variant.isLines {
            Image(systemName: "brain")
          }
          Text("Thinking…")
          if variant.isLines {
            Text(isExpanded ? "▾" : "▸")
          } else {
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
              .font(.caption2)
          }
        }
        .rowFont(.caption)
        .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)

      if isExpanded {
        Text(text)
          .rowFont(.callout.italic(), lines: lineTextStyle.italic())
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}

private struct TurnResultRow: View {
  let isError: Bool
  let durationMs: Double
  let totalCostUsd: Double
  let errors: [String]?

  @Environment(\.transcriptVariant) private var variant

  var body: some View {
    if variant.isLines {
      // Left-aligned on the gutter with everything else: `lines` has no centred
      // rows, because a centred row breaks the column the glyphs establish.
      LineRow(glyph: "·", color: isError ? .red : .secondary) {
        summary
      }
    } else {
      summary
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 2)
    }
  }

  private var summary: some View {
    VStack(alignment: variant.isLines ? .leading : .center, spacing: 3) {
      HStack(spacing: 6) {
        if variant.isLines {
          Text(isError ? "✗" : "✓")
        } else {
          Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle")
        }
        Text("\(Fmt.duration(ms: durationMs)) · \(Fmt.cost(totalCostUsd))")
          .monospacedDigit()
      }
      .rowFont(.caption2)
      .foregroundStyle(isError ? Color.red : Color.secondary)

      if let errors, !errors.isEmpty {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(errors.enumerated()), id: \.offset) { _, message in
            Text(message)
              .rowFont(.caption2)
              .foregroundStyle(.red)
          }
        }
      }
    }
  }
}

private struct NoticeRow: View {
  let level: NoticeLevel
  let text: String

  @Environment(\.transcriptVariant) private var variant

  var body: some View {
    if variant.isLines {
      LineRow(glyph: "!", color: level == .error ? .red : .secondary) {
        Text(text)
          .font(lineTextStyle)
          .foregroundStyle(level == .error ? Color.red : Color.secondary)
          .multilineTextAlignment(.leading)
          .textSelection(.enabled)
      }
    } else {
      Text(text)
        .font(.caption2)
        .foregroundStyle(level == .error ? Color.red : Color.secondary)
        .multilineTextAlignment(.center)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 2)
    }
  }
}

/// A file the agent delivered. Tapping downloads it through the gateway (the
/// bytes need the auth header, so the raw URL is not shareable) and hands it to
/// the system share sheet.
private struct FileDeliveredCard: View {
  let path: String
  let bytes: Int
  let description: String?

  @Environment(\.fileDownloader) private var downloader
  @Environment(\.transcriptVariant) private var variant

  var body: some View {
    if variant.isLines {
      LineRow(glyph: "◇") { button }
    } else {
      button
    }
  }

  private var button: some View {
    Button {
      downloader?.download(path)
    } label: {
      HStack(spacing: 10) {
        // The gutter glyph already marks this row as a file in `lines`; a second
        // icon beside it would say the same thing twice.
        if !variant.isLines {
          Image(systemName: "doc.badge.arrow.up")
            .imageScale(.large)
            .foregroundStyle(Color.accentColor)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(Fmt.lastComponent(path))
            .rowFont(.callout.weight(.medium), lines: lineTextStyle.weight(.medium))
            .lineLimit(1)
          Text(description.map { "\($0) · \(Fmt.bytes(bytes))" } ?? Fmt.bytes(bytes))
            .rowFont(.caption2, lines: .caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        Spacer(minLength: 0)
        if downloader?.inFlight == path {
          if variant.isLines {
            PulseGlyph().rowFont(.caption).foregroundStyle(.secondary)
          } else {
            ProgressView().controlSize(.mini)
          }
        } else if downloader != nil {
          if variant.isLines {
            Text("↓").rowFont(.caption).foregroundStyle(.secondary)
          } else {
            Image(systemName: "square.and.arrow.down")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      .padding(variant.isLines ? 0 : 10)
      .background(
        variant.isLines ? Color.clear : Color.secondary.opacity(0.1),
        in: RoundedRectangle(cornerRadius: 10)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(downloader == nil)
  }
}
