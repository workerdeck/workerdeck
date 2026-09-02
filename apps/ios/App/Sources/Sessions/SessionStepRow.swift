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
/// **One row shape, both kinds.** What a press means is the list's business —
/// an agent opens its own takeover, a task opens the session and travels to
/// that call's row — and it is expressed as two payloads on one `SessionRoute`
/// case, never as a variant branch inside here. That rule is why the deleted
/// `lines` renderer took fifteen view bodies with it.
///
/// **No trailing arrow**, where the web's `StepRow` draws one on agents. There,
/// the arrow says "this one opens something" and is the only thing that could;
/// here every step is a `NavigationLink` and the platform draws its own
/// disclosure chevron on all of them, which is the truth — both kinds push now.
/// A hand-drawn arrow on agents only would be a second, quieter chevron
/// disagreeing with the real one two points to its right.
///
/// Body colour by **kind**, the beat carried by the marker — the rule the
/// transcript's own Task row already follows (`TerminalPlanner`: `failed ? .red
/// : .green`). Green means sub-agent across this product, so a list that spent
/// the accent on "running" here would be saying something different from the
/// transcript about the same agent. Failure still outranks kind: an alarm is not
/// a category.
struct SessionStepRow: View {
  let step: Step

  private var body_: Color {
    if step.state == .failed { return TerminalPalette.color(.red) }
    return step.kind == .agent ? TerminalPalette.color(.green) : .secondary
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

  /// A task that is neither running nor failed gets a neutral dot rather than a
  /// tick: `done` is a claim about work, and nothing here did any. `pending` has
  /// no sub-agent that can produce it and is drawn anyway — the checklist source
  /// this shape was built for is queued for most of its life, and an unhandled
  /// arm is exactly how a failed agent came to draw a checkmark.
  @ViewBuilder
  private var icon: some View {
    if step.kind == .task, step.state != .running, step.state != .failed {
      Image(systemName: "circle.fill").font(.system(size: 5))
    } else {
      switch step.state {
      // A spinner, the same marker the card's own status glyph uses for the same
      // fact. `circle.dotted` was static, so the one row that was still moving
      // was the only one that did not move.
      case .running: ProgressView().controlSize(.mini).tint(body_)
      case .failed: Image(systemName: "exclamationmark.circle")
      case .pending: Image(systemName: "pause.circle")
      case .done: Image(systemName: "checkmark")
      }
    }
  }
}
