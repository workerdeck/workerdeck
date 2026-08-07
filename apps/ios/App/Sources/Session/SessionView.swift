import PhotosUI
import UniformTypeIdentifiers
import WorkerDeckKit
import SwiftUI

/// The live session: one `SessionHandle`, one `TranscriptState`, and the two
/// bands over them — the transcript, and the floating glass stack (status bar,
/// approval, composer) that rides above its bottom edge.
///
/// Nothing is docked. The navigation bar and the bottom stack are both
/// translucent and the transcript scrolls under them, so the screen reads as one
/// surface with controls floating on it rather than three stacked strips.
///
/// The handle's lifetime is exactly the `.task`: attach on appear, detach when the
/// task is cancelled (navigating back). Returning to the foreground skips the
/// reconnect backoff instead of waiting it out.
struct SessionView: View {
  /// The modal screens over a session. `Identifiable` so one `.sheet(item:)`
  /// presents all of them.
  enum Sheet: String, Identifiable {
    case context, usage, info, files, model, mode, addMedia, mcp, skills
    var id: String { rawValue }
  }

  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @Environment(PushCoordinator.self) private var push

  @State private var vm: TranscriptViewModel
  @State private var draft = ""
  /// One sheet at a time, by identity: the session screen has four of them and
  /// a bag of booleans would let two open at once.
  @State private var sheet: Sheet?
  @State private var showCloseConfirmation = false
  /// Lives as long as the view: both halves of it arrive late and independently —
  /// the command list with `capabilities`, the file scope with the cwd — and a
  /// model rebuilt under the composer would drop the draft's suggestion state.
  @State private var completion = PromptCompletionModel()
  /// Owns the share sheet for files tapped in the transcript. The details sheet
  /// has its own — a sheet can't raise another sheet from underneath itself.
  @State private var downloader = FileDownloader()
  /// The caret, and whether the keyboard is up. Here rather than in the composer
  /// because the picker overlay edits the same draft it does.
  @State private var selection = NSRange(location: 0, length: 0)
  @State private var isComposerFocused = false
  /// How much of the bottom the floating stack occupies — the picker sits on top
  /// of it, so it needs the number the layout actually produced.
  @State private var footerHeight: CGFloat = 0
  /// Files staged for the next message. Outlives the composer's focus and is
  /// cleared on send; uploads start as soon as something is picked.
  @State private var attachments = ComposerAttachmentStore()
  /// Fetches (and caches) transcript thumbnails, which need the auth header.
  @State private var attachmentLoader = AttachmentLoader()
  /// Fetches (and caches) pictures the engine produced on the host — codex's
  /// generated images, which arrive as a path and never as bytes.
  @State private var producedImages = ProducedImageLoader()
  /// The two system pickers the Add Media sheet hands off to. Separate flags
  /// rather than `Sheet` cases: iOS presents both full screen and neither can be
  /// raised from underneath the half-height sheet that chose it.
  @State private var showCamera = false
  @State private var showFileImporter = false
  @State private var photoSelection: [PhotosPickerItem] = []
  @State private var photoPickerRequested = false

  init(sessionId: String, client: WorkerClient) {
    _vm = State(initialValue: TranscriptViewModel(sessionId: sessionId, client: client))
  }

