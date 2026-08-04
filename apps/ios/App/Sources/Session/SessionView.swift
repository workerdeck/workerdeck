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
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss

  @State private var vm: TranscriptViewModel
  @State private var draft = ""
  @State private var showDetails = false
  @State private var showFiles = false
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
      picker
    }
    .onPreferenceChange(FooterHeight.self) { footerHeight = $0 }
    .navigationTitle(vm.title)
    .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbarMenu }
      .environment(\.fileDownloader, downloader)
      .fileDownloadPresentation(downloader)
      .task {
        downloader.access = vm.fileAccess
        await vm.run()
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active { vm.reconnectNow() }
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
      .sheet(isPresented: $showFiles) {
        if let scope = vm.hostFiles {
          HostFilesView(scope: scope)
        }
      }
      .sheet(isPresented: $showDetails) {
        SessionDetailSheet(
          state: vm.state, session: vm.session, rateLimits: vm.rateLimitWindows,
          fileAccess: vm.fileAccess)
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
        approvalBanner(request)
          .padding(12)
          .glassPanel(cornerRadius: 20)
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
        onEdit: { text, caret in
          completion.update(for: text, cursor: Range(caret, in: text)?.lowerBound)
        },
        onSend: send,
        onStop: { vm.interrupt() })
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
    vm.send(draft)
    draft = ""
    selection = NSRange(location: 0, length: 0)
    // Keep the keyboard up: a remote control is used in bursts.
    isComposerFocused = true
  }

  private var statusBar: some View {
    SessionStatusBar(
      status: vm.state.status,
      pendingCount: vm.state.pendingApprovals.count,
      connection: vm.connection,
      contextUsage: vm.state.contextUsage,
      rateLimits: vm.hudRateLimits,
      totalCostUsd: vm.state.totalCostUsd,
      model: vm.state.model,
      models: vm.state.models ?? [],
      permissionMode: vm.state.permissionMode,
      permissionModes: permissionModes,
      onSelectModel: { vm.setModel($0) },
      onSelectPermissionMode: { vm.setPermissionMode($0) },
      onOpenDetails: { showDetails = true })
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
        Button { showFiles = true } label: {
          Label("Files", systemImage: "folder")
        }
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Button("Session details", systemImage: "info.circle") { showDetails = true }
        Divider()
        Button("Close session", systemImage: "xmark.circle", role: .destructive) {
          showCloseConfirmation = true
        }
      } label: {
        Label("Session actions", systemImage: "ellipsis.circle")
      }
    }
  }

  /// Only the modes this session's engine implements — the provider engine
  /// supports a subset, and the rest would be rejected server-side.
  private var permissionModes: [PermissionMode] {
    PermissionMode.allCases.filter { supportsPermissionMode(engine: vm.engine, mode: $0) }
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
