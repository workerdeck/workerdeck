import SwiftUI
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The suggestion list for the prompt tokens, drawn from the core's rows. A fixed height, so the row under a finger
// does not move as the filter narrows.
struct PromptSuggestionList: View {
  let suggestions: [Suggestion]
  let onAccept: (Int) -> Void

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(suggestions.enumerated()), id: \.element.id) { index, suggestion in
          Button {
            onAccept(index)
          } label: {
            PromptSuggestionRow(suggestion: suggestion)
              .padding(.horizontal, 14)
              .padding(.vertical, 8)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("Suggestion")
          if index < suggestions.count - 1 { Divider().padding(.leading, 14) }
        }
      }
    }
    .scrollIndicators(.hidden)
    .frame(maxWidth: .infinity)
    .frame(height: 240)
    .background(Color(.systemBackground))
    .overlay(alignment: .top) { Rectangle().fill(TerminalPalette.cellStroke).frame(height: 1) }
  }
}

private struct PromptSuggestionRow: View {
  let suggestion: Suggestion

  var body: some View {
    if suggestion.kind == .command {
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          Text(suggestion.title)
            .font(.system(.callout, design: .monospaced))
            .foregroundStyle(PromptTokenStyle.color(.command))
            .lineLimit(1)
          if let hint = suggestion.hint {
            Text(hint).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
          }
        }
        if let subtitle = suggestion.subtitle {
          Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      HStack(spacing: 9) {
        Image(systemName: symbol).font(.caption).foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 1) {
          Text(suggestion.title).font(.callout).lineLimit(1)
          if let subtitle = suggestion.subtitle {
            Text(subtitle)
              .font(suggestion.pathSubtitle ? .caption2.monospaced() : .caption2)
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .truncationMode(suggestion.pathSubtitle ? .head : .tail)
          }
        }
        Spacer(minLength: 0)
      }
    }
  }

  private var symbol: String {
    switch suggestion.kind {
    case .file: "doc"
    case .skill: "sparkles"
    case .session: "person.2"
    case .command: "chevron.right"
    }
  }
}
