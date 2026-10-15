#if WD_NATIVE_CORE
import SwiftUI
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

struct CoreSessionView: View {
  @Environment(AppSettings.self) private var settings
  @State private var model: CoreSessionModel
  @State private var draft = ""

  init(sessionId: String, client: WorkerClient) {
    _model = State(
      initialValue: CoreSessionModel(
        sessionId: sessionId, baseURL: client.baseURL.absoluteString, authKey: client.authKey))
  }

  var body: some View {
    let ui = model.ui
    VStack(spacing: 0) {
      CoreStatusLine(ui: ui, reconnect: model.reconnect)
      CoreTranscript(model: model, hideThinking: !settings.showThinking)
      if let prompt = ui.prompt {
        Divider()
        CorePromptCard(prompt: prompt, planLines: ui.planLines, model: model)
          .id(prompt.requestId)
      }
      Divider()
      composer(ui.chrome)
    }
    .navigationTitle(ui.title ?? "Session")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) { pickers(ui) }
    }
    .onDisappear { model.close() }
  }

  private func composer(_ chrome: SessionChrome?) -> some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("Message", text: $draft, axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.roundedBorder)
      if chrome?.busy == true {
        Button("Stop", systemImage: "stop.fill", action: model.interrupt)
          .labelStyle(.iconOnly)
          .buttonStyle(.bordered)
      }
      Button("Send", systemImage: "arrow.up") {
        model.send(draft)
        draft = ""
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.borderedProminent)
      .disabled(chrome?.enabled != true || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .padding(8)
  }

  @ViewBuilder
  private func picked(_ title: String, _ selected: Bool) -> some View {
    if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
  }

  private func pickers(_ ui: CoreSessionUi) -> some View {
    Menu {
      if let picker = ui.modelPicker {
        Section(picker.title) {
          ForEach(Array((picker.main + picker.more).enumerated()), id: \.offset) { _, row in
            Button(action: { model.setModel(row.value) }) {
              picked(row.title, row.selected)
            }
          }
        }
        if !picker.efforts.isEmpty {
          Section("Effort") {
            ForEach(Array(picker.efforts.enumerated()), id: \.offset) { _, row in
              Button(action: { model.setEffort(row.value) }) {
                picked(row.title, row.selected)
              }
            }
          }
        }
      }
      if let modes = ui.modePicker, !modes.rows.isEmpty {
        Section("Mode") {
          ForEach(Array(modes.rows.enumerated()), id: \.offset) { _, row in
            Button(action: { model.setMode(row.mode) }) {
              picked(row.title, row.selected)
            }
            .disabled(row.disabled)
          }
        }
      }
    } label: {
      Label("Model and mode", systemImage: "slider.horizontal.3")
    }
    .disabled(ui.chrome?.enabled != true)
  }
}

private struct CoreStatusLine: View {
  let ui: CoreSessionUi
  let reconnect: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Circle().fill(dot).frame(width: 7, height: 7)
        Text(connectionLabel)
        if let chrome = ui.chrome {
          Text(chrome.statusLabel).foregroundStyle(.secondary)
          if let label = chrome.modelLabel { Text(label).foregroundStyle(.secondary) }
          if let mode = chrome.modeLabel { Text(mode).foregroundStyle(.secondary) }
          if chrome.queued > 0 { Text("\(chrome.queued) queued").foregroundStyle(.secondary) }
        }
        Spacer(minLength: 0)
        if let seconds = ui.openSeconds {
          Text("core \(seconds, format: .number.precision(.fractionLength(2))) s").foregroundStyle(.tertiary)
        }
        if ui.connection == .offline || ui.connection == .unreachable {
          Button("Retry", action: reconnect).buttonStyle(.borderless)
        }
      }
      if let progress = ui.progress {
        ProgressView(value: Double(progress.seq), total: Double(max(progress.target, 1)))
      }
      if let error = ui.error {
        Text(error).foregroundStyle(.red)
      }
    }
    .font(.caption)
    .lineLimit(1)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }

  private var connectionLabel: String {
    switch ui.connection {
    case .connecting: "Connecting"
    case .live: "Live"
    case .reconnecting: "Reconnecting"
    case .offline: "Offline"
    case .unreachable: "Unreachable"
    }
  }

  private var dot: Color {
    switch ui.connection {
    case .live: .green
    case .connecting, .reconnecting: .yellow
    case .offline, .unreachable: .red
    }
  }
}

private struct CoreTranscript: View {
  let model: CoreSessionModel
  let hideThinking: Bool
  private static let tones = toneNames().map { TermTone(rawValue: $0) ?? .fg }
  private let type = TerminalTypography.session

