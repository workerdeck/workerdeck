import WorkerDeckKit
import SwiftUI

/// The session's state as one glyph, mirroring the dashboard's
/// `SessionStatusIcon` — same vocabulary, same precedence.
///
/// A glyph rather than the labelled `StatusBadge` this row used to carry: a
/// badge spends a third of a line saying "Idle" for every idle session, and on a
/// list the state is the thing you scan *past* until it is not idle. Waiting on
/// a person still wins over everything, because that is the one state that is
/// about you.
///
/// **It takes the whole `SessionInfo` and asks `sessionState`, rather than a bare
/// status**, and the old signature is why: given only `(status, pendingCount)` it
/// was *unable* to be right. `sessionState` folds in the arm no glyph can see for
/// itself — a **background** sub-agent outlives its turn by design, so the turn
/// ends, `status` comes to rest at `.idle`, and the agent keeps working. Off the
/// raw status this drew a moon on a row filed under the "Working" header.
///
/// The terminal symbols still come off `session.status`, because `.ended`
/// collapses failed and closed into one bucket and those are worth telling apart.
struct SessionStatusIcon: View {
  let session: SessionInfo

  private var status: SessionStatus { session.status }
  private var pendingCount: Int { session.pendingPermissionCount }
  private var state: SessionState { sessionState(session) }

  var body: some View {
    icon
      .font(.caption)
      .accessibilityLabel(label)
  }

  @ViewBuilder
  private var icon: some View {
    if state == .attention {
      // The one state that is about the reader, so it is the one that moves.
      Image(systemName: "bell.badge.fill")
        .foregroundStyle(.orange)
        .symbolEffect(.pulse)
    } else if state == .working {
      // `text-info`, not the system's grey: working is the state the eye is
      // scanning for, and an untinted spinner is the quietest thing on the row.
      ProgressView()
        .controlSize(.mini)
        .tint(.blue)
    } else {
      Image(systemName: symbol)
        .foregroundStyle(tint)
    }
  }

  private var symbol: String {
    switch status {
    case .failed: return "exclamationmark.circle.fill"
    case .closed: return "slash.circle"
    case .parked: return "pause.circle.fill"
    default: return "moon.fill"
    }
  }

  // Parked is neutral, not purple: the dashboard spends no hue on it, and a
  // colour here says a parked session wants something when it wants nothing.
  private var tint: Color {
    switch status {
    case .failed: return .red
    default: return .secondary
    }
  }

  private var label: String {
    if pendingCount > 0, status == .awaitingApproval {
      return "\(status.label) (\(pendingCount))"
    }
    // A background agent working past its turn is the case the status cannot
    // name: "Idle" would be a lie to a screen reader too, not just to the eye.
    let running = runningSubagents(session).count
    if state == .working, status != .running, status != .starting, running > 0 {
      return "Working — \(running) sub-agent\(running == 1 ? "" : "s")"
    }
    return status.label
  }
}