  var body: some View {
    // A `ZStack`, not `.overlay` on the transcript: an overlay on a `ScrollView`
    // is proposed the scroll *content's* ideal size, so the picker came out
    // neither full width nor full height. A stack child is proposed the
    // container's size, which is what the picker needs to fill it.
    ZStack(alignment: .top) {
      TranscriptListView(items: vm.state.items, revision: vm.revision)
        // Tapping the transcript puts the keyboard away. Simultaneous, so a tap
        // that lands on a tool card still expands it — dismissing on the way is
        // what you'd want there too.
        .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
        .safeAreaInset(edge: .bottom, spacing: 0) { measuredFooter }
      emptyState
      picker
    }
    .onPreferenceChange(FooterHeight.self) { footerHeight = $0 }
    .navigationTitle(vm.title)
    .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbarMenu }
      .environment(\.fileDownloader, downloader)
      .environment(\.attachmentLoader, attachmentLoader)
      .environment(\.producedImageLoader, producedImages)
      .fileDownloadPresentation(downloader)
      .task {
        downloader.access = vm.fileAccess
        attachments.upload = { [vm] name, mediaType, data in
          try await vm.uploadAttachment(name: name, mediaType: mediaType, data: data)
        }
        attachmentLoader.fetch = { [vm] id in try await vm.attachmentData(id) }
        producedImages.fetch = { [vm] id in try await vm.producedFileData(id) }
        await vm.run()
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active { vm.reconnectNow() }
        // Backgrounding stops this session being "on screen": that is exactly
        // when its notifications become useful again.
        push.visibleSessionId = phase == .active ? vm.sessionId : nil
      }
      // Claimed on appear and released on disappear, so notifications for the
      // session you are watching stay silent and nothing else does.
      .task {
        push.visibleSessionId = vm.sessionId
      }
      .onDisappear {
        if push.visibleSessionId == vm.sessionId { push.visibleSessionId = nil }
      }
      // The cwd arrives with the session snapshot, which lands after this view
      // does — and changes on a resume into a different directory.
      .task(id: vm.cwd) {
        completion.scope = vm.hostFiles
      }
      // Slash commands come from `capabilities`, which the server sends once the
      // engine is up — later than the first draft keystroke, in a cold session.
      .task(id: vm.state.commands) {
        completion.commands = vm.state.commands ?? []
      }
      // Skills arrive on their own channel, and later still: codex can only
      // list them over a live child, so a cold session gets none until its
      // first turn.
      .task(id: vm.state.skills) {
        completion.skills = vm.state.skills ?? []
      }
      // Path → fileId, so a tool card holding a `savedPath` can fetch its
      // picture without the transcript growing another prop.
      .task(id: vm.state.producedFiles) {
        producedImages.files = vm.state.producedFiles ?? [:]
      }
      .sheet(item: $sheet) { sheet in
        switch sheet {
        case .context:
          ContextSheet(usage: vm.state.contextUsage)
        case .usage:
          UsageSheet(
            rateLimits: vm.rateLimitWindows,
            subscriptionType: vm.state.subscriptionType,
            engine: vm.engine,
            totalCostUsd: vm.state.totalCostUsd,
            updatedAt: vm.rateLimitsUpdatedAt)
        case .info:
          SessionInfoSheet(state: vm.state, session: vm.session, fileAccess: vm.fileAccess)
        case .files:
          if let scope = vm.hostFiles {
            HostFilesView(scope: scope)
          }
        case .model:
          ModelPickerSheet(
            models: vm.availableModels,
            current: vm.effectiveModel,
            defaultModel: vm.defaultModel,
            onSelect: { vm.setModel($0) })
        case .addMedia:
          AddMediaSheet(acceptsImages: acceptedKinds.contains("image"), onChoose: choose)
        case .skills:
          SkillsView(skills: vm.state.skills ?? [], onUse: draftSkill)
        case .mcp:
          McpServersView(
            load: { try await vm.mcpServers() },
            act: { name, action in try await vm.mcpAction(name, action) },
            canManage: vm.capabilities.mcpServerActions)
        case .mode:
          ModePickerSheet(
            modes: permissionModes,
            current: vm.state.permissionMode,
            defaultMode: vm.defaultPermissionMode,
            canBypass: vm.session?.canBypassPermissions,
            onSelect: { vm.setPermissionMode($0) })
        }
      }
      .fullScreenCover(isPresented: $showCamera) {
        CameraPicker { image in
          if let picked = AttachmentNormalizer.image(image, name: "photo.jpg", mediaType: nil) {
            attachments.add(picked)
          }
        }
        .ignoresSafeArea()
      }
      // `maxSelectionCount` is not set: several screenshots at once is the normal
      // case, and the session's byte ceiling is the real bound.
      .photosPicker(isPresented: $photoPickerRequested, selection: $photoSelection, matching: .images)
      .onChange(of: photoSelection) { _, items in
        guard !items.isEmpty else { return }
        photoSelection = []
        for item in items { loadPhoto(item) }
      }
      .fileImporter(isPresented: $showFileImporter, allowedContentTypes: importableTypes, allowsMultipleSelection: true) { result in
        switch result {
        case .success(let urls): for url in urls { loadFile(url) }
        case .failure(let error): attachments.errorText = error.localizedDescription
        }
      }
      .alert(
        "Attachment failed",
        isPresented: Binding(
          get: { attachments.errorText != nil },
          set: { if !$0 { attachments.errorText = nil } })
      ) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(attachments.errorText ?? "")
      }
      .confirmationDialog(
        "Close this session?", isPresented: $showCloseConfirmation, titleVisibility: .visible
      ) {
        Button("Close session", role: .destructive) {
          vm.closeSession()
          dismiss()
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("The run is terminated on the server.")
      }
  }

  // MARK: - The floating stack

  private var footer: some View {
    VStack(spacing: 8) {
      if let serverVersion = vm.protocolMismatch {
        WarningStrip(
          text:
            "Server speaks protocol v\(serverVersion), this app mirrors v\(WorkerProtocol.version). Some events may not render.")
      }
      if let message = vm.lastProtocolError {
        WarningStrip(text: message) { vm.dismissProtocolError() }
      }
      if let request = vm.pendingApproval, !isPickerOpen {
        // No wrapper: both prompt views bring their own tinted glass panel, so
        // the coloured card is the floating surface rather than a card inside one.
        approvalBanner(request)
      }
      // The picker gets the screen while it is open: it is a list you are reading,
      // and the status bar is not something you consult mid-completion.
      if !isPickerOpen {
        statusBar
      }
      ComposerView(
        text: $draft,
        selection: $selection,
        isFocused: $isComposerFocused,
        isBusy: vm.state.status == .running,
        isEnabled: vm.state.status != .closed,
        attachments: attachments,
        canAddMedia: !acceptedKinds.isEmpty,
        onEdit: { text, caret in
          completion.update(for: text, cursor: Range(caret, in: text)?.lowerBound)
        },
        onSend: send,
        onStop: { vm.interrupt() },
        onAddMedia: { sheet = .addMedia })
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  private var measuredFooter: some View {
    footer.background(
      GeometryReader { proxy in
        Color.clear.preference(key: FooterHeight.self, value: proxy.size.height)
      })
  }

  /// Shown until the session says something. A `ZStack` sibling for the same
  /// reason the picker is one — an overlay on the `ScrollView` would be sized to
  /// its (empty) content — and it steps aside the moment a completion list opens.
  @ViewBuilder
  private var emptyState: some View {
    if vm.state.items.isEmpty, !isPickerOpen {
      // Measured, not assumed. The area left over is the screen minus the
      // floating stack minus whatever the keyboard took, and the empty state
      // decides what it can afford from the number rather than from the device.
      // The top inset keeps it clear of the floating navigation bar, which the
      // transcript is allowed to scroll under but a centred panel is not.
      GeometryReader { proxy in
        VStack {
          Spacer(minLength: 0)
          SessionEmptyState(
            cwd: vm.cwd,
            hasCommands: !(vm.state.commands ?? []).isEmpty,
            hasSkills: (vm.state.skills ?? []).contains { $0.enabled },
            canBrowseFiles: completion.hasFileSearch,
            // Belt and braces: the reader already reports a smaller box when the
            // keyboard pushes the safe area up, but whether it does depends on
            // how SwiftUI resolves this stack — and a panel that overlaps the
            // composer is the exact failure being fixed. Focus is a fact we
            // hold, so it caps the budget regardless.
            availableHeight: isComposerFocused
              ? min(proxy.size.height, 240) : proxy.size.height)
          Spacer(minLength: 0)
        }
        .frame(width: proxy.size.width, height: proxy.size.height)
      }
      .padding(.top, 44)
      .padding(.bottom, footerHeight)
      .allowsHitTesting(false)
      .transition(.opacity)
    }
  }

  /// The suggestion panel, filling everything the header and the floating stack
  /// leave. It is a sibling of the transcript rather than part of the composer so
  /// that it can claim that area; the insets come from the reader (those are
  /// reliable) and the stack's own height from what the layout produced.
  @ViewBuilder
  private var picker: some View {
    if isPickerOpen {
      PromptSuggestionList(suggestions: completion.suggestions, onAccept: accept)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, footerHeight + 8)
    }
  }

  private var isPickerOpen: Bool {
    completion.isActive && !completion.suggestions.isEmpty
  }

  private func accept(_ suggestion: PromptCompletionModel.Suggestion) {
    let cursor = Range(selection, in: draft)?.lowerBound
    let result = completion.accept(suggestion, in: draft, cursor: cursor)
    draft = result.text
    selection = NSRange(location: result.cursor.utf16Offset(in: result.text), length: 0)
  }

  private func send() {
    // A half-typed token is not a completion the user declined; sending closes
    // the list either way.
    completion.cancel()
    // `/mcp` is answered here rather than sent. The CLI's own `/mcp` is an
    // interactive picker, not a prompt — forwarding it would spend a turn on a
    // model reading the words "/mcp", so the app opens its own screens instead.
    // Only where the capability exists: elsewhere it is ordinary message text,
    // like any other slash command on an engine without them.
    if vm.capabilities.mcpStatus, draft.trimmingCharacters(in: .whitespaces) == "/mcp" {
      draft = ""
      selection = NSRange(location: 0, length: 0)
      dismissKeyboard()
      sheet = .mcp
      return
    }
    vm.send(draft, attachmentIds: attachments.readyIds)
    // The bytes are the server's now, and the echoed event carries the
    // references — so the staging area empties rather than being re-sent.
    attachments.clear()
    draft = ""
    selection = NSRange(location: 0, length: 0)
    // Keep the keyboard up: a remote control is used in bursts.
    isComposerFocused = true
  }

  // MARK: - Add Media

  /// Attachment kinds this session's engine can deliver to its model, from the
  /// capability record. Empty hides the attach affordance entirely.
  private var acceptedKinds: Set<String> { Set(vm.capabilities.attachments) }

  /// What the Files picker offers. The full set keeps today's open door
  /// (`.item` — anything, gateway refuses the rest with a clear message); a
  /// narrower record narrows the browsing too, so most refusals never happen.
  private var importableTypes: [UTType] {
    let kinds = acceptedKinds
    if kinds.isSuperset(of: ["image", "pdf", "text"]) { return [.item] }
    var types: [UTType] = []
    if kinds.contains("image") { types.append(.image) }
    if kinds.contains("pdf") { types.append(.pdf) }
    if kinds.contains("text") { types.append(.text) }
    return types.isEmpty ? [.item] : types
  }

  private func choose(_ source: AddMediaSheet.Source) {
    switch source {
    case .camera: showCamera = true
    case .photos: photoPickerRequested = true
    case .files: showFileImporter = true
    }
  }

  /// Photos hands back bytes plus the type it stored them as — usually HEIC on an
  /// iPhone, which no model accepts, so everything goes through the normalizer.
  private func loadPhoto(_ item: PhotosPickerItem) {
    Task {
      guard let data = try? await item.loadTransferable(type: Data.self) else {
        attachments.errorText = "Could not read that photo."
        return
      }
      let mediaType = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
      let name = item.itemIdentifier.map { "photo-\($0.prefix(8)).jpg" } ?? "photo.jpg"
      guard let picked = AttachmentNormalizer.file(data: data, name: name, mediaType: mediaType)
      else {
        attachments.errorText = "Could not read that photo."
        return
      }
      attachments.add(picked)
    }
  }

  /// A file from the Files app arrives as a security-scoped URL: the bytes have
  /// to be read inside the access window, not lazily afterwards.
  private func loadFile(_ url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else {
      attachments.errorText = "Could not read \(url.lastPathComponent)."
      return
    }
    let mediaType = AttachmentNormalizer.mediaType(for: url)
    // A kind the capability record forswears is refused here, with the engine
    // named — before an upload the gateway would 415. A kind this build can't
    // classify still goes through: the gateway's vocabulary is authoritative.
    if let kind = AttachmentNormalizer.kind(of: mediaType), !acceptedKinds.contains(kind) {
      attachments.errorText =
        "The \(vm.engine.rawValue) engine does not take \(kind) attachments."
      return
    }
    guard
      let picked = AttachmentNormalizer.file(
        data: data, name: url.lastPathComponent, mediaType: mediaType)
    else {
      attachments.errorText = "Could not read \(url.lastPathComponent)."
      return
    }
    attachments.add(picked)
  }

  private var statusBar: some View {
    SessionStatusBar(
      status: vm.state.status,
      pendingCount: vm.state.pendingApprovals.count,
      connection: vm.connection,
      contextUsage: vm.state.contextUsage,
      rateLimits: vm.hudRateLimits,
      totalCostUsd: vm.state.totalCostUsd,
      model: vm.effectiveModel,
      models: vm.availableModels,
      permissionMode: vm.state.permissionMode,
      onOpenModel: { sheet = .model },
      onOpenMode: { sheet = .mode },
      onOpenContext: { sheet = .context },
      onOpenUsage: { sheet = .usage },
      onOpenInfo: { sheet = .info })
  }

  @ViewBuilder
  private func approvalBanner(_ request: PermissionRequest) -> some View {
    let questions = parseUserQuestions(request)
    if questions.isEmpty {
      PermissionPromptView(
        request: request,
        onAllow: { vm.approve(request.id) },
        onDeny: { message, interrupt in
          vm.deny(request.id, message: message, interrupt: interrupt)
        })
    } else {
      QuestionPromptView(
        request: request,
        questions: questions,
        onAnswer: { input in vm.approve(request.id, updatedInput: input) },
        onDismiss: { vm.deny(request.id, message: "Question dismissed by user") })
    }
  }

  // MARK: - Toolbar

  /// Model and permission mode used to live here; they are on the status bar now,
  /// within thumb reach, and so is stopping a turn (the composer's send button
  /// becomes stop). What is left is what you reach for rarely.
  @ToolbarContentBuilder
  private var toolbarMenu: some ToolbarContent {
    // Only once the cwd is known — the browser is rooted at it, so there is
    // nothing to open before then.
    if vm.hostFiles != nil {
      ToolbarItem(placement: .topBarTrailing) {
        Button { sheet = .files } label: {
          Label("Files", systemImage: "folder")
        }
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        // Three questions, three screens — and each one is also reachable by
        // tapping the thing that summarises it on the status bar. Screens the
        // capability record forswears are absent, not present-and-empty.
        if vm.capabilities.contextUsage {
          Button("Context", systemImage: "chart.pie") { sheet = .context }
        }
        if vm.capabilities.rateLimits {
          Button("Usage", systemImage: "gauge") { sheet = .usage }
        }
        Button("Session info", systemImage: "info.circle") { sheet = .info }
        if vm.capabilities.mcpStatus {
          Button("MCP servers", systemImage: "puzzlepiece.extension") { sheet = .mcp }
        }
        // On the capability alone, like the MCP entry. Codex answers
        // `skills/list` only over a live child, so before the first turn there
        // is no list yet — but hiding the entry until then made the sheet's own
        // explanation of that unreachable, which read as a missing feature.
        if vm.capabilities.skillsList {
          Button("Skills", systemImage: "sparkles") { sheet = .skills }
        }
        Divider()
        Button("Close session", systemImage: "xmark.circle", role: .destructive) {
          showCloseConfirmation = true
        }
      } label: {
        Label("Session actions", systemImage: "ellipsis.circle")
      }
    }
  }

  /// Type a skill's opening message into the composer and close the sheet.
  ///
  /// Drafting, not running: there is no engine call that invokes a skill, so
  /// this is the only honest thing the button can do — and the operator still
  /// edits and sends it.
  private func draftSkill(_ skill: SkillInfo) {
    let separator = draft.isEmpty || draft.hasSuffix(" ") ? "" : " "
    draft += separator + PromptCompletionModel.Suggestion.prompt(for: skill)
    sheet = nil
  }

  /// Only the modes this session's capability record declares — the rest
  /// would be rejected server-side.
  private var permissionModes: [PermissionMode] {
    vm.capabilities.permissionModes
  }
}

/// A one-line, dismissible advisory strip, floating with the rest of the stack.
private struct WarningStrip: View {
  let text: String
  var onDismiss: (() -> Void)?

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.triangle.fill")
      Text(text)
        .lineLimit(2)
      Spacer(minLength: 0)
      if let onDismiss {
        Button {
          onDismiss()
        } label: {
          Image(systemName: "xmark")
        }
        .buttonStyle(.plain)
      }
    }
    .font(.caption2)
    .foregroundStyle(.orange)
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassPanel(cornerRadius: 14)
  }
}
