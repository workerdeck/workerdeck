import SwiftUI
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The docked approval or question, in the transcript's terminal vocabulary: the web's `TerminalPermissionPrompt` and
// `TerminalQuestionPrompt` with taps for keys. Numbered choice rows, a tab strip and a review step for questions.
struct CorePromptCard: View {
  let prompt: Prompt
  let planLines: [TranscriptLine]
  let model: CoreSessionModel
  @State private var denying = false
  @State private var reason = ""
  @State private var answers: [Selection] = []
  @State private var tab = 0
  @State private var command = ""
  @State private var secret = ""

  private let type = TerminalTypography.session

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header
        blank
        if prompt.kind == .question { questionBody } else { decisionBody }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxHeight: 320)
    .fixedSize(horizontal: false, vertical: true)
    .font(type.font)
    .lineSpacing(type.lineSpacing)
    .foregroundStyle(tone(.fg))
    .tint(tone(.blue))
    .onChange(of: prompt.requestId, initial: true) {
      command = prompt.proposal?.command ?? ""
      secret = ""
      answers = prompt.questions.map { _ in Selection(labels: [], other: "", otherActive: false) }
      tab = 0
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text(prompt.heading).bold().foregroundStyle(tone(.blue))
        Spacer(minLength: 8)
        if prompt.waiting > 1 { Text("+\(prompt.waiting - 1) waiting").foregroundStyle(tone(.faint)) }
      }
      if let subject = prompt.subject { Text(subject).foregroundStyle(tone(.dim)) }
    }
  }

  // MARK: - Approvals

  @ViewBuilder
  private var decisionBody: some View {
    if let proposal = prompt.proposal {
      proposalFields(proposal)
      blank
      DashedRule(color: tone(.faint)).frame(height: type.line)
    } else if !prompt.shellLines.isEmpty {
      ForEach(Array(prompt.shellLines.enumerated()), id: \.offset) { _, line in Text(line).bold() }
      blank
      DashedRule(color: tone(.faint)).frame(height: type.line)
    }
    if !planLines.isEmpty {
      ForEach(Array(planLines.enumerated()), id: \.offset) { _, line in Text(line.gutter + line.text) }
      blank
      DashedRule(color: tone(.faint)).frame(height: type.line)
    }
    if let description = prompt.description {
      Text(description).foregroundStyle(tone(.dim))
      blank
    }
    if let reason = prompt.decisionReason { Text(reason).foregroundStyle(tone(.faint)) }
    if !prompt.question.isEmpty { Text(prompt.question) }
    ForEach(Array(prompt.choices.enumerated()), id: \.offset) { index, choice in
      choiceRow(
        index, choice.option, danger: choice.danger,
        disabled: choice.key == .allow && prompt.proposal != nil
          && command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ) { choose(choice.key) }
      if choice.key == .deny, denying {
        inputRow(prompt.denyPlaceholder, text: $reason) { deny(interrupt: false) }
      }
    }
  }

  private func proposalFields(_ proposal: Proposal) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      TextField("Command", text: $command, axis: .vertical)
        .bold()
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .lineLimit(1...8)
        .padding(6)
        .background(TerminalPalette.band(.output), in: RoundedRectangle(cornerRadius: 4))
      if command != proposal.command {
        Button("Edited by you, tap to reset to the agent's command") { command = proposal.command }
          .buttonStyle(.plain)
          .foregroundStyle(tone(.yellow))
      }
      if proposal.secret {
        SecureField("Secret for stdin (hidden)", text: $secret)
          .textContentType(.password)
          .padding(6)
          .background(TerminalPalette.band(.output), in: RoundedRectangle(cornerRadius: 4))
        Text("Piped to the command's stdin; never shown to the agent or kept in the transcript.")
          .foregroundStyle(tone(.faint))
      }
      if proposal.noInput {
        Text("Takes no input: stdin is empty, so a prompt fails instead of waiting.").foregroundStyle(tone(.faint))
      }
    }
  }

  private func choose(_ key: ChoiceKey) {
    switch key {
    case .allow:
      if prompt.proposal != nil {
        model.runProposal(prompt.requestId, command: command, stdin: secret)
      } else {
        model.allow(prompt.requestId)
      }
    case .deny: denying.toggle()
    case .stop: deny(interrupt: true)
    }
  }

  private func deny(interrupt: Bool) {
    let message = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    model.deny(prompt.requestId, message: message.isEmpty ? nil : message, interrupt: interrupt)
  }

  // MARK: - Questions

  @ViewBuilder
  private var questionBody: some View {
    tabStrip
    blank
    if tab < prompt.questions.count, tab < answers.count {
      questionStep(prompt.questions[tab], index: tab)
    } else {
      reviewStep
    }
  }

  private var tabStrip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 0) {
        Text("← ").foregroundStyle(tone(.faint))
        ForEach(Array(prompt.questions.enumerated()), id: \.offset) { index, question in
          tabChip(index, "\(answered(index) ? "▣" : "▢") \(question.header.isEmpty ? "Question \(index + 1)" : question.header)")
        }
        tabChip(prompt.questions.count, "✓ Submit")
        Text(" →").foregroundStyle(tone(.faint))
      }
    }
  }

  private func tabChip(_ index: Int, _ label: String) -> some View {
    Button {
      tab = index
    } label: {
      Text(label)
        .padding(.horizontal, type.cell)
        .padding(.vertical, 3)
        .foregroundStyle(index == tab ? Color(uiColor: .systemBackground) : tone(.fg))
        .background(index == tab ? tone(.blue) : .clear)
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func questionStep(_ question: Question, index: Int) -> some View {
    let selection = answers[index]
    let multi = question.multiSelect
    Text(question.question).bold().foregroundStyle(tone(.bright))
    blank
    ForEach(Array(question.options.enumerated()), id: \.offset) { row, option in
      let picked = selection.labels.contains(option.label)
      choiceRow(
        row, option.label, checked: multi ? picked : nil, chosen: !multi && picked, description: option.description
      ) {
        answers[index] = toggleLabel(selection: answers[index], label: option.label, multiSelect: multi)
        if !multi { advance() }
      }
      if picked, let preview = option.preview { previewBox(preview) }
    }
    choiceRow(question.options.count, "Other…", checked: selection.otherActive) {
      answers[index] = toggleOther(selection: answers[index], multiSelect: multi)
    }
    if selection.otherActive {
      inputRow("Type your own answer", text: $answers[index].other) { advance() }
    }
    if multi { choiceRow(question.options.count + 1, "Submit") { advance() } }
    choiceRow(question.options.count + (multi ? 2 : 1), "Chat about this") {
      model.dismiss(prompt.requestId)
    }
  }

  @ViewBuilder
  private var reviewStep: some View {
    let complete = answers.indices.allSatisfy(answered)
    Text("Review your answers").bold().foregroundStyle(tone(.bright))
    blank
    ForEach(Array(prompt.questions.enumerated()), id: \.offset) { index, question in
      let answer = index < answers.count ? answerText(selection: answers[index]) : ""
      glyphRow("●", glyphTone: .dim, columns: 2) { Text(question.question) }
      glyphRow("→", glyphTone: .green, columns: 2, indent: 2) {
        Text(answer.isEmpty ? "not answered" : answer).foregroundStyle(tone(answer.isEmpty ? .faint : .green))
      }
    }
    blank
    Text(complete ? "Ready to submit your answers?" : "Some questions are unanswered.")
    choiceRow(0, complete ? "Submit answers" : "Submit anyway") { model.answer(prompt.requestId, answers) }
    choiceRow(1, "Cancel", danger: true) { model.dismiss(prompt.requestId) }
  }

  private func answered(_ index: Int) -> Bool {
    index < answers.count && !answerText(selection: answers[index]).isEmpty
  }

  private func advance() { tab = min(prompt.questions.count, tab + 1) }

  private func previewBox(_ preview: String) -> some View {
    Text(preview)
      .foregroundStyle(tone(.dim))
      .padding(6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(tone(.faint)))
      .padding(.leading, type.cell * 5)
      .padding(.vertical, 2)
  }

  // MARK: - Rows

  private var blank: some View { Color.clear.frame(height: type.line / 2) }

  private func tone(_ value: TermTone) -> Color { TerminalPalette.color(value) }

  private func glyphRow(
    _ glyph: String, glyphTone: TermTone, columns: Int, indent: Int = 0, @ViewBuilder content: () -> Text
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      Text(glyph).foregroundStyle(tone(glyphTone)).frame(width: type.cell * CGFloat(columns), alignment: .leading)
      content()
    }
    .padding(.leading, type.cell * CGFloat(indent))
  }

  // `checked` draws the `[ ]` marker (a multi-select option, Other); `chosen` is a single-select pick.
  private func choiceRow(
    _ index: Int, _ label: String, checked: Bool? = nil, chosen: Bool = false, danger: Bool = false,
    description: String? = nil, disabled: Bool = false, action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 0) {
        glyphRow("\(chosen ? "❯" : " ") \(index + 1).", glyphTone: chosen ? .fg : .faint, columns: 5) {
          let marker = checked.map { $0 ? "[✓] " : "[ ] " } ?? ""
          let labelTone: TermTone = danger ? .red : chosen ? .green : .fg
          return Text(
            "\(Text(marker).foregroundStyle(tone(checked == true ? .green : .faint)))\(Text(label).bold(chosen).foregroundStyle(tone(labelTone)))"
          )
        }
        if let description {
          Text(description).foregroundStyle(tone(.dim)).padding(.leading, type.cell * 5)
        }
      }
      .padding(.vertical, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .opacity(disabled ? 0.4 : 1)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
  }

  private func inputRow(_ placeholder: String, text: Binding<String>, submit: @escaping () -> Void) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      Text("   ›").foregroundStyle(tone(.dim)).frame(width: type.cell * 5, alignment: .leading)
      TextField(placeholder, text: text).submitLabel(.send).onSubmit(submit)
    }
    .padding(.vertical, 4)
  }
}

private struct DashedRule: View {
  let color: Color

  var body: some View {
    GeometryReader { geometry in
      Path { path in
        path.move(to: CGPoint(x: 0, y: geometry.size.height / 2))
        path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height / 2))
      }
      .stroke(color, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
    }
  }
}
