import SwiftUI
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

struct CoreSessionView: View {
  @Environment(AppSettings.self) private var settings
  @Environment(UnreadModel.self) private var unread
  @Environment(PushCoordinator.self) private var push
  @Environment(BookmarkModel.self) private var bookmarks
  @State private var viewing: CoreViewedImage?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @State private var model: CoreSessionModel
  @State private var scroll = TranscriptScrollModel()
  @State private var images = TerminalImageLoader()
  @State private var confirmClear = false
  @State private var confirmClose = false
  @State private var extras = CoreExtras()
  @State private var meterSheet: CoreMeterSheet?
  private let hostId: UUID
  private let sessionId: String
  private let client: WorkerClient?
  private var fixtureRecap: CatchUpMark?
  private let composerServices: CoreComposerServices

  init(sessionId: String, hostId: UUID, client: WorkerClient, entry: CoreEntry? = nil) {
    self.hostId = hostId
    self.sessionId = sessionId
    self.client = client
    composerServices = .live(client: client, sessionId: sessionId)
    _model = State(
      initialValue: CoreSessionModel(
        sessionId: sessionId, baseURL: client.baseURL.absoluteString, authKey: client.authKey, entry: entry))
  }

  // Frames replayed with no gateway behind them: `UIPREVIEW=core` and the UI tests.
  init(fixture: [String], recap: CatchUpMark? = nil) {
    fixtureRecap = recap
    hostId = UUID()
    sessionId = "fixture"
    client = nil
    composerServices = CoreReplayFixture.composerServices
    _model = State(
      initialValue: CoreSessionModel(
        sessionId: "fixture", baseURL: "http://fixture.invalid", authKey: nil, fixture: fixture))
  }

