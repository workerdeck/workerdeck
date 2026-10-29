import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

// `StepRow`: one unfolded step inside its card, in the chip's colours; tapping opens it, a running shell or a stoppable
// task carries a stop button.
struct SessionStepRow: View {
  let step: ListStep
  var indent: CGFloat = 48
  let onOpen: () -> Void
  var onKill: (() -> Void)?

  static let height: CGFloat = 28

  private var tone: Color {
    if step.state == .failed { return ListPalette.danger }
    switch step.kind {
    case .shell: return ListPalette.shell
    case .agent: return ListPalette.success
    case .task: return step.state == .pending ? ListPalette.fg4 : ListPalette.fg2
    }
  }

  var body: some View {
    HStack(spacing: 0) {
      Button(action: onOpen) {
        HStack(spacing: 8) {
          icon
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(tone)
            .frame(width: 16)
          Text(step.label)
            .font(step.kind == .shell ? .system(size: 11, design: .monospaced) : ListType.micro())
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(tone)
          Spacer(minLength: 6)
          if let detail = step.detail {
            Text(detail)
              .font(ListType.micro().monospacedDigit())
              .foregroundStyle(ListPalette.fg4)
          }
        }
        .padding(.leading, indent)
        .frame(minHeight: Self.height)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(step.title)
      if let onKill {
        Button(action: onKill) {
          Image(systemName: "stop.circle")
            .font(.body)
            .frame(width: 32, height: Self.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .tint(.secondary)
        .accessibilityLabel(step.kind == .task ? "Stop \(step.label)" : "Kill \(step.label)")
      }
    }
  }

  @ViewBuilder
  private var icon: some View {
    if step.kind == .shell {
      Text(TerminalShell.glyph).font(.system(size: 11, weight: .semibold, design: .monospaced))
    } else {
      switch step.state {
      case .running: ProgressView().controlSize(.mini).tint(tone)
      case .failed: Image(systemName: "exclamationmark.circle")
      case .done: Image(systemName: "checkmark")
      case .pending: Image(systemName: "circle")
      }
    }
  }
}
