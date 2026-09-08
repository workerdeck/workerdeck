import WorkerDeckKit
import SwiftUI

/// One step under its session row: the state marker, the label, then its tool
/// count.
///
/// Its own view rather than a method on the list for the reason `SessionRowView`
/// is: it is the thing a UI preview has to be able to draw on its own (see
/// `UIPREVIEW=steps`, which is this app's answer to the dashboard's selection
/// stories), and a private `@ViewBuilder` cannot be handed to one.
///
/// **No trailing arrow**, where the web's `StepRow` draws one. Here every step
/// is a `NavigationLink` and the platform draws its own disclosure chevron; a
/// hand-drawn arrow would be a second, quieter chevron disagreeing with the
/// real one two points to its right.
///
/// Green means sub-agent across this product — the rule the transcript's own
/// Task row already follows (`TerminalPlanner`: `failed ? .red : .green`) — so
/// spending the accent on "running" here would say something different from the
/// transcript about the same agent. Failure still outranks it: an alarm is not
/// a category.
struct SessionStepRow: View {
  let step: Step

  private var body_: Color {
    step.state == .failed ? TerminalPalette.color(.red) : TerminalPalette.color(.green)
  }

  var body: some View {
    HStack(spacing: 6) {
      icon
        .font(.caption2)
        .foregroundStyle(body_)
        // 16pt, matching the header rows' glyph cells: the design's own fix was
        // removing the icons' inner padding, and a marker in a 12pt cell is the
        // same bug one line down.
        .frame(width: 16)
      Text(step.label)
        .font(.caption)
        .lineLimit(1)
        .truncationMode(.tail)
        .foregroundStyle(body_)
      Spacer(minLength: 6)
      // Zero draws nothing: `0` beside a thinking agent reads as a stall.
      if let detail = step.detail {
        Text(detail)
          .font(.caption2)
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(step.title)
  }

  @ViewBuilder
  private var icon: some View {
    switch step.state {
    // A spinner, the same marker the card's own status glyph uses for the same
    // fact. `circle.dotted` was static, so the one row that was still moving
    // was the only one that did not move.
    case .running: ProgressView().controlSize(.mini).tint(body_)
    case .failed: Image(systemName: "exclamationmark.circle")
    case .done: Image(systemName: "checkmark")
    }
  }
}
