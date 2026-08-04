import WorkerDeckKit
import SwiftUI

/// Interactive form for the `AskUserQuestion` tool.
///
/// Answering is an *allow* with a rewritten input: the original input plus an
/// `answers` map keyed by question text, each value the chosen label (multi-select
/// comma-joined) — the shape the CLI expects, mirroring the web dashboard's
/// `QuestionPrompt`. The first option is the model's recommended one and is
/// pre-selected for single-choice questions.
struct QuestionPromptView: View {
  let request: PermissionRequest
  let questions: [UserQuestion]
  let onAnswer: ([String: JSONValue]) -> Void
  let onDismiss: () -> Void

  /// Chosen labels per question index. A set, because multi-select questions can
  /// hold several and single-select is just the one-element case.
  @State private var selections: [Int: [String]] = [:]

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "questionmark.bubble.fill")
          .foregroundStyle(.blue)
        Text(request.title ?? "The agent has a question")
          .font(.subheadline.weight(.semibold))
        Spacer(minLength: 0)
        Button {
          onDismiss()
        } label: {
          Image(systemName: "xmark")
            .font(.caption.weight(.semibold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Dismiss question")
      }

      ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
        questionBlock(index: index, question: question)
      }

      if isMultiStep {
        Button("Answer") { submit() }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .disabled(!isComplete)
      }
    }
    .padding(12)
    .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.blue.opacity(0.3)))
    .onAppear(perform: preselectRecommended)
  }

  // MARK: - Pieces

  @ViewBuilder
  private func questionBlock(index: Int, question: UserQuestion) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if !question.header.isEmpty {
        Text(question.header.uppercased())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      Text(question.question)
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)

      ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
        optionButton(
          index: index, question: question, option: option, isRecommended: optionIndex == 0)
      }
    }
  }

  private func optionButton(
    index: Int, question: UserQuestion, option: UserQuestionOption, isRecommended: Bool
  ) -> some View {
    let isSelected = (selections[index] ?? []).contains(option.label)
    let isMulti = question.multiSelect == true
    return Button {
      toggle(index: index, label: option.label, multiSelect: isMulti)
      // Single-select with one question: the tap is the whole answer, so send it.
      if !isMulti, !isMultiStep { submit(overriding: index, with: [option.label]) }
    } label: {
      HStack(alignment: .top, spacing: 8) {
        Image(
          systemName: isMulti
            ? (isSelected ? "checkmark.square.fill" : "square")
            : (isSelected ? "largecircle.fill.circle" : "circle")
        )
        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(option.label)
              .font(.callout.weight(.medium))
              .multilineTextAlignment(.leading)
            if isRecommended {
              Text("recommended")
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
          }
          if let description = option.description, !description.isEmpty {
            Text(description)
              .font(.caption)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.leading)
          }
          if isSelected, let preview = option.preview, !preview.isEmpty {
            Text(preview)
              .font(.caption2.monospaced())
              .foregroundStyle(.secondary)
              .lineLimit(6)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 6)
      .padding(.horizontal, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 8)
          .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  // MARK: - Selection

  /// A confirm button only makes sense when a single tap can't finish the job:
  /// several questions, or any multi-select among them.
  private var isMultiStep: Bool {
    questions.count > 1 || questions.contains { $0.multiSelect == true }
  }

  private var isComplete: Bool {
    questions.indices.allSatisfy { !(selections[$0] ?? []).isEmpty }
  }

  private func preselectRecommended() {
    guard selections.isEmpty else { return }
    for (index, question) in questions.enumerated()
    where question.multiSelect != true && questions.count > 1 {
      if let first = question.options.first { selections[index] = [first.label] }
    }
  }

  private func toggle(index: Int, label: String, multiSelect: Bool) {
    var current = selections[index] ?? []
    if multiSelect {
      if let existing = current.firstIndex(of: label) {
        current.remove(at: existing)
      } else {
        current.append(label)
      }
    } else {
      current = current == [label] ? [] : [label]
    }
    selections[index] = current
  }

  private func submit(overriding index: Int? = nil, with labels: [String]? = nil) {
    var answers: [String: JSONValue] = [:]
    for (position, question) in questions.enumerated() {
      let chosen = (position == index ? labels : selections[position]) ?? []
      answers[question.question] = .string(chosen.joined(separator: ", "))
    }
    // Rewrite the tool's input rather than replace it: the CLI reads `answers`
    // alongside the questions it originally sent.
    var input = request.input.objectValue ?? [:]
    input["answers"] = .object(answers)
    onAnswer(input)
  }
}

/// Well-formed questions from an `AskUserQuestion` request, or `[]` when the input
/// isn't the shape this UI can render (fall back to the generic prompt then).
func parseUserQuestions(_ request: PermissionRequest) -> [UserQuestion] {
  guard request.toolName == "AskUserQuestion",
    let input = try? request.input.decoded(as: UserQuestionInput.self)
  else { return [] }
  return input.questions.filter { !$0.options.isEmpty }
}
