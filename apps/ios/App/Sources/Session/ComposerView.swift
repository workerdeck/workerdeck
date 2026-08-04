import WorkerDeckKit
import SwiftUI

/// The input bar: a growing text field, plus send — or stop while a turn is live.
/// With a `completion` it also offers `@file` suggestions from the session's
/// working directory, listed above the field.
struct ComposerView: View {
  @Binding var text: String
  let isBusy: Bool
  let isEnabled: Bool
  /// Absent when the session's cwd isn't known yet — completion simply doesn't run.
  let completion: FileCompletionModel?
  let onSend: () -> Void
  let onStop: () -> Void

  @FocusState private var isFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      if let completion, completion.isActive, !completion.matches.isEmpty {
        suggestions(completion)
      }
      inputBar
    }
    .onChange(of: text) { _, next in completion?.update(for: next) }
  }

  private func suggestions(_ completion: FileCompletionModel) -> some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(completion.matches) { match in
          Button {
            text = completion.accept(match, in: text)
          } label: {
            HStack(spacing: 8) {
              Image(systemName: "doc")
                .font(.caption)
                .foregroundStyle(.secondary)
              // The filename is what you scan for; the folder is how you tell two
              // of them apart.
              Text(Fmt.lastComponent(match.relative))
                .font(.callout)
              Text(match.relative)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          Divider().padding(.leading, 14)
        }
      }
    }
    // Tall enough for a few rows, short enough to leave the transcript in view.
    .frame(maxHeight: 190)
    .background(.bar)
  }

  private var inputBar: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("Message", text: $text, axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.plain)
        .focused($isFocused)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
        .disabled(!isEnabled)

      if isBusy {
        Button(action: onStop) {
          Image(systemName: "stop.fill")
            .font(.body)
            .frame(width: 34, height: 34)
            .background(Color.secondary.opacity(0.18), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop the current turn")
      }

      Button {
        // A half-typed @token is not a completion the user declined; sending
        // closes the list either way.
        completion?.cancel()
        onSend()
        // Keep the keyboard up: a remote control is used in bursts.
        isFocused = true
      } label: {
        Image(systemName: "arrow.up")
          .font(.body.weight(.semibold))
          .foregroundStyle(.white)
          .frame(width: 34, height: 34)
          .background(canSend ? Color.accentColor : Color.secondary.opacity(0.35), in: Circle())
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("Send")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.bar)
  }

  private var canSend: Bool {
    isEnabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}