  var body: some View {
    let ui = model.ui
    GeometryReader { geometry in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(ui.rows.enumerated()), id: \.element.key) { index, row in
            rowView(index, row, ui.linesAt(index))
              .onAppear { model.rowShown(index, true) }
              .onDisappear { model.rowShown(index, false) }
          }
        }
        .padding(.horizontal, Self.inset)
      }
      .defaultScrollAnchor(.bottom)
      .onAppear { model.layout(width: geometry.size.width - Self.inset * 2, hideThinking: hideThinking) }
      .onChange(of: geometry.size.width) { _, width in
        model.layout(width: width - Self.inset * 2, hideThinking: hideThinking)
      }
    }
  }

  private static let inset: CGFloat = 8

  private func rowView(_ index: Int, _ row: LayoutRow, _ lines: [TranscriptLine]?) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array((lines ?? []).enumerated()), id: \.offset) { offset, line in
        lineView(line)
          .contentShape(Rectangle())
          .onTapGesture { if line.pressable { model.press(row: index, line: offset) } }
      }
    }
    .frame(maxWidth: .infinity, minHeight: CGFloat(row.height), maxHeight: CGFloat(row.height), alignment: .topLeading)
    .clipped()
  }

  private func lineView(_ line: TranscriptLine) -> some View {
    HStack(spacing: 0) {
      Text(line.gutter).foregroundStyle(color(line.gutterTone))
      Text(line.text)
        .foregroundStyle(color(line.tone))
        .bold(line.bold)
        .italic(line.italic)
    }
    .font(type.font)
    .lineLimit(1)
    .padding(.leading, CGFloat(line.indent) * type.cell)
    .frame(height: type.line, alignment: .leading)
  }

  private func color(_ tone: UInt8) -> Color {
    let tones = Self.tones
    return TerminalPalette.color(Int(tone) < tones.count ? tones[Int(tone)] : .fg)
  }
}

private struct CorePromptCard: View {
  let prompt: Prompt
  let planLines: [TranscriptLine]
  let model: CoreSessionModel
  @State private var denying = false
  @State private var reason = ""
  @State private var picked: [Int: Set<String>] = [:]
  @State private var other: [Int: String] = [:]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(prompt.heading).font(.headline)
          Spacer()
          if prompt.waiting > 1 { Text("+\(prompt.waiting - 1) waiting").font(.caption).foregroundStyle(.secondary) }
        }
        if let subject = prompt.subject { Text(subject).font(.subheadline.monospaced()) }
        ForEach(Array(prompt.shellLines.enumerated()), id: \.offset) { _, line in
          Text(line).font(.caption.monospaced())
        }
        ForEach(Array(planLines.enumerated()), id: \.offset) { _, line in
          Text(line.gutter + line.text).font(.caption.monospaced())
        }
        if let description = prompt.description { Text(description).font(.callout) }
        if let reason = prompt.decisionReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
        if prompt.kind == .question { questions } else { decision }
      }
      .padding(12)
    }
    .frame(maxHeight: 320)
    .fixedSize(horizontal: false, vertical: true)
  }

  private var decision: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !prompt.question.isEmpty { Text(prompt.question) }
      HStack {
        ForEach(Array(prompt.choices.enumerated()), id: \.offset) { _, choice in
          Button(choice.button, role: choice.danger ? .destructive : nil) { choose(choice.key) }
            .buttonStyle(.bordered)
        }
      }
      if denying {
        TextField(prompt.denyPlaceholder, text: $reason).textFieldStyle(.roundedBorder)
        Button("Send denial") { deny(interrupt: false) }.buttonStyle(.borderedProminent)
      }
    }
  }

  private func choose(_ key: ChoiceKey) {
    switch key {
    case .allow: model.allow(prompt.requestId)
    case .deny: denying.toggle()
    case .stop: deny(interrupt: true)
    }
  }

  private func deny(interrupt: Bool) {
    let message = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    model.deny(prompt.requestId, message: message.isEmpty ? nil : message, interrupt: interrupt)
  }

  private var questions: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Array(prompt.questions.enumerated()), id: \.offset) { index, question in
        VStack(alignment: .leading, spacing: 4) {
          Text(question.header).font(.caption).foregroundStyle(.secondary)
          Text(question.question)
          ForEach(question.options, id: \.label) { option in
            Button(action: { toggle(index, option.label, multi: question.multiSelect) }) {
              Label(
                option.label,
                systemImage: picked[index, default: []].contains(option.label) ? "checkmark.circle.fill" : "circle")
            }
            .buttonStyle(.borderless)
          }
          TextField(
            "Other", text: Binding(get: { other[index] ?? "" }, set: { other[index] = $0 })
          )
          .textFieldStyle(.roundedBorder)
        }
      }
      HStack {
        Button("Submit") { model.answer(prompt.requestId, selections) }.buttonStyle(.borderedProminent)
        Button("Dismiss") { model.dismiss(prompt.requestId) }.buttonStyle(.bordered)
      }
    }
  }

  private var selections: [Selection] {
    prompt.questions.indices.map { index in
      let text = (other[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let labels = prompt.questions[index].options.map(\.label).filter { picked[index, default: []].contains($0) }
      return Selection(labels: labels, other: text, otherActive: !text.isEmpty)
    }
  }

  private func toggle(_ index: Int, _ label: String, multi: Bool) {
    var set = picked[index, default: []]
    if set.contains(label) {
      set.remove(label)
    } else {
      if !multi { set.removeAll() }
      set.insert(label)
    }
    picked[index] = set
  }
}
#endif
