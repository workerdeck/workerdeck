import SwiftUI
import WorkerDeckKit

/// The approval and question prompts, in the terminal theme's own shape — and
/// the fix for the thing that made them unusable.
///
/// **The bug first, because it is the reason this file exists.** Both prompts
/// live in the footer, which is a `safeAreaInset(edge: .bottom)`, and a safe-area
/// inset is sized to its content and given no scrolling of its own. A prompt
/// taller than the screen therefore did not scroll and did not shrink: it pushed
/// its own action row off the bottom edge, where nothing could reach it. On a
/// long question — several options, each with a description — the *only* way to
/// answer was to not have asked. Every clipping fix in the old views made this
/// worse rather than better: `lineLimit(2)` on the tool summary and
/// `lineLimit(6)` on an option's preview hid the very text you needed in order
/// to choose, and neither one bounded the total height, so a prompt with six
/// options still ran off the screen with all six truncated.
///
/// So the shape here is **a capped, scrolling body with the actions pinned under
/// it**. Two rules follow from that and both are load-bearing:
///
/// - The **body scrolls, the actions do not**. Whatever the question's length,
///   the thing that ends the prompt is on screen. This is the whole fix; the cap
///   and the scroll are just how it is achieved.
/// - The cap is a fraction of the *container*, not a constant. A constant that
///   fits an iPhone SE wastes half a Pro Max, and one tuned for a Pro Max is the
///   original bug on an SE. `promptMaxHeight` is measured, and the composer
///   below is deliberately left outside the cap — a prompt may take most of the
///   screen, never all of it, because a session you cannot type into while
///   deciding is a session you have to answer blind.
///
/// **Nothing is truncated any more.** Descriptions, previews and summaries are
/// shown whole, because the scroll is now the thing that bounds the height and a
/// line limit on top of it would only hide text the reader can already reach.
///
/// The theme is the CLI's, ported from `packages/ui/src/components/terminal`:
/// a rule, the engine's own sentence, what it is about, the question, and
/// numbered answers. The numbering stays as **structure** — it is how the CLI
/// says "these are the alternatives, and there are three" — but the web's
/// `1–3 to choose · Esc to cancel` hint line does not, because there is no
/// keyboard here to press and a hint naming keys that do not exist is worse than
/// silence.
// MARK: - Chrome

/// The docked strip both prompts wear: opaque, edge to edge, ruled top and
/// bottom — the composer's own frame, one band up. It is not a card and must not
/// become one: this theme has no boxes in it, and a rounded tinted rectangle
/// floating over a monospace transcript is the Cards prompt with a different
/// font.
private struct TerminalPromptSurface<Body: View, Actions: View>: View {
  /// The tone that says what kind of prompt this is — yellow for "waiting on
  /// you", blue for a question. It colours the rules and the title's marker
  /// only; the body stays the transcript's own text colour, because a wall of
  /// tinted prose is a wall of prose you read more slowly.
  let tint: Color
  let maxBodyHeight: CGFloat
  @ViewBuilder var content: Body
  @ViewBuilder var actions: Actions

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      PromptBodyScroll(maxHeight: maxBodyHeight) { content }
      actions
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 8)
    .background(Color(.systemBackground))
    .overlay(alignment: .top) { rule }
    .overlay(alignment: .bottom) { rule }
  }

  private var rule: some View {
    Rectangle().fill(tint.opacity(0.5)).frame(height: 0.5)
  }
}

/// One line of the prompt, on the grid: a gutter cell and a body, which is what
/// gives every wrapped line its hanging indent — the same two-cell shape
/// `TerminalRowCell` draws the transcript with.
private struct PromptRow<Content: View>: View {
  var glyph: String = " "
  var tone: TermTone = .fg
  @ViewBuilder var content: Content

  private var typography: TerminalTypography { .session }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      Text(glyph)
        .font(Font(typography.uiFont))
        .foregroundStyle(TerminalPalette.color(tone))
        .frame(width: typography.cell * 2, alignment: .leading)
      content
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// Body text on the grid. `fixedSize` vertically is what stops SwiftUI from
/// deciding on the reader's behalf that four lines is enough — the scroll is the
/// height bound now, and this must be free to be as tall as the text is.
private struct PromptText: View {
  let text: String
  var tone: TermTone = .fg
  var weight: Font.Weight = .regular

