import WorkerDeckKit
import SwiftUI

/// The selected session's tasks — the engine's checklist and the `Task` spawns
/// that have no agent behind them.
///
/// This is where tasks live now. They used to hang under the session card
/// beside its sub-agents, where one count had to answer two questions and could
/// only answer one honestly; the card kept the list-level question (which
/// sub-agents are running) and tasks came here, to the session they belong to.
struct TasksSheet: View {
  let tasks: [SessionTask]
  /// Nil where the transcript cannot be travelled to — the cards renderer has no
  /// row model to land on, so a spawn is inert there rather than lying.
  let onReveal: ((String) -> Void)?

  @AppStorage("workerdeck.tasks.showCompleted") private var showCompleted = false
  @Environment(\.dismiss) private var dismiss

  private var count: TaskSummary { taskSummary(tasks) }
  private var shown: [SessionTask] { visibleTasks(tasks, showCompleted: showCompleted) }

  var body: some View {
    NavigationStack {
      Group {
        if shown.isEmpty {
          ContentUnavailableView {
            Label(tasks.isEmpty ? "No tasks yet" : "All done", systemImage: "checklist")
          } description: {
            Text(
              tasks.isEmpty
                ? "A checklist appears once the agent plans one."
                : "\(count.done) completed, hidden by the filter.")
          }
        } else {
          List {
            Section {
              ForEach(shown) { task in
                TaskRow(task: task, onReveal: onReveal.map { reveal in { dismiss(); reveal($0) } })
              }
            } footer: {
              Text(
                count.failed > 0
                  ? "\(count.done) of \(count.total) done · \(count.failed) failed"
                  : "\(count.done) of \(count.total) done")
            }
          }
        }
      }
      .navigationTitle("Tasks")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if count.done > 0 {
          ToolbarItem(placement: .topBarLeading) {
            Button(showCompleted ? "Hide Completed" : "Show Completed") {
              showCompleted.toggle()
            }
            .font(.callout)
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

private struct TaskRow: View {
  let task: SessionTask
  let onReveal: ((String) -> Void)?

  private var pressable: Bool { onReveal != nil && task.toolUseId != nil }

  var body: some View {
    if pressable, let toolUseId = task.toolUseId, let onReveal {
      Button { onReveal(toolUseId) } label: { body(chevron: true) }
        .buttonStyle(.plain)
    } else {
      body(chevron: false)
    }
  }

  @ViewBuilder private func body(chevron: Bool) -> some View {
    HStack(spacing: 8) {
      TaskGlyph(state: task.state)
      Text(task.label)
        .font(.callout)
        .strikethrough(task.state == .done)
        .foregroundStyle(task.state == .done ? .secondary : .primary)
        .lineLimit(3)
      Spacer(minLength: 4)
      if let detail = task.detail {
        Text(detail)
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
      if chevron {
        Image(systemName: "chevron.right")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
    }
  }
}

private struct TaskGlyph: View {
  let state: SessionTask.State

  var body: some View {
    switch state {
    case .running:
      ProgressView().controlSize(.mini)
    case .failed:
      Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
    case .done:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(.secondary)
    case .pending:
      Image(systemName: "circle").foregroundStyle(.tertiary)
    }
  }
}
