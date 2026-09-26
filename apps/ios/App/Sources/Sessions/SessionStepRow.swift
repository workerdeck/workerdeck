import WorkerDeckKit
import SwiftUI

/// One step under its session row: the state marker, the label, its tool count,
/// and - for a running shell or a task the engine can stop - a stop button.
///
/// Its own view rather than a method on the list so `UIPREVIEW=steps` can draw
/// it on its own.
///
/// **No trailing arrow**, where the web's `StepRow` draws one on agents. Here
/// every step is a `NavigationLink` and the platform draws its own disclosure
/// chevron; a hand-drawn arrow would be a second chevron beside the real one.
///
/// Colour is the kind: green is sub-agent across this product (the transcript's
/// Task row says the same), magenta is shell, and a task is plain text, because
/// a checklist line is the plan rather than a worker. Failure outranks all
/// three, and a pending task is dimmed.
struct SessionStepRow: View {
  let step: Step
  /// Stops a running shell or task. Nil draws no button.
  var onKill: (() -> Void)?

  /// Leading 40 puts the step's marker on the column the card's title starts
  /// at (16 row inset + 16 gutter + 8 gap), so steps read as the card's children.
  static let insets = EdgeInsets(top: 0, leading: 40, bottom: 0, trailing: 16)
  /// A step is a secondary line: the list's 44pt minimum made each one as tall
  /// as half a card. The list lowers its minimum to this (see
  /// `defaultMinListRowHeight`), and the stop button keeps its own full width.
  static let height: CGFloat = 30

  private var tone: Color {
    if step.state == .failed { return TerminalPalette.color(.red) }
    switch step.kind {
    case .shell: return TerminalPalette.color(.magenta)
    case .agent: return TerminalPalette.color(.green)
    case .task: return step.state == .pending ? Color(uiColor: .tertiaryLabel) : .secondary
    }
  }

  var body: some View {
    HStack(spacing: 8) {
      icon
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tone)
        .frame(width: 16)
      Text(step.label)
        .font(.footnote)
        .lineLimit(1)
        .truncationMode(.tail)
        .foregroundStyle(tone)
        .accessibilityLabel(step.title)
      Spacer(minLength: 6)
      // Zero draws nothing: `0` beside a thinking agent reads as a stall.
      if let detail = step.detail {
        Text(detail)
          .font(.caption.monospacedDigit())
          .foregroundStyle(.tertiary)
      }
      if let onKill {
        Button(action: onKill) {
          Image(systemName: "stop.circle")
            .font(.body)
            .frame(width: 32, height: Self.height)
            .contentShape(Rectangle())
        }
        // Borderless, so the list gives it a target of its own instead of
        // folding it into the row's navigation. Grey like the card's overflow:
        // the accent would read as a state.
        .buttonStyle(.borderless)
        .tint(.secondary)
        .accessibilityLabel(step.kind == .task ? "Stop \(step.label)" : "Kill \(step.label)")
      }
    }
    .frame(minHeight: Self.height)
  }

  @ViewBuilder
  private var icon: some View {
    // `$`, whatever the state: a shell's marker is what it is, and the state is
    // already carried by the colour and by the trailing reading.
    if step.kind == .shell {
      Text(TerminalShell.glyph).font(.caption.monospaced().weight(.semibold))
    } else {
      switch step.state {
      // A spinner, the same marker the card's own status glyph uses for the same
      // fact: the one row still moving should be the one that moves.
      case .running: ProgressView().controlSize(.mini).tint(tone)
      case .failed: Image(systemName: "exclamationmark.circle")
      case .done: Image(systemName: "checkmark")
      case .pending: Image(systemName: "circle")
      }
    }
  }
}

/// Every step under one card, as list rows. Shared by the list and
/// `UIPREVIEW=sessions`, so the preview draws what ships.
///
/// The card and its steps read as one block: no separator runs between them,
/// only under the last step (the card hides its own bottom one when it has
/// steps).
struct SessionStepRows: View {
  let row: SessionRow
  let steps: [Step]
  var onKill: (Step) -> (() -> Void)? = { _ in nil }

  var body: some View {
    ForEach(steps) { step in
      let route = UUID(uuidString: row.hostId).map {
        SessionRoute.step(hostId: $0, sessionId: row.info.id, step: step)
      }
      let label = SessionStepRow(step: step, onKill: onKill(step))
      Group {
        if let route {
          NavigationLink(value: route) { label }
        } else {
          label
        }
      }
      .listRowInsets(SessionStepRow.insets)
      // The block's closing rule starts where the cards' do, at the title.
      .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
      .listRowSeparator(.hidden, edges: .top)
      .listRowSeparator(step.id == steps.last?.id ? .automatic : .hidden, edges: .bottom)
    }
  }
}