  private var typography: TerminalTypography { .session }

  var body: some View {
    Text(text)
      .font(Font(typography.uiFont).weight(weight))
      .foregroundStyle(TerminalPalette.color(tone))
      .lineSpacing(typography.lineSpacing)
      .fixedSize(horizontal: false, vertical: true)
      .multilineTextAlignment(.leading)
  }
}

/// A numbered alternative. The number is the CLI's structure — "these are the
/// three answers" — not an instruction to press anything, so it is drawn in the
/// gutter cell where every other marker lives rather than announced in a hint.
private struct PromptChoice: View {
  let index: Int
  let label: String
  var detail: String?
  var preview: String?
  var selected: Bool
  var multi: Bool
  var danger: Bool = false
  let action: () -> Void

  private var typography: TerminalTypography { .session }

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 0) {
        PromptRow(glyph: marker, tone: selected ? .blue : .faint) {
          PromptText(
            text: label, tone: danger ? .red : (selected ? .bright : .fg),
            weight: selected ? .semibold : .regular)
        }
        if let detail, !detail.isEmpty {
          PromptRow { PromptText(text: detail, tone: .dim) }
        }
        // Only under the option it belongs to, and only once chosen: a preview
        // is why you would pick this one, and three of them at once is the wall
        // of text the scroll exists to survive rather than to justify.
        if selected, let preview, !preview.isEmpty {
          PromptRow { PromptText(text: preview, tone: .faint) }
        }
      }
      .padding(.vertical, 2)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selected ? TerminalPalette.openWash : .clear)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  /// The number while unchosen, a mark once chosen — so the column reads as a
  /// list of alternatives before you answer and as your answer afterwards.
  /// Multi-select keeps its number visible in neither state for the same reason
  /// a checkbox does not need one: what matters there is which are in.
  private var marker: String {
    if multi { return selected ? "◆" : "◇" }
    return selected ? "●" : "\(index + 1)"
  }
}

/// The action row, pinned below the scroll. Characters, not SF Symbols, and one
/// rule above it — the composer's vocabulary, so the two strips read as one
/// piece of chrome stacked twice.
private struct PromptActions<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      Rectangle().fill(Color.primary.opacity(0.12)).frame(height: 0.5)
        .padding(.bottom, 8)
      HStack(spacing: 8) { content }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.top, 8)
  }
}

private struct PromptButton: View {
  let title: String
  var tone: TermTone = .fg
  var prominent: Bool = false
  var enabled: Bool = true
  let action: () -> Void

  private var typography: TerminalTypography { .session }

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(Font(typography.uiFont).weight(prominent ? .semibold : .regular))
        .foregroundStyle(TerminalPalette.color(enabled ? tone : .faint))
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(
          Rectangle()
            .fill(prominent && enabled ? TerminalPalette.color(tone).opacity(0.14) : .clear))
        .overlay(
          Rectangle()
            .strokeBorder(
              TerminalPalette.color(enabled ? tone : .faint).opacity(0.35), lineWidth: 0.5))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
  }
}

// MARK: - Permission

/// The approval, as the CLI draws it: the engine's own sentence, what it is
/// about, the question, and three numbered answers.
///
/// Three outcomes rather than two, and the middle one is the interesting one:
/// denying usually means "not that, try something else", so plain deny lets the
/// turn continue and carries a reason back to the agent, while the third also
/// stops the turn.
///
/// The heading is `displayName` over `title` for the reason the web states: for
/// codex an approval is an *escalation after a sandbox refusal*, and the runner
/// has already written the sentence that says so — composing "wants to use
/// {tool}" here would overwrite it with something less true.
struct TerminalPermissionPromptView: View {
  let request: PermissionRequest
  let maxBodyHeight: CGFloat
  let onAllow: () -> Void
  let onDeny: (_ message: String?, _ interrupt: Bool) -> Void

  @State private var denying = false
  @State private var reason = ""

