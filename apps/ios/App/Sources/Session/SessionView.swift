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
  @Environment(UnreadModel.self) private var unread
  @Environment(AppSettings.self) private var settings

  /// The gateway this session belongs to — the watermark key's first half.
  private let hostId: UUID
  /// The event a tapped notification was about, when this screen was opened by
  /// one. Resolved to a row once the replay has landed — see `focusTarget`.
  private let focusSeq: Int?
  /// The `tool_use` id a **task** step under the sessions-list row named, when
  /// this screen was opened by one. Resolved to a row the same way `focusSeq`
  /// is, and for the same reason it is held rather than acted on immediately:
  /// the list knows the id before this screen has replayed an event, and an
  /// item lookup over a half-replayed transcript answers "not here" about a
  /// call that simply has not arrived. See `resolveReveal()`.
  private let revealToolUseId: String?

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
  /// The session screen's own height, so a prompt can be capped as a fraction of
  /// it. Measured rather than assumed: a constant that fits an iPhone SE wastes
  /// half a Pro Max, and one tuned for a Pro Max reproduces the bug the cap
  /// exists to fix — a prompt taller than the screen whose buttons are off it.
  @State private var containerHeight: CGFloat = 0
  /// The terminal transcript's scroll handle. Held here rather than inside the
  /// transcript because the surfaces that want to drive it — a scrubber, the
  /// catch-up jump — sit beside the transcript, not in it.
  @State private var transcriptScroll = TranscriptScrollModel()
  /// Files staged for the next message. Outlives the composer's focus and is
  /// cleared on send; uploads start as soon as something is picked.
  @State private var attachments = ComposerAttachmentStore()
  /// Fetches (and caches) transcript thumbnails, which need the auth header.
  @State private var attachmentLoader = AttachmentLoader()
  /// Fetches (and caches) pictures the engine produced on the host — codex's
  /// generated images, which arrive as a path and never as bytes.
  @State private var producedImages = ProducedImageLoader()
  /// The pictures a *tool result* carried, fetched by address rather than
  /// arriving as bytes. A different store and a different route from
  /// `producedImages`, which serves files the engine wrote to the host's disk.
  @State private var toolImages = TerminalImageLoader()
  /// The two system pickers the Add Media sheet hands off to. Separate flags
  /// rather than `Sheet` cases: iOS presents both full screen and neither can be
  /// raised from underneath the half-height sheet that chose it.
  @State private var showCamera = false
  @State private var showFileImporter = false
  @State private var photoSelection: [PhotosPickerItem] = []
  @State private var photoPickerRequested = false

  /// Where the transcript should open, once something has told it. Nil is the
  /// normal case and means the tail.
  @State private var focusTarget: TerminalTranscriptView.TranscriptFocusTarget?
  /// Whether the question has been asked. Separate from the answer, because
  /// "the seq could not be placed" is a settled outcome too — retrying it on
  /// every later event is how a deep link turns into a transcript that jumps
  /// under the reader minutes after they arrived.
  @State private var focusResolved = false
  /// The reveal's equivalent, settling for the same reasons — see `resolveReveal()`.
  @State private var revealResolved = false

  /// The sub-agent takeover: which `Task` call's work the pushed screen is
  /// showing, or nil for the conversation. The `navigationDestination(item:)`
  /// binding — set by a `Task` row's press or a resolved route request, cleared
  /// by the pop.
  @State private var subagentId: String?
  /// A takeover asked for by the route (the sessions list's agent line), held
  /// until the attach replay has landed. The list knows the `toolUseId` from
  /// `SessionInfo.subagents` while the transcript is still filling in, and a
  /// frame opened over a half-replayed transcript would answer "not in this
  /// transcript" about an agent that simply has not arrived — so the request
  /// waits out the same hold the transcript does. See `resolveTakeover()`.
  @State private var pendingSubagent: String?

  init(
    sessionId: String, hostId: UUID, client: WorkerClient, focusSeq: Int? = nil,
    openSubagent: String? = nil, revealToolUseId: String? = nil
  ) {
    self.hostId = hostId
    self.focusSeq = focusSeq
    self.revealToolUseId = revealToolUseId
    _pendingSubagent = State(initialValue: openSubagent)
    _vm = State(initialValue: TranscriptViewModel(sessionId: sessionId, client: client))
  }

  /// One value whose change means "what has been seen changed": a new applied
  /// event, or the attach snapshot arriving without one.
  private struct SeenKey: Hashable {
    var revision: Int
    var attached: Bool
  }

  var body: some View {
    // A `ZStack`, not `.overlay` on the transcript: an overlay on a `ScrollView`
    // is proposed the scroll *content's* ideal size, so the picker came out
    // neither full width nor full height. A stack child is proposed the
    // container's size, which is what the picker needs to fill it.
    ZStack(alignment: .top) {
      // Two renderers, not two code paths through one: the terminal theme draws
      // every row itself, so nothing under the cards renderer asks which variant
      // it is in. Adding a branch inside a row is how the old `lines` variant
      // ended up duplicated across fifteen view bodies.
      // Nothing is drawn until the attach replay has landed. The flicker this
      // fixes was never a scroll bug: the replay arrives in bursts, and without
      // a hold you watch a session's whole history stream past a correctly
      // pinned viewport while the list re-lays-out under it. Holding both
      // renderers rather than only the terminal one, because both had it.
      Group {
        if vm.replaying {
          replayPlaceholder
        } else if settings.transcriptVariant.isTerminal {
          TerminalTranscriptView(
            items: vm.state.items, pendingApprovals: vm.state.pendingApprovals,
            revision: vm.revision, scroll: transcriptScroll, focusItem: focusTarget,
            onOpenSubagent: { openSubagent($0) })
        } else {
          TranscriptListView(items: vm.state.items, revision: vm.revision)
        }
      }
        // Tapping the transcript puts the keyboard away. Simultaneous, so a tap
        // that lands on a tool card still expands it — dismissing on the way is
        // what you'd want there too.
        .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
        .safeAreaInset(edge: .bottom, spacing: 0) { measuredFooter }
      emptyState
      picker
    }
    .background(
      GeometryReader { proxy in
        Color.clear.preference(key: ContainerHeight.self, value: proxy.size.height)
      })
    .onPreferenceChange(ContainerHeight.self) { containerHeight = $0 }
    .onPreferenceChange(FooterHeight.self) { footerHeight = $0 }
    .navigationTitle(vm.title)
    .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbarMenu }
      .environment(\.fileDownloader, downloader)
      // The other end of the truncating attach: a row presses, this fetches, and
      // the text lands in transcript state rather than in the row that asked.
      .environment(\.toolResultFetcher, { vm.loadFullResult(toolUseId: $0) })
      .environment(\.attachmentLoader, attachmentLoader)
      .environment(\.producedImageLoader, producedImages)
      // The other end of the ref'd attach: a box scrolls into view, this fetches
      // its bytes, and the picture lands in the row that reserved the space.
      .environment(\.terminalImageLoader, toolImages)
      // Reader preferences enter the transcript here, once, and every row below
      // reads them from the environment.
      .transcriptPreferences(settings)
      .fileDownloadPresentation(downloader)
      .task {
        downloader.access = vm.fileAccess
        attachments.upload = { [vm] name, mediaType, data in
          try await vm.uploadAttachment(name: name, mediaType: mediaType, data: data)
        }
        attachmentLoader.fetch = { [vm] id in try await vm.attachmentData(id) }
        producedImages.fetch = { [vm] id in try await vm.producedFileData(id) }
        toolImages.fetch = { [vm] seq, toolUseId, part in
          try await vm.loadToolImage(seq: seq, toolUseId: toolUseId, partIndex: part)
        }
        // The notification claim and the unread truing-up ride the model's
        // presence transitions, not this view's appear/disappear. This view's
        // `onDisappear` fires when the takeover is *pushed over it* — the
        // session is still on screen, wearing its sub-agent's frame — and
        // releasing there would let the very approval being shown in the
        // takeover bang the phone. The transitions fire exactly on "came on
        // screen" / "left the screen", whichever of the two views is doing the
        // showing. Set before `holdOpen()` takes the first claim.
        //
        // Captures pieces, never `self`: the model holds this closure, and a
        // capture of the view struct carries the model back into it — a cycle
        // that would leak every visited session's whole reduced state. The
        // release arm inlines `finalizeSeen` for the same reason.
        vm.onScreenPresence = { [weak vm, push, unread, hostId] visible in
          guard let vm else { return }
          if visible {
            push.visibleSessionId = vm.sessionId
          } else {
            if push.visibleSessionId == vm.sessionId { push.visibleSessionId = nil }
            guard vm.session != nil else { return }
            Task { @MainActor in
              guard let info = await vm.refreshSessionInfo() else { return }
              unread.mark(
                host: hostId, sessionId: vm.sessionId, itemCount: vm.state.items.count,
                activity: info.activityCount, turns: info.numTurns)
            }
          }
        }
        await vm.holdOpen()
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active { vm.reconnectNow() }
        // Backgrounding stops this session being "on screen": that is exactly
        // when its notifications become useful again — and when the watermark
        // stops moving, after one truing-up of what *was* visible.
        push.visibleSessionId = phase == .active ? vm.sessionId : nil
        if phase != .active { finalizeSeen() }
      }
      // The unread watermark, written **only while this session is genuinely on
      // screen** — this view visible and showing it. A mark from anywhere else
      // is how an unread badge silently stops working.
      .task(id: SeenKey(revision: vm.revision, attached: vm.session != nil)) {
        markSeen()
        // Ridden along on this key rather than given its own: it is the same
        // question ("has anything landed?"), it fires per applied event, and a
        // second `.task(id:)` on that key would double the per-event cost of a
        // screen whose replay cost is already the thing being watched.
        resolveFocus()
        resolveReveal()
        resolveTakeover()
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
            windows: vm.usageWindows,
            subscriptionType: vm.state.subscriptionType,
            engine: vm.engine,
            totalCostUsd: vm.state.totalCostUsd)
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
      // The sub-agent takeover: a push, not a cover, so the way back is the
      // navigation bar everyone already knows. Deliberately **not a second
      // attach**: the destination captures this screen's own `vm` and reads the
      // same reduced state, holding its own screen claim (`holdOpen`) so the
      // socket outlives the push — this view's `.task` is cancelled about half
      // a second in, at the end of the push animation.
      //
      // The environment values the transcript rows read are re-applied here:
      // a navigation destination is presented by the enclosing stack, not by
      // this view's subtree, so the `.environment` writes above it do not
      // reliably reach the pushed screen.
      .navigationDestination(item: $subagentId) { taskId in
        SubagentTakeoverView(taskId: taskId, hostId: hostId, vm: vm)
          .environment(\.toolResultFetcher, { vm.loadFullResult(toolUseId: $0) })
          .environment(\.terminalImageLoader, toolImages)
          .environment(\.attachmentLoader, attachmentLoader)
          .environment(\.producedImageLoader, producedImages)
          .environment(\.fileDownloader, downloader)
          .transcriptPreferences(settings)
          .fileDownloadPresentation(downloader)
      }
  }

  // MARK: - The sub-agent takeover

  /// Raise the takeover from a `Task` row's press.
  private func openSubagent(_ taskId: String) {
    // The push happens under whatever the composer was doing; a keyboard held
    // up across it would cover the frame's tail on arrival.
    dismissKeyboard()
    subagentId = taskId
  }

  /// Open the takeover a route asked for — the sessions list's agent line —
  /// once the attach replay has landed.
  ///
  /// Held rather than pushed immediately: the list speaks `SubagentInfo`, which
  /// it knows before this screen has replayed a single event, and a frame over
  /// a half-replayed transcript would honestly-but-wrongly say "not in this
  /// transcript" about an agent that has not arrived yet. Once the hold lifts
  /// the takeover opens **whether or not the `Task` call is present** — the
  /// missing-task state is the takeover's own honest line, never a refused
  /// navigation, exactly as the web never auto-exits a frame it cannot fill.
  /// Rides the same per-event task as `resolveFocus()` and settles the same
  /// way: once asked, never re-asked.
  private func resolveTakeover() {
    guard let taskId = pendingSubagent, vm.session != nil, !vm.replaying else { return }
    pendingSubagent = nil
    subagentId = taskId
  }

  // MARK: - Deep-link focus

  /// Turn the notification's `seq` into the transcript row to open on.
  ///
  /// Resolved **once**, and deliberately not retried as the session moves: this
  /// is where a tap wanted to land, and a later event re-deciding it would drag
  /// the reader somewhere they never asked to go. An unanswerable seq (an event
  /// the gateway's retention dropped, or one that produced no row) leaves the
  /// target nil, which is today's behaviour — the tail.
  ///
  /// Only the terminal renderer honours it; the cards renderer has no row model
  /// to land on, and a deep link there opens at the tail as it always has.
  private func resolveFocus() {
    guard let focusSeq, !focusResolved, let info = vm.session, !vm.replaying else { return }
    if let item = vm.itemIndex(forSeq: focusSeq) {
      focusResolved = true
      focusTarget = .init(item: item, nonce: focusSeq)
      return
    }
    // Nothing to land on *yet*. Give up only once the attach's stated seq has
    // actually been reached — the hold can also end on a stall (see
    // `armReplayHold`), and a transcript that is still filling in has not
    // answered the question, it has merely been shown early.
    if vm.state.lastSeq >= info.lastSeq { focusResolved = true }
  }

  // MARK: - Sub-task reveal

  /// Turn a **task** step's `tool_use` id into the transcript row to open on.
  ///
  /// This is the other half of the agent/task split. An agent step pushes the
  /// takeover (`resolveTakeover()`); a task has no agent behind it and so no
  /// frame — framing its id would select no items and draw an empty screen.
  /// What a task *does* have is a place: the spawning call's own row, sitting
  /// in this session's transcript. So the press opens the session and travels
  /// there, which is exactly the journey a tapped notification already makes.
  /// It rides that machinery rather than a second one:
  /// `toolCallItemIndex` → `focusTarget` → the view's own item→row fold.
  ///
  /// `focusSeq` and `revealToolUseId` both write `focusTarget` and are never
  /// both set — a route comes from a notification or from a step, not both —
  /// and each settles once, so neither can drag the reader after they arrive.
  ///
  /// **Terminal renderer only**, deliberately and out loud: the cards renderer
  /// has no row model to land on, so a reveal there opens at the tail exactly
  /// as a deep link always has. Said here rather than left to no-op silently,
  /// because "the press did nothing" and "the press did the honest thing this
  /// renderer can do" look identical from the outside.
  private func resolveReveal() {
    guard let revealToolUseId, !revealResolved, let info = vm.session, !vm.replaying else { return }
    if let item = toolCallItemIndex(vm.state.items, id: revealToolUseId) {
      revealResolved = true
      // The item index is the nonce: this resolves once per screen, and a
      // second press of the same step is a new route and so a new screen.
      focusTarget = .init(item: item, nonce: item)
      return
    }
    // Not there *yet*. Give up only once the attach's stated seq has been
    // reached — the same settling `resolveFocus()` does, and for the same
    // reason: a transcript still filling in has not answered the question.
    if vm.state.lastSeq >= info.lastSeq { revealResolved = true }
  }

  // MARK: - Unread watermark

  /// Record what is on screen as read — but only while it really is on screen.
  ///
  /// `itemCount` is the rows this transcript has rendered; `activity`/`turns`
  /// come from the attach snapshot, the freshest rollup this screen holds (the
  /// list's poll pauses while a session is open). Not before the attach: a
  /// session opened over a dead link was never *seen*, and a zero mark would
  /// turn its whole history unread.
  private func markSeen() {
    guard scenePhase == .active, let info = vm.session else { return }
    unread.mark(
      host: hostId, sessionId: vm.sessionId, itemCount: vm.state.items.count,
      activity: info.activityCount, turns: info.numTurns)
  }

  /// Leaving (or backgrounding) trues the mark up once — the VS Code panel's
  /// `visibilityChanged` discipline. The in-view marks ran off the attach
  /// snapshot's `activityCount`, so anything the rollup counted since would
  /// read as unread even though it was on screen. Refresh and mark once more;
  /// the mark is about what *was* visible, not what is.
  private func finalizeSeen() {
    guard vm.session != nil else { return }
    let vm = vm
    let unread = unread
    let hostId = hostId
    Task { @MainActor in
      guard let info = await vm.refreshSessionInfo() else { return }
      unread.mark(
        host: hostId, sessionId: vm.sessionId, itemCount: vm.state.items.count,
        activity: info.activityCount, turns: info.numTurns)
    }
  }

  // MARK: - The floating stack

  private var footer: some View {
    // In `terminal` the composer is *docked*: edge to edge, flush with the
    // bottom, its own opaque bar. So the gutter that makes the rest of the stack
    // float moves onto the floating items themselves rather than wrapping
    // everything — padding the whole footer would inset the very thing that must
    // not be.
    let docked = settings.transcriptVariant.isTerminal
    let gutter: CGFloat = 12
    // No gap under the status bar when docked: it and the composer are two bands
    // of one strip, and the rule between them is the composer's own.
    return VStack(spacing: docked ? 0 : 8) {
      if let serverVersion = vm.protocolMismatch {
        WarningStrip(
          text:
            "Server speaks protocol v\(serverVersion), this app mirrors v\(WorkerProtocol.version). Some events may not render."
        )
        .padding(.horizontal, docked ? gutter : 0)
      }
      if let message = vm.lastProtocolError {
        WarningStrip(text: message) { vm.dismissProtocolError() }
          .padding(.horizontal, docked ? gutter : 0)
      }
      if let request = vm.pendingApproval, !isPickerOpen {
        // No wrapper: both prompt views bring their own tinted glass panel, so
        // the coloured card is the floating surface rather than a card inside one.
        approvalBanner(request)
          .padding(.horizontal, docked ? gutter : 0)
          .padding(.bottom, docked ? 8 : 0)
      }
      // The picker gets the screen while it is open: it is a list you are reading,
      // and the status bar is not something you consult mid-completion.
      if !isPickerOpen {
        // Edge to edge in the terminal shape — it draws its own surface and its
        // own hairline, so a gutter would make it a card again.
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
    .padding(.horizontal, docked ? 0 : gutter)
    .padding(.top, 8)
    .padding(.bottom, docked ? 0 : 8)
  }

  private var measuredFooter: some View {
    footer.background(
      GeometryReader { proxy in
        Color.clear.preference(key: FooterHeight.self, value: proxy.size.height)
      })
  }

  /// What stands in for the transcript while the attach replay lands.
  ///
  /// Not `Color.clear`. The hold is bounded by the *stated* end of the replay,
  /// which is right, and on a long session over a phone's network that is
  /// seconds — and a blank screen for seconds is indistinguishable from a
  /// session that failed to open. The counter is the same pair the hold itself
  /// runs on, so it cannot drift from what is actually being waited for.
  @ViewBuilder private var replayPlaceholder: some View {
    if let progress = vm.replayProgress {
      VStack(spacing: 6) {
        ProgressView()
        Text("\(progress.seq.formatted()) / \(progress.target.formatted())")
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .transition(.opacity)
    } else {
      Color.clear
    }
  }

  /// Shown until the session says something. A `ZStack` sibling for the same
  /// reason the picker is one — an overlay on the `ScrollView` would be sized to
  /// its (empty) content — and it steps aside the moment a completion list opens.
  @ViewBuilder
  private var emptyState: some View {
    // `!vm.replaying` is not belt and braces: the hold holds the reduced *state*,
    // so while it stands `items` is legitimately empty and this drew itself
    // underneath the placeholder — "Tell me what to do" behind a spinner, on
    // every open of every session with any history at all.
    if vm.state.items.isEmpty, !isPickerOpen, !vm.replaying {
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

  /// The request at the head of the queue, with its position when there is one.
  ///
  /// Only one prompt is ever on screen — an approval cannot be deferred, so a
  /// stack of them would be a stack of things you must answer in order anyway,
  /// and two tinted cards over a composer is unreadable on a phone. What was
  /// missing is that the queue existed at all: answering one made a second
  /// appear out of nowhere, which reads as the agent having asked twice. So the
  /// head of the queue says how deep it is.
  @ViewBuilder
  private func approvalBanner(_ request: PermissionRequest) -> some View {
    let waiting = vm.state.pendingApprovals.count
    VStack(alignment: .leading, spacing: 4) {
      if waiting > 1 {
        Text("1 of \(waiting) waiting")
          .font(.caption2.weight(.medium))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 4)
          .accessibilityLabel("\(waiting) requests waiting for you")
      }
      approvalPrompt(request)
    }
  }

  /// The branch itself lives in `ApprovalPromptHost`, shared with the sub-agent
  /// takeover's footer: an approval is session-level however deep the call that
  /// raised it, so both of the session's surfaces must be able to answer it.
  @ViewBuilder
  private func approvalPrompt(_ request: PermissionRequest) -> some View {
    ApprovalPromptHost(
      request: request,
      isTerminal: settings.transcriptVariant.isTerminal,
      maxBodyHeight: promptMaxHeight,
      vm: vm)
  }

  /// How tall a prompt's scrolling body may get.
  ///
  /// **Half the screen**, and the half is the whole argument. A prompt is
  /// something you answer *about* the transcript, so leaving the transcript
  /// visible is not decoration — the question is usually "should it run this",
  /// and the evidence is the rows above. It is also what keeps the composer
  /// reachable: deciding sometimes means typing a reason first, and a prompt
  /// that owned the screen would make you dismiss it to do that.
  ///
  /// The floor matters more than the fraction. Before the container has been
  /// measured — the first frame, and any frame where the geometry is zero — an
  /// uncapped `0` would collapse the prompt to nothing, so it falls back to a
  /// height that fits a question and its actions rather than to "unbounded",
  /// which is the bug this whole cap replaces.
  private var promptMaxHeight: CGFloat {
    max(220, containerHeight * 0.5)
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