  var body: some View {
    let ui = model.ui
    VStack(spacing: 0) {
      CoreStatusLine(ui: ui, reconnect: model.reconnect, openMeter: { meterSheet = $0 })
      transcriptArea(ui)
      if let prompt = ui.prompt {
        Divider()
        CorePromptCard(prompt: prompt, planLines: ui.planLines, model: model)
          .id(prompt.requestId)
      }
      CoreComposer(model: model, scroll: scroll, services: composerServices)
    }
    .modifier(CoreRowExtras(actions: rowActions, viewing: $viewing, revision: bookmarks.revision, onBookmarks: syncBookmarks))
    .navigationTitle(ui.title ?? "Session")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) { pickers(ui) }
      ToolbarItem(placement: .topBarTrailing) { sessionMenu(ui.chrome) }
    }
    .modifier(CoreExtrasSheets(extras: extras, model: model, client: client, sessionId: sessionId))
    .sheet(item: $meterSheet) { sheet in
      switch sheet {
      case .context: CoreContextSheet(context: model.ui.usage?.context)
      case .usage: if let usage = model.ui.usage { CoreUsageSheet(usage: usage) }
      }
    }
    .confirmationDialog("Clear the conversation?", isPresented: $confirmClear, titleVisibility: .visible) {
      Button("Clear context", action: model.clearContext)
    } message: {
      Text("The session keeps running and starts a fresh conversation. The old one stays resumable.")
    }
    .confirmationDialog("Close this session?", isPresented: $confirmClose, titleVisibility: .visible) {
      // Over REST rather than the socket: leaving tears the socket down at once, and a close must outlive the screen.
      Button("Close session", role: .destructive) {
        if let client { Task { [sessionId] in _ = try? await client.deleteSession(id: sessionId) } }
        dismiss()
      }
    } message: {
      Text("The run is terminated on the server.")
    }
    .navigationDestination(
      isPresented: Binding(
        get: { ui.shell != nil },
        set: { if !$0, let id = model.ui.shell?.id { model.closeShell(id) } })
    ) {
      if let id = ui.shell?.id { CoreShellScreen(model: model, shellId: id) }
    }
    .navigationDestination(
      isPresented: Binding(
        get: { ui.frame != nil },
        set: { if !$0, let id = model.ui.frame?.taskId { model.closeFrame(id) } })
    ) {
      if let id = ui.frame?.taskId {
        CoreFrameScreen(model: model, taskId: id, imageLoader: images, hideThinking: !settings.showThinking)
          .environment(\.coreRowActions, rowActions)
      }
    }
    .onAppear {
      wireImages()
      syncBookmarks()
      if let mark = fixtureRecap ?? (settings.catchUpMode ? unread.since(host: hostId, sessionId: sessionId) : nil) {
        model.setRecap(mark)
      }
      if client != nil { push.visibleSessionId = sessionId }
    }
    // Pushing a shell or sub-agent screen hides this one too; only leaving the session closes it.
    .onDisappear {
      guard model.ui.shell == nil && model.ui.frame == nil else { return }
      model.close()
      if push.visibleSessionId == sessionId { push.visibleSessionId = nil }
      finalizeSeen()
    }
    .onChange(of: model.ui.seen) { _, seen in
      if scenePhase == .active, let seen { mark(seen) }
    }
    .onChange(of: scenePhase) { _, phase in
      guard client != nil else { return }
      if phase == .active { model.reconnect() }
      push.visibleSessionId = phase == .active ? sessionId : nil
      if phase != .active { finalizeSeen() }
    }
  }

  // Only while this session is really on screen: a mark from anywhere else is how an unread badge silently stops
  // working.
  private func mark(_ seen: CoreSeen) {
    guard client != nil else { return }
    unread.mark(
      host: hostId, sessionId: sessionId, itemCount: seen.itemCount, activity: seen.activity, prose: seen.prose,
      turns: seen.turns)
  }

  // The in-view marks ran off the attach snapshot's counters, so anything the rollup counted since would read as
  // unread although it was on screen: leaving trues the mark up once from a fresh read.
  private func finalizeSeen() {
    guard let client, let seen = model.ui.seen else { return }
    Task { @MainActor [unread, hostId, sessionId] in
      guard let info = try? await client.getSession(id: sessionId) else { return }
      unread.mark(host: hostId, sessionId: sessionId, itemCount: seen.itemCount, info: info)
    }
  }

  @ViewBuilder
  private func picked(_ title: String, _ selected: Bool) -> some View {
    if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
  }

  private func sessionMenu(_ chrome: SessionChrome?) -> some View {
    Menu {
      if let usage = model.ui.usage {
        if usage.contextUsage { Button("Context", systemImage: "chart.pie") { meterSheet = .context } }
        Button("Usage", systemImage: "gauge") { meterSheet = .usage }
      }
      if chrome?.canClearContext == true {
        Button("Clear context", systemImage: "eraser") { confirmClear = true }
      }
      if model.ui.extras.canSleep {
        Button("Sleep", systemImage: "moon.zzz", action: model.sleep)
      }
      Button("Close session", systemImage: "xmark.circle", role: .destructive) { confirmClose = true }
        .disabled(client == nil)
      CoreExtrasMenu(extras: extras)
    } label: {
      Label("Session", systemImage: "ellipsis.circle")
    }
  }

  private var rowActions: CoreRowActions {
    CoreRowActions(
      menu: CoreRowMenu.make(model: model, bookmarks: bookmarks, hostId: hostId, sessionId: sessionId),
      openImage: { viewing = CoreViewedImage(image: $0) })
  }

  private func syncBookmarks() { model.setBookmarks(bookmarks.bookmarks(host: hostId, sessionId: sessionId)) }

  private func wireImages() {
    images.sessionId = sessionId
    images.host = { [model] in model.hostImage($0) }
    if let client {
      images.fetch = { try await client.bytes(path: $0) }
    } else {
      images.fetch = { try CoreMediaFixture.image(at: $0) }
    }
  }

  @ViewBuilder
  private func transcriptArea(_ ui: CoreSessionUi) -> some View {
    CoreWarnings(mismatch: ui.extras.mismatch, error: ui.error, onDismiss: model.dismissError)
    CoreTranscriptView(model: model, scroll: scroll, imageLoader: images, hideThinking: !settings.showThinking)
      .overlay {
        if ui.main.rows.isEmpty, ui.progress == nil, ui.connection == .live {
          CoreEmptyState(cwd: ui.extras.cwd, canRunShell: ui.canRunShell)
        }
      }
    if let count = ui.extras.newRows, count > 0, let row = ui.main.recapRow, ui.progress == nil {
      CoreCatchUpBar(
        count: count, onJump: { scroll.scrollToRow(row, anchor: .top, animated: true) }, onDismiss: model.clearRecap)
    }
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
  var openMeter: (CoreMeterSheet) -> Void = { _ in }

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
        if let usage = ui.usage { CoreUsageHud(usage: usage, open: openMeter) }
      }
      if let progress = ui.progress {
        ProgressView(value: Double(progress.seq), total: Double(max(progress.target, 1)))
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

struct CorePromptCard: View {
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
