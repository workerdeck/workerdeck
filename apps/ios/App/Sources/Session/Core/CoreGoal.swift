import SwiftUI
@preconcurrency import WorkerDeckSession

struct CoreGoalRequest: Identifiable {
  let id = UUID()
  let goals: GoalCapabilities
  let replacing: GoalView?
  let conversation: Int64
}

struct CoreGoalMenu: View {
  let chrome: SessionChrome
  let goals: GoalCapabilities
  let onSet: () -> Void
  let onPause: (Bool) -> Void
  let onClear: () -> Void

  var body: some View {
    let goal = chrome.goal
    Button(goal.map { $0.state != .met } == true ? "Replace goal…" : "Set goal…", systemImage: "target", action: onSet)
    if goals.pause, let state = goal?.state, state == .active || state == .paused {
      Button(
        state == .active ? "Pause goal" : "Resume goal", systemImage: state == .active ? "pause" : "play"
      ) { onPause(state == .active) }
    }
    if goal != nil {
      Button("Clear goal", systemImage: "xmark.circle", action: onClear)
    }
  }
}

struct CoreGoalSheet: View {
  let request: CoreGoalRequest
  let sessionId: String
  let onSend: (HttpCall) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var text: String
  @State private var budget: String
  @State private var refusal: String?
  @FocusState private var focused: Bool

  init(request: CoreGoalRequest, sessionId: String, onSend: @escaping (HttpCall) -> Void) {
    self.request = request
    self.sessionId = sessionId
    self.onSend = onSend
    _text = State(initialValue: request.replacing?.text ?? "")
    _budget = State(initialValue: request.replacing?.tokenBudget.map(String.init) ?? "")
  }

  private var title: String { request.replacing == nil ? "Set goal" : "Replace goal" }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("When is the work done? e.g. all tests in packages/core pass", text: $text, axis: .vertical)
            .lineLimit(4...12)
            .autocorrectionDisabled()
            .focused($focused)
            .accessibilityIdentifier("goal-text")
            .onChange(of: text) { _, next in
              refusal = nil
              let max = Int(goalTextMax())
              if next.utf16.count > max {
                var clipped = next
                while clipped.utf16.count > max { clipped.removeLast() }
                text = clipped
              }
            }
        } footer: {
          Text(
            request.goals.budget
              ? "The agent keeps working, turn after turn, until the goal is met. The engine stops at the token budget."
              : "The agent keeps working, turn after turn, until the goal is met. Each turn ends with a check against it.")
        }
        if request.goals.budget {
          Section("Token budget") {
            TextField("No budget", text: $budget)
              .keyboardType(.numberPad)
              .accessibilityIdentifier("goal-budget")
              .onChange(of: budget) { _, next in
                refusal = nil
                let digits = next.filter { $0.isASCII && $0.isNumber }
                if digits != next { budget = digits }
              }
          }
        }
        if let refusal {
          Section {
            Text(refusal)
              .font(.footnote)
              .foregroundStyle(.red)
              .accessibilityIdentifier("goal-refusal")
          }
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(request.replacing == nil ? "Set" : "Replace", action: submit)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .onAppear { focused = true }
    }
  }

  private func submit() {
    switch setGoalCall(
      id: sessionId, text: text, budgetField: budget, shownBudget: request.replacing?.tokenBudget, goals: request.goals,
      generation: request.conversation)
    {
    case .refused(let message):
      refusal = message
    case .send(let call):
      onSend(call)
      dismiss()
    }
  }
}

struct CoreGoalRows: View {
  let goal: GoalView

  var body: some View {
    Section {
      block("Goal", goal.text, .primary)
      LabeledContent("Goal state", value: goal.stateText)
      LabeledContent("Set by", value: "\(goal.setBy), \(setAgo)")
      if let checks = goal.checks, checks > 0 {
        LabeledContent("Checks not met", value: String(checks))
      }
      if let reason = goal.lastReason, !reason.isEmpty {
        block("Last reason", reason, .secondary)
      }
      if let tokens = goal.tokensText {
        LabeledContent("Goal tokens") { Text(tokens).monospacedDigit() }
      }
      if let time = goal.timeText {
        LabeledContent("Goal time", value: time)
      }
    } footer: {
      if goal.holdsEngine { Text(goalHoldsEngineHint()) }
    }
  }

  private var setAgo: String {
    let text = ago(epochMs: Double(goal.setAt), nowMs: Date().timeIntervalSince1970 * 1000)
    return text == "just now" ? text : "\(text) ago"
  }

  private func block(_ label: String, _ value: String, _ tone: HierarchicalShapeStyle) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.caption)
        .foregroundStyle(.secondary)
      Text(value)
        .foregroundStyle(tone)
        .textSelection(.enabled)
    }
  }
}
