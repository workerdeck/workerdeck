import WorkerDeckKit
import SwiftUI

/// What is waiting for the turn to end, above the composer — the mirror of the
/// web `ui` package's `HeldSendsBar` (`packages/ui/src/components/agent/held-sends.tsx`).
///
/// One line, and only when there is something in it: the queue is a
/// consequence of a preference the reader set, not news, so it says how many
/// and what the last one was and offers the one action that overrides it.
struct HeldSendsBar: View {
  let summary: String
  let onSendNow: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "clock")
        .imageScale(.small)
      Text(summary)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button("Send now", action: onSendNow)
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
  }
}