  var body: some View {
    TerminalPromptSurface(tint: TerminalPalette.color(.yellow), maxBodyHeight: maxBodyHeight) {
      VStack(alignment: .leading, spacing: 0) {
        PromptRow(glyph: TermGlyph.notice, tone: .yellow) {
          PromptText(text: heading, tone: .bright, weight: .semibold)
        }
        if let subject, !subject.isEmpty {
          PromptRow { PromptText(text: subject, tone: .dim) }
        }
        if let description = request.description, !description.isEmpty {
          PromptRow { PromptText(text: description, tone: .dim) }
        }
        if let why = request.decisionReason, !why.isEmpty {
          PromptRow { PromptText(text: why, tone: .faint) }
        }
        Spacer().frame(height: 8)
        PromptRow { PromptText(text: request.title ?? "Do you want to proceed?") }
        PromptChoice(
          index: 0, label: "Yes", selected: false, multi: false, action: onAllow)
        PromptChoice(
          index: 1, label: "No, and tell the agent what to do differently",
          selected: denying, multi: false
        ) {
          denying.toggle()
        }
        if denying {
          PromptRow {
            TextField("Reason (optional)", text: $reason, axis: .vertical)
              .textFieldStyle(.plain)
              .font(Font(typography.uiFont))
              .foregroundStyle(TerminalPalette.color(.fg))
              .submitLabel(.send)
          }
        }
        PromptChoice(
          index: 2, label: "No, and stop the turn", selected: false, multi: false, danger: true
        ) {
          onDeny(nil, true)
        }
      }
    } actions: {
      PromptActions {
        if denying {
          PromptButton(title: "Deny", tone: .yellow, prominent: true) {
            let message = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            onDeny(message.isEmpty ? nil : message, false)
            reason = ""
            denying = false
          }
          PromptButton(title: "Cancel", tone: .dim) { denying = false }
        } else {
          PromptButton(title: "Allow", tone: .green, prominent: true, action: onAllow)
          PromptButton(title: "Deny", tone: .yellow) { denying = true }
          Spacer(minLength: 0)
          PromptButton(title: "Deny & stop", tone: .red) { onDeny(nil, true) }
        }
      }
    }
  }

  private var typography: TerminalTypography { .session }

  private var heading: String {
    request.displayName ?? request.title ?? "Permission needed"
  }

  /// What the approval is *about*. For a Bash call that is the command itself,
  /// which is the only thing a reader actually needs, and it is shown whole —
  /// this is the string the old view clipped at two lines.
  private var subject: String? {
    request.input.toolInputSubject(toolName: request.toolName)
  }
}

// MARK: - Question

/// The `AskUserQuestion` form, in the CLI's shape: **one question at a time**,
/// behind a strip of chips, ending in a review step.
///
/// The Cards version stacks every question on screen at once, which is right for
/// a dialog and wrong here — and on a phone it is the thing that made the prompt
/// unanswerable, since three questions with four described options each is a
/// screen and a half before a single tap. One at a time is bounded by
/// construction, and the chips are what say that answering the first of three is
/// not finishing.
///
/// The review step is the other half. Answers given one screen at a time are
/// answers you cannot see together, so the last chip shows all of them and asks
/// once more before they go back to the model.
///
/// The web's keyboard vocabulary is deliberately *not* ported. `↑/↓ to navigate`
/// and `1–3 to choose` exist because a terminal form is answered with the keys;
/// here it is answered with a finger, so the numbering survives as structure and
/// the hint line does not.
struct TerminalQuestionPromptView: View {
  let request: PermissionRequest
  let questions: [UserQuestion]
  let maxBodyHeight: CGFloat
  let onAnswer: ([String: JSONValue]) -> Void
  let onDismiss: () -> Void

  /// Chosen labels per question index — a list, because multi-select holds
  /// several and single-select is the one-element case.
  @State private var selections: [Int: [String]] = [:]
  /// Which chip is showing. `questions.count` *is* the review step, one index
  /// space, which is what makes "next" a single `+1`.
  @State private var step = 0

  private var typography: TerminalTypography { .session }

  private var reviewing: Bool { step >= questions.count }
  private var complete: Bool {
    questions.indices.allSatisfy { !(selections[$0] ?? []).isEmpty }
  }

