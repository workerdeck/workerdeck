import SwiftUI
import WorkerDeckKit

/// "N new rows since you were last here — jump / dismiss", above the composer.
///
/// The mirror of the web `SessionPanel`'s catch-up bar, and it sits in the
/// floating stack rather than in the transcript for the reason every control
/// here does: a control that scrolls away is one the reader cannot use at the
/// moment they want it. The *seam* is in the transcript; this is the way back
/// to it.
///
/// One line, two words of action, and no icon button — the whole point of the
/// feature is that it costs the reader nothing to ignore. How long "away" was
/// is on the seam itself (`· last here 42m`), not here: the bar has one line
/// and the phone's is narrow enough that a second clause truncated the first.
struct CatchUpBar: View {
  let count: Int
  let onJump: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      Text(TermGlyph.recap)
        .foregroundStyle(.secondary)
      Text("\(count) new \(count == 1 ? "row" : "rows") since you were last here")
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button("jump", action: onJump)
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
      Button("dismiss", action: onDismiss)
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .contain)
  }
}

#Preview {
  VStack {
    CatchUpBar(count: 1, onJump: {}, onDismiss: {})
    CatchUpBar(count: 42, onJump: {}, onDismiss: {})
  }
  .padding()
}
