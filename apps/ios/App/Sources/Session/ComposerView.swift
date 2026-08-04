import WorkerDeckKit
import SwiftUI

/// The input card: a glass shell around a growing rich-text field.
///
/// It has two shapes. At rest it is the field and nothing else, so a session being
/// read is not competing with a row of buttons. Once it has focus, a draft, or a
/// turn to stop, an action row unfolds underneath: attach, dictate, dismiss the
/// keyboard, and the one send/stop button.
///
/// The draft, the caret and the focus flag are all the caller's: the `/command`
/// and `@file` picker is a screen-level overlay (`PromptSuggestionList`), and it
/// edits the same three things this does.
struct ComposerView: View {
  @Binding var text: String
  /// Caret in UTF-16 units — it decides which token is being completed and where
  /// an accepted suggestion lands.
  @Binding var selection: NSRange
  @Binding var isFocused: Bool
  let isBusy: Bool
  let isEnabled: Bool
  let onEdit: (String, NSRange) -> Void
  let onSend: () -> Void
  let onStop: () -> Void

  var body: some View {
    VStack(spacing: 6) {
      // At rest the field is the entire card: collapsed means no focus, no draft
      // and no turn running, so there is nothing a button could do here.
      field
      if isExpanded {
        actionRow
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 6)
    .glassPanel(cornerRadius: 24)
    .animation(.easeOut(duration: 0.18), value: isExpanded)
  }

  /// Expanded whenever there is something to act on: the keyboard is up, a draft
  /// is waiting, or a turn is running and stopping it must stay one tap away.
  private var isExpanded: Bool {
    isFocused || !text.isEmpty || isBusy
  }

  private var field: some View {
    ZStack(alignment: .topLeading) {
      if text.isEmpty {
        // Matched to `RichTextEditor`'s `textContainerInset`, so the placeholder
        // sits exactly where the first character will.
        Text("Message")
          .foregroundStyle(.tertiary)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .allowsHitTesting(false)
      }
      RichTextEditor(
        text: $text,
        selection: $selection,
        isFocused: $isFocused,
        isEnabled: isEnabled,
        onEdit: onEdit)
    }
  }

  /// Attach, dictate, dismiss — and send. The first two are placeholders for work
  /// that needs an upload path and a speech permission; they are shown disabled
  /// rather than hidden so the row's shape is the one it will keep.
  private var actionRow: some View {
    HStack(spacing: 8) {
      CircleButton(systemImage: "plus", label: "Add media") {}
        .disabled(true)
      if isFocused {
        CircleButton(systemImage: "keyboard.chevron.compact.down", label: "Hide keyboard") {
          dismissKeyboard()
        }
      }
      Spacer(minLength: 0)
      CircleButton(systemImage: "mic", label: "Dictate") {}
        .disabled(true)
      sendButton
    }
    .padding(.horizontal, 4)
    .padding(.bottom, 2)
  }

  /// One button, two jobs. A draft always sends — messages queue behind a running
  /// turn, and taking that away to make room for stop would be a downgrade. Stop
  /// takes the slot only while a turn is live *and* there is nothing to send.
  @ViewBuilder
  private var sendButton: some View {
    if isBusy, !canSend {
      Button(action: onStop) {
        Image(systemName: "stop.fill")
          .font(.footnote)
          .foregroundStyle(.white)
          .frame(width: 34, height: 34)
          .background(Color.red.opacity(0.85), in: Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop the current turn")
    } else {
      Button(action: onSend) {
        Image(systemName: "arrow.up")
          .font(.body.weight(.semibold))
          .foregroundStyle(canSend ? Color.white : Color.secondary)
          .frame(width: 34, height: 34)
          .background(canSend ? Color.accentColor : Color.secondary.opacity(0.2), in: Circle())
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("Send")
    }
  }

  private var canSend: Bool {
    isEnabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

/// The action row's shape: a glass circle around an SF Symbol.
///
/// `.plain` keeps the glass from being repainted by the button style, and takes
/// the automatic disabled dimming with it — hence the explicit opacity, which the
/// two stubs rely on to read as not-yet-wired rather than broken.
private struct CircleButton: View {
  let systemImage: String
  let label: String
  let action: () -> Void

  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .frame(width: 34, height: 34)
        .glassPill()
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .opacity(isEnabled ? 1 : 0.45)
    .accessibilityLabel(label)
  }
}