  var body: some View {
    TerminalPromptSurface(tint: TerminalPalette.color(.blue), maxBodyHeight: maxBodyHeight) {
      VStack(alignment: .leading, spacing: 0) {
        PromptRow(glyph: "?", tone: .blue) {
          PromptText(
            text: request.title ?? "The agent has a question", tone: .bright, weight: .semibold)
        }
        if questions.count > 1 { chips }
        Spacer().frame(height: 8)
        if reviewing {
          review
        } else if let question = questions[safe: step] {
          questionBlock(index: step, question: question)
        }
      }
    } actions: {
      PromptActions {
        if step > 0 {
          PromptButton(title: "Back", tone: .dim) { step -= 1 }
        }
        if reviewing {
          PromptButton(title: "Send", tone: .blue, prominent: true, enabled: complete, action: submit)
        } else {
          PromptButton(
            title: step == questions.count - 1 ? "Review" : "Next", tone: .blue, prominent: true,
            enabled: !(selections[step] ?? []).isEmpty
          ) {
            step += 1
          }
        }
        Spacer(minLength: 0)
        PromptButton(title: "Dismiss", tone: .faint, action: onDismiss)
      }
    }
  }

  /// The chip strip: which question you are on, and how many there are. Answered
  /// chips carry a mark rather than a tick count — the point is "this one is
  /// done", and the answer itself is one tap away on the review step.
  private var chips: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 6) {
        ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
          chip(
            title: question.header.isEmpty ? "Q\(index + 1)" : question.header,
            answered: !(selections[index] ?? []).isEmpty, active: step == index
          ) { step = index }
        }
        chip(title: "Review", answered: false, active: reviewing) { step = questions.count }
      }
      .padding(.leading, typography.cell * 2)
      .padding(.vertical, 4)
    }
    .scrollIndicators(.hidden)
  }

  private func chip(title: String, answered: Bool, active: Bool, tap: @escaping () -> Void)
    -> some View
  {
    Button(action: tap) {
      Text(answered ? "\(title) ✓" : title)
        .font(Font(typography.uiFont))
        .foregroundStyle(TerminalPalette.color(active ? .bright : answered ? .green : .faint))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .overlay(
          Rectangle().strokeBorder(
            TerminalPalette.color(active ? .blue : .faint).opacity(active ? 0.7 : 0.3),
            lineWidth: 0.5))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func questionBlock(index: Int, question: UserQuestion) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      PromptRow { PromptText(text: question.question, weight: .medium) }
      if question.multiSelect == true {
        PromptRow { PromptText(text: "Choose any that apply.", tone: .faint) }
      }
      Spacer().frame(height: 4)
      ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
        PromptChoice(
          index: optionIndex,
          label: option.label,
          // The first option is the model's recommendation, and saying so is
          // worth a word: it is the difference between three alternatives and
          // three alternatives one of which the agent thinks is right.
          detail: [optionIndex == 0 ? "recommended" : nil, option.description]
            .compactMap { $0 }.joined(separator: " · "),
          preview: option.preview,
          selected: (selections[index] ?? []).contains(option.label),
          multi: question.multiSelect == true
        ) {
          toggle(index: index, label: option.label, multiSelect: question.multiSelect == true)
        }
      }
    }
  }

  /// Every answer on one screen, which is the whole reason the step exists.
  private var review: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
        PromptRow { PromptText(text: question.question, tone: .dim) }
        PromptRow(glyph: TermGlyph.output, tone: .faint) {
          PromptText(
            text: (selections[index] ?? []).joined(separator: ", ").ifEmpty("— not answered"),
            tone: (selections[index] ?? []).isEmpty ? .red : .green)
        }
        Spacer().frame(height: 4)
      }
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
      current = [label]
    }
    selections[index] = current
  }

  private func submit() {
    var answers: [String: JSONValue] = [:]
    for (position, question) in questions.enumerated() {
      answers[question.question] = .string((selections[position] ?? []).joined(separator: ", "))
    }
    // Rewrite the tool's input rather than replace it: the CLI reads `answers`
    // alongside the questions it originally sent.
    var input = request.input.objectValue ?? [:]
    input["answers"] = .object(answers)
    onAnswer(input)
  }
}

extension Array {
  fileprivate subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}

extension String {
  fileprivate func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
