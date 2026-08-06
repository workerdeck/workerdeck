import WorkerDeckKit
import SwiftUI

/// The `/command`, `$skill` and `@file` picker: one glass panel filling the space
/// the header and the composer.
///
/// It is a screen-level popover rather than part of the composer's card, which is
/// what lets it claim that space — `SessionView` hangs it in an overlay *under*
/// the bottom safe-area inset, so `safeAreaPadding()` alone lands it flush below
/// the navigation bar and just above the input card, with no height to compute.
///
/// The height is fixed rather than fitted to the rows on purpose: a panel that
/// shrank as the filter narrowed would move the row you were reaching for on every
/// keystroke. Empty space under two results is the cheaper trade.
struct PromptSuggestionList: View {
  let suggestions: [PromptCompletionModel.Suggestion]
  let onAccept: (PromptCompletionModel.Suggestion) -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(suggestions) { suggestion in
          Button {
            onAccept(suggestion)
          } label: {
            SuggestionRow(suggestion: suggestion)
              .padding(.horizontal, 14)
              .padding(.vertical, 8)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          if suggestion.id != suggestions.last?.id {
            Divider().padding(.leading, 14)
          }
        }
      }
    }
    .scrollIndicators(.hidden)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .glassPanel(cornerRadius: 20)
  }
}

/// One suggestion, in two lines: what you scan for on top, what tells two of them
/// apart underneath — the file's path, the command's description.
private struct SuggestionRow: View {
  let suggestion: PromptCompletionModel.Suggestion

  var body: some View {
    switch suggestion {
    case .file(let match):
      HStack(spacing: 9) {
        Image(systemName: "doc")
          .font(.caption)
          .foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 1) {
          Text(Fmt.lastComponent(match.relative))
            .font(.callout)
            .lineLimit(1)
          Text(match.relative)
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
        }
        Spacer(minLength: 0)
      }
    case .command(let command):
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          Text("/\(command.name)")
            .font(PromptTokenStyle.font)
            .foregroundStyle(PromptTokenStyle.color(.command))
            .lineLimit(1)
          if let hint = command.argumentHint, !hint.isEmpty {
            Text(hint)
              .font(.caption2.monospaced())
              .foregroundStyle(.tertiary)
              .lineLimit(1)
          }
        }
        if let description = command.description, !description.isEmpty {
          Text(description)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    case .skill(let skill):
      // Deliberately unlike the command row above: `$` rather than `/`, a
      // different glyph, and a subtitle saying what picking it does. Codex's own
      // TUI shows skills this way, and a row that looked like a command row
      // would promise syntax no engine parses.
      HStack(spacing: 9) {
        Image(systemName: "sparkles")
          .font(.caption)
          .foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 1) {
          Text(skill.displayName ?? skill.name)
            .font(.callout)
            .lineLimit(1)
          Text(skill.shortDescription ?? skill.description ?? "Inserts a message you can edit")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        Spacer(minLength: 0)
      }
    }
  }
}

/// The floating stack's measured height, so the picker can stop just above it.
struct FooterHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}
