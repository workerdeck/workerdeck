import WorkerDeckKit
import SwiftUI

extension TranscriptItem {
  /// Stable row identity. `id` alone is not unique — the reducer upserts on id
  /// *and* kind, so two items may legitimately share an id across kinds.
  var rowID: String { "\(kind.rawValue)#\(id)" }
}

/// One transcript row. A thin switch; each case is its own small view so the
/// interesting ones (tool calls) can hold their own layout without this growing.
///
/// This is the `cards` renderer, and only `cards`: the `terminal` variant draws
/// every row itself (`Session/Terminal/`) rather than branching inside these —
/// mirroring the web `ui` package, where nothing under `components/agent/` asks
/// which variant it is in.
struct TranscriptItemView: View {
  let item: TranscriptItem
  /// Expansion for the collapsible kinds (thinking, tool calls). Hoisted into the
  /// list so a row that scrolls out of a `LazyVStack` doesn't forget it was open.
  @Binding var isExpanded: Bool

  var body: some View {
    switch item {
    case .user(_, let text, let attachments, _):
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
    case .compaction:
      CompactionRow()
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

// MARK: - Rows

private struct UserBubble: View {
  let text: String
  /// Sent with the message; references only, so the thumbnails are fetched.
  let attachments: [MessageAttachment]

  var body: some View {
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

  var body: some View {
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

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        isExpanded.toggle()
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "brain")
          Text("Thinking…")
          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.caption2)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)

      if isExpanded {
        Text(text)
          .font(.callout.italic())
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

  var body: some View {
    summary
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 2)
  }

  private var summary: some View {
    VStack(alignment: .center, spacing: 3) {
      HStack(spacing: 6) {
        Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle")
        Text("\(Fmt.duration(ms: durationMs)) · \(Fmt.cost(totalCostUsd))")
          .monospacedDigit()
      }
      .font(.caption2)
      .foregroundStyle(isError ? Color.red : Color.secondary)

      if let errors, !errors.isEmpty {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(errors.enumerated()), id: \.offset) { _, message in
            Text(message)
              .font(.caption2)
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

  var body: some View {
    Text(text)
      .font(.caption2)
      .foregroundStyle(level == .error ? Color.red : Color.secondary)
      .multilineTextAlignment(.center)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 2)
  }
}

private struct CompactionRow: View {
  var body: some View {
    Text(TermFmt.compaction)
      .font(.caption2)
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 2)
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

  var body: some View {
    Button {
      downloader?.download(path)
    } label: {
      HStack(spacing: 10) {
        Image(systemName: "doc.badge.arrow.up")
          .imageScale(.large)
          .foregroundStyle(Color.accentColor)
        VStack(alignment: .leading, spacing: 2) {
          Text(Fmt.lastComponent(path))
            .font(.callout.weight(.medium))
            .lineLimit(1)
          Text(description.map { "\($0) · \(Fmt.bytes(bytes))" } ?? Fmt.bytes(bytes))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        Spacer(minLength: 0)
        if downloader?.inFlight == path {
          ProgressView().controlSize(.mini)
        } else if downloader != nil {
          Image(systemName: "square.and.arrow.down")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .padding(10)
      .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(downloader == nil)
  }
}
