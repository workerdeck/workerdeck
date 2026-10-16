import WorkerDeckCore
import WorkerDeckKit
import SwiftUI

/// The model and permission-mode pickers, as sheets rather than menus.
///
/// A `Menu` is rendered by UIKit and gives you a title, a subtitle and an image
/// per row and nothing else - no descriptions worth reading, no coloured icons,
/// no styled DEFAULT tag. Both of these are choices worth a moment's reading, so
/// they get a screen. Deliberately shaped like Claude Code's own selectors: a
/// title, a close button, and one rounded card of rows.
private struct SelectionSheet<Content: View, Trailing: View>: View {
  let title: String
  /// The card. One rounded group of rows.
  @ViewBuilder let content: Content
  /// Anything below it, already carrying its own background - the model picker's
  /// "More models" group.
  @ViewBuilder let trailing: Trailing

  @Environment(\.dismiss) private var dismiss

  init(
    title: String, @ViewBuilder content: () -> Content,
    @ViewBuilder trailing: () -> Trailing = { EmptyView() }
  ) {
    self.title = title
    self.content = content()
    self.trailing = trailing()
  }

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        Text(title)
          .font(.headline)
        HStack {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 13, weight: .bold))
              .foregroundStyle(.secondary)
              .frame(width: 34, height: 34)
              .background(Color.secondary.opacity(0.18), in: Circle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Close")
          Spacer()
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 18)
      .padding(.bottom, 14)

      ScrollView {
        VStack(spacing: 0) {
          VStack(spacing: 0) { content }
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
          trailing
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}

/// One row of a selection sheet: optional icon, name, what it does, and the two
/// markers - a checkmark for what is in force, DEFAULT for what the session
/// started on. They are independent: the default is often not the current choice.
private struct SelectionRow: View {
  let title: String
  let summary: String?
  var symbol: String?
  var symbolTint: Color = .accentColor
  let isSelected: Bool
  let isDefault: Bool
  var showsDivider: Bool
  /// Offered but not switchable - greyed and inert, with `summary` saying why.
  var isDisabled = false
  let action: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      Button(action: action) {
        HStack(alignment: .center, spacing: 14) {
          if let symbol {
            Image(systemName: symbol)
              .font(.system(size: 17))
              .foregroundStyle(symbolTint)
              .frame(width: 24)
          }
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
              Text(title)
                .font(.body)
                .foregroundStyle(.primary)
              if isDefault {
                Text("DEFAULT")
                  .font(.system(size: 10, weight: .bold))
                  .foregroundStyle(Color.accentColor)
                  .padding(.horizontal, 6)
                  .padding(.vertical, 2)
                  .background(Color.accentColor.opacity(0.15), in: Capsule())
              }
            }
            if let summary, !summary.isEmpty {
              Text(summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Spacer(minLength: 8)
          if isSelected {
            Image(systemName: "checkmark")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(Color.accentColor)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
        .opacity(isDisabled ? 0.4 : 1)
      }
      .buttonStyle(.plain)
      .disabled(isDisabled)
      if showsDivider {
        Divider().padding(.leading, symbol == nil ? 16 : 54)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
  }
}

/// Pick the model this session answers with.
///
/// Every row is a real model the CLI reports - the CLI's own `default` row ("use
/// whatever I'd pick") is dropped server-side, because it is a choice rather than
/// a model: a session running on it reports something else, so the row could
/// never be checked and the status bar would name it wrongly.
///
/// The main list is the newest of each family (`primary` from the server); older
/// versions follow under "More models" in the same scroll rather than behind a
/// second screen, which on a phone is the cheaper of the two.
struct ModelPickerSheet: View {
  // The core's rows: `main` in the card, `more` under "More models", `efforts` (empty hides it) below.
  let picker: ModelPicker
  let onSelect: (String?) -> Void
  var onSelectEffort: (String?) -> Void = { _ in }

  @Environment(\.dismiss) private var dismiss
  @HotReloaded private var hot

  var body: some View {
    SelectionSheet(title: picker.title) {
      if picker.main.isEmpty && picker.more.isEmpty {
        // Before `capabilities` lands there is nothing to list - and nothing to
        // pick either, since every id here comes from the CLI.
        Text("This session hasn't reported its models yet.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(16)
      }
      rows(picker.main, onSelect)
    } trailing: {
      if !picker.more.isEmpty {
        groupHeading("More models")
        VStack(spacing: 0) { rows(picker.more, onSelect) }
          .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
      }
      if !picker.efforts.isEmpty {
        groupHeading("Effort")
        VStack(spacing: 0) { rows(picker.efforts, onSelectEffort) }
          .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
      }
    }
  }

  private func groupHeading(_ text: String) -> some View {
    Text(text)
      .font(.footnote.weight(.medium))
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 22)
      .padding(.bottom, 8)
      .padding(.horizontal, 4)
  }

  @ViewBuilder
  private func rows(_ rows: [PickerRow], _ select: @escaping (String?) -> Void) -> some View {
    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
      SelectionRow(
        title: row.title,
        summary: row.summary,
        isSelected: row.selected,
        isDefault: row.isDefault,
        showsDivider: index < rows.count - 1
      ) {
        select(row.value)
        dismiss()
      }
    }
  }
}

/// Pick how much of the approval gate this session gives away.
///
/// The core orders the rows, pins `bypassPermissions` last and greys it, with
/// the reason as its summary, where the CLI would refuse the switch.
struct ModePickerSheet: View {
  let picker: ModePicker
  let onSelect: (Mode) -> Void

  @Environment(\.dismiss) private var dismiss
  @HotReloaded private var hot

  var body: some View {
    SelectionSheet(title: "Select mode") {
      ForEach(Array(picker.rows.enumerated()), id: \.offset) { index, row in
        SelectionRow(
          title: row.title,
          summary: row.summary,
          symbol: row.mode.symbol,
          symbolTint: row.mode.symbolTint,
          isSelected: row.selected,
          isDefault: row.isDefault,
          showsDivider: index < picker.rows.count - 1,
          isDisabled: row.disabled
        ) {
          onSelect(row.mode)
          dismiss()
        }
      }
    }
  }
}
