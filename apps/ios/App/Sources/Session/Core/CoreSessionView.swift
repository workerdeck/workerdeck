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
  @State private var confirmClose = false
  @State private var extras = CoreExtras()
  @State private var meterSheet: CoreMeterSheet?
  @State private var archived: ArchivedView?
  @State private var notice: ConversationNotice?
  @State private var discard: DiscardConfirmation?
  @State private var settleCut: Int64?
  @State private var confirmDelete = false
  @State private var actionError: String?
  private let hostId: UUID
  private let sessionId: String
  private let client: WorkerClient?
  private var fixtureRecap: CatchUpMark?
  private let composerServices: CoreComposerServices
  private var onGoToCurrent: (() -> Void)?

  // `conversation`: a past conversation of the session, shown read-only; nil is the current one.
  init(
    sessionId: String, hostId: UUID, client: WorkerClient, entry: CoreEntry? = nil, conversation: Int64? = nil,
    onGoToCurrent: (() -> Void)? = nil
  ) {
    self.hostId = hostId
    self.sessionId = sessionId
    self.client = client
    self.onGoToCurrent = onGoToCurrent
    composerServices = .live(client: client)
    _model = State(
      initialValue: CoreSessionModel(
        sessionId: sessionId, baseURL: client.baseURL.absoluteString, authKey: client.authKey, entry: entry,
        history: conversation))
  }

  // Frames replayed with no gateway behind them: `UIPREVIEW=core` and the UI tests.
  init(fixture: [String], recap: CatchUpMark? = nil, conversation: Int64? = nil) {
    fixtureRecap = recap
    hostId = UUID()
    sessionId = "fixture"
    client = nil
    composerServices = CoreReplayFixture.composerServices
    _model = State(
      initialValue: CoreSessionModel(
        sessionId: "fixture", baseURL: "http://fixture.invalid", authKey: nil, fixture: fixture, history: conversation))
  }

  var body: some View {
    let ui = model.ui
    let readOnly = model.history != nil
    VStack(spacing: 0) {
      CoreStatusLine(ui: ui, reconnect: model.reconnect, openMeter: { meterSheet = $0 })
      CoreConversationBars(
        archived: readOnly ? archived : nil, notice: readOnly ? nil : notice,
        goToCurrent: onGoToCurrent, settle: settlePrompt, retryStartNow: retryStart)
      transcriptArea(ui)
      if !readOnly {
        if let prompt = ui.prompt {
          Divider()
          CorePromptCard(prompt: prompt, planLines: ui.planLines, model: model)
            .id(prompt.requestId)
        }
        CoreComposer(model: model, scroll: scroll, services: composerServices)
      }
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
      case .usage: if let usage = model.ui.usage { CoreUsageSheet(usage: usage, reading: model.usage(at:)) }
      }
    }
    .modifier(
      CoreConversationDialogs(
        discard: $discard, settleCut: $settleCut, confirmDelete: $confirmDelete, agentName: ui.chrome?.agentName,
        onDiscard: discardAndCut, onSettle: settle, onDelete: deleteAgent))
    .alert(
      "Something went wrong", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
    ) {
      Button("OK", role: .cancel) { actionError = nil }
    } message: {
      Text(actionError ?? "")
    }
    .task(id: ConversationRead(conversation: ui.chrome?.conversation, status: ui.chrome?.status)) { await readConversations() }
    .confirmationDialog("Close this session?", isPresented: $confirmClose, titleVisibility: .visible) {
      // Over REST rather than the socket: leaving tears the socket down at once, and a close must outlive the screen.
      Button("Close session", role: .destructive) {
        if let client, let n = model.ui.chrome?.conversation {
          Task { [sessionId] in _ = try? await client.perform(deleteSessionCall(id: sessionId, generation: n)) }
        }
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
      if let mark = fixtureRecap ?? (settings.catchUpMode && model.history == nil ? unread.since(host: hostId, sessionId: sessionId) : nil) {
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
    .onChange(of: model.ui.chrome?.conversation) { _, _ in syncBookmarks() }
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

  // Only while this session's current conversation is really on screen: a mark from anywhere else (a past
  // conversation counts its own items) is how an unread badge silently stops working.
  private func mark(_ seen: SeenCounts) {
    guard client != nil, model.history == nil else { return }
    unread.mark(
      host: hostId, sessionId: sessionId, itemCount: Int(seen.itemCount), conversation: seen.conversation.map(Int.init),
      activity: seen.activity.map(Int.init), prose: seen.prose.map(Int.init))
  }

  // The in-view marks ran off the attach snapshot's counters, so anything the rollup counted since would read as
  // unread although it was on screen: leaving trues the mark up once from a fresh read.
  private func finalizeSeen() {
    guard let client, model.history == nil, let seen = model.ui.seen else { return }
    Task { @MainActor [unread, hostId, sessionId] in
      let answer = await client.answer(getSessionCall(id: sessionId))
      guard answer.status == 200 else { return }
      unread.markSession(
        host: hostId, sessionId: sessionId, itemCount: Int(seen.itemCount), conversation: seen.conversation.map(Int.init),
        body: answer.body)
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
      if chrome?.canNewConversation == true {
        Button(action: newConversation) {
          Label("New conversation", systemImage: "arrow.counterclockwise")
          Text(chrome?.newConversationBlocked ?? newConversationHint())
        }
        .disabled(client == nil || chrome?.newConversationBlocked != nil)
      }
      if model.ui.extras.canSleep, chrome?.historical != true {
        Button("Sleep", systemImage: "moon.zzz", action: model.sleep)
      }
      if chrome?.historical != true {
        if chrome?.agentId != nil {
          Button("Delete agent…", systemImage: "trash", role: .destructive) { confirmDelete = true }
            .disabled(client == nil)
        } else {
          Button("Close session", systemImage: "xmark.circle", role: .destructive) { confirmClose = true }
            .disabled(client == nil)
        }
        CoreExtrasMenu(extras: extras)
      }
    } label: {
      Label("Session", systemImage: "ellipsis.circle")
    }
  }

  private struct ConversationRead: Hashable {
    let conversation: Int64?
    let status: String?
  }

  // One read of the session's own conversations list serves both: where a past conversation stands (Go to current,
  // a closed session), and what the current one asks of the user (a first message of unknown delivery, a failed start).
  private func readConversations() async {
    var body: String?
    if let client {
      let answer = await client.answer(conversationsCall(id: sessionId))
      body = answer.status == 200 ? answer.body : nil
    }
    archived = model.archivedView(conversationsBody: body)
    notice = model.history == nil ? body.flatMap { conversationNotice(body: $0) } : nil
  }

  private func act(_ failure: String, _ call: HttpCall, then: @escaping @MainActor (Data) -> Void = { _ in }) {
    guard let client else { return }
    Task { @MainActor in
      do {
        then(try await client.perform(call))
      } catch {
        actionError = "\(failure): \(SessionListModel.describe(error))"
      }
    }
  }

  // The cut: the gateway closes this socket and the reattach shows conversation n+1 under the same id. Input the
  // engine cannot confirm asks before it is discarded; a first message of unknown delivery is settled first.
  private func newConversation() {
    guard let n = model.ui.chrome?.conversation else { return }
    cut(newConversationCall(id: sessionId, expectedGeneration: n, prompt: nil), n)
  }

  private func discardAndCut(_ confirmation: DiscardConfirmation) {
    cut(
      discardAndCutCall(
        id: sessionId, expectedGeneration: confirmation.conversation, inputRevision: confirmation.inputRevision, prompt: nil),
      confirmation.conversation)
  }

  private func cut(_ call: HttpCall, _ n: Int64) {
    guard let client else { return }
    Task { @MainActor in
      let answer = await client.answer(call)
      if (200..<300).contains(answer.status) {
        await readConversations()
        return
      }
      if let confirmation = discardConfirmation(status: answer.status, body: answer.body) {
        discard = confirmation
      } else if let prompt = uncertainPromptConversation(status: answer.status, body: answer.body) {
        settleCut = prompt
      } else {
        let error = restError(status: answer.status, contentType: answer.contentType, body: answer.body)
        actionError = "Could not start a new conversation: \(error?.message ?? "no answer")"
        await readConversations()
      }
    }
  }

  // A named session leaves to Past agents; the screen closes with it.
  private func deleteAgent() {
    guard let agentId = model.ui.chrome?.agentId, let n = model.ui.chrome?.conversation else { return }
    act("Could not delete the agent", retireAgentCall(id: agentId, members: .release, expectedGeneration: n)) { _ in dismiss() }
  }

  private func settlePrompt(_ send: Bool) {
    guard let n = notice?.uncertainN else { return }
    settle(send, n)
  }

  private func settle(_ send: Bool, _ n: Int64) {
    act(
      send ? "Could not send it again" : "Could not dismiss it", settlePendingPromptCall(id: sessionId, send: send, expectedGeneration: n)
    ) { _ in Task { await readConversations() } }
  }

  private func retryStart() {
    guard let n = notice?.startFailedN else { return }
    act("Could not start the conversation", retryConversationStartCall(id: sessionId, expectedGeneration: n)) { _ in
      model.reconnect()
      Task { await readConversations() }
    }
  }

  private var rowActions: CoreRowActions {
    CoreRowActions(
      menu: CoreRowMenu.make(model: model, bookmarks: bookmarks, hostId: hostId, sessionId: sessionId),
      openImage: { viewing = CoreViewedImage(image: $0) })
  }

  private func syncBookmarks() {
    guard let n = model.ui.chrome?.conversation else { return }
    model.setBookmarks(bookmarks.bookmarks(host: hostId, sessionId: sessionId, conversation: n))
  }

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
        if ui.main.rows.isEmpty, ui.progress == nil, archived?.unavailable == true {
          ContentUnavailableView("Transcript unavailable", systemImage: "clock.badge.questionmark")
        } else if ui.main.rows.isEmpty, ui.progress == nil, ui.connection == .live, model.history == nil {
          CoreEmptyState(cwd: ui.extras.cwd, canRunShell: ui.canRunShell)
        }
      }
    if let catchUp = ui.extras.catchUp, ui.progress == nil {
      CoreCatchUpBar(
        text: catchUp.text, onJump: { scroll.scrollToRow(Int(catchUp.row), anchor: .top, animated: true) },
        onDismiss: model.clearRecap)
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

// One session route's screen: the current conversation, or a past one (`conversation`) read-only, whose Go to current
// opens the session's live screen in its place.
struct CoreSessionRoute: View {
  let sessionId: String
  let hostId: UUID
  let client: WorkerClient
  let entry: CoreEntry?
  private let opened: Int64?
  @State private var conversation: Int64?

  init(sessionId: String, hostId: UUID, client: WorkerClient, entry: CoreEntry?, conversation: Int64?) {
    self.sessionId = sessionId
    self.hostId = hostId
    self.client = client
    self.entry = entry
    opened = conversation
    _conversation = State(initialValue: conversation)
  }

  var body: some View {
    CoreSessionView(
      sessionId: sessionId, hostId: hostId, client: client, entry: conversation == opened ? entry : nil,
      conversation: conversation, onGoToCurrent: { conversation = nil }
    )
    .id(conversation)
  }
}
