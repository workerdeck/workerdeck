import WorkerDeckKit
import SwiftUI

/// The input card: a glass shell around a growing rich-text field.
///
/// It has two shapes. At rest it is the field and nothing else, so a session being
/// read is not competing with a row of buttons. Once it has focus, a draft, or a
/// turn to stop, an action row unfolds underneath: attach on the left, dismiss the
/// keyboard and the one send/stop button on the right.
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
  /// Files staged for the next message. Owned by the session view, because they
  /// outlive the composer's focus and are cleared on send.
  let attachments: ComposerAttachmentStore
  /// Whether the engine takes attachments at all (`capabilities.attachments`
  /// non-empty). False hides the plus button — an attach affordance the engine
  /// has no meaning for is not a choice.
  let canAddMedia: Bool
  let onEdit: (String, NSRange) -> Void
  let onSend: () -> Void
  let onStop: () -> Void
  let onAddMedia: () -> Void

  var body: some View {
    VStack(spacing: 6) {
      // Above the field, like the picture you are talking about should be.
      if !attachments.isEmpty {
        AttachmentStrip(store: attachments)
      }
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
  /// is waiting, a photo is staged, or a turn is running and stopping it must stay
  /// one tap away.
  private var isExpanded: Bool {
    isFocused || !text.isEmpty || isBusy || !attachments.isEmpty
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

  /// Attach on the left; dismiss and send on the right. There is deliberately no
  /// dictate button — iOS puts a microphone on the keyboard itself, right where a
  /// thumb already is, and a second one here would only compete with it.
  private var actionRow: some View {
    HStack(spacing: 8) {
      if canAddMedia {
        CircleButton(systemImage: "plus", label: "Add media", action: onAddMedia)
          .disabled(!isEnabled)
      }
      Spacer(minLength: 0)
      if isFocused {
        CircleButton(systemImage: "keyboard.chevron.compact.down", label: "Hide keyboard") {
          dismissKeyboard()
        }
      }
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

  /// A photo on its own is a message — the send button does not wait for text.
  /// It does wait for the upload, so an id that hasn't landed can't be named.
  private var canSend: Bool {
    guard isEnabled, !attachments.isUploading, !attachments.hasFailure else { return false }
    return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
  }
}

/// The action row's shape: a glass circle around an SF Symbol.
///
/// `.plain` keeps the glass from being repainted by the button style, and takes
/// the automatic disabled dimming with it — hence the explicit opacity, so a
/// closed session's buttons read as unavailable rather than broken.
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

/// The staged files, as a scrolling row of chips above the field.
///
/// Each chip shows the thumbnail the phone already has, so nothing here waits on
/// the network; the upload's state rides on top of it (a spinner while in flight,
/// a warning badge if the gateway refused it) and the ✕ takes it back off.
private struct AttachmentStrip: View {
  let store: ComposerAttachmentStore

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(store.items) { item in
          AttachmentChip(item: item, onRetry: { store.retry(item) }, onRemove: { store.remove(item) })
        }
      }
      .padding(.horizontal, 6)
      .padding(.top, 2)
    }
    .frame(height: 62)
  }
}

private struct AttachmentChip: View {
  let item: ComposerAttachment
  let onRetry: () -> Void
  let onRemove: () -> Void

  var body: some View {
    ZStack(alignment: .topTrailing) {
      content
        .frame(width: 54, height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.25)))
        .overlay(alignment: .center) { statusOverlay }
        // Tap to retry, and only when there is something to retry.
        .onTapGesture { if item.failure != nil { onRetry() } }
      Button(action: onRemove) {
        Image(systemName: "xmark.circle.fill")
          .font(.footnote)
          .symbolRenderingMode(.palette)
          .foregroundStyle(Color.white, Color.black.opacity(0.55))
      }
      .buttonStyle(.plain)
      .offset(x: 5, y: -5)
      .accessibilityLabel("Remove \(item.name)")
    }
    .padding(.top, 5)
    .padding(.trailing, 5)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(item.failure.map { "\(item.name), failed: \($0). Tap to retry." } ?? item.name)
  }

  @ViewBuilder
  private var content: some View {
    if let thumbnail = item.thumbnail {
      Image(uiImage: thumbnail)
        .resizable()
        .scaledToFill()
    } else {
      VStack(spacing: 2) {
        Image(systemName: "doc")
          .font(.footnote)
        Text(fileExtension)
          .font(.system(size: 9, weight: .semibold))
          .lineLimit(1)
      }
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.secondary.opacity(0.16))
    }
  }

  @ViewBuilder
  private var statusOverlay: some View {
    switch item.state {
    case .uploading:
      ZStack {
        Color.black.opacity(0.35)
        ProgressView().controlSize(.small).tint(.white)
      }
    case .failed:
      ZStack {
        Color.black.opacity(0.45)
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.footnote)
          .foregroundStyle(.orange)
      }
    case .ready:
      EmptyView()
    }
  }

  private var fileExtension: String {
    let ext = (item.name as NSString).pathExtension.uppercased()
    return ext.isEmpty ? "FILE" : ext
  }
}
