import WorkerDeckKit
import SwiftUI

/// The live session: one `SessionHandle`, one `TranscriptState`, and the three
/// bands that sit on top of them — HUD, transcript, composer.
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
  /// Built once the session's cwd is known, and rebuilt if it changes — both the
  /// browser and `@file` completion are scoped to that directory.
  @State private var completion: FileCompletionModel?
  /// Owns the share sheet for files tapped in the transcript. The details sheet
  /// has its own — a sheet can't raise another sheet from underneath itself.
  @State private var downloader = FileDownloader()

  init(sessionId: String, client: WorkerClient) {
    _vm = State(initialValue: TranscriptViewModel(sessionId: sessionId, client: client))
  }

  var body: some View {
    TranscriptListView(items: vm.state.items, revision: vm.revision)
      .safeAreaInset(edge: .top, spacing: 0) { header }
      .safeAreaInset(edge: .bottom, spacing: 0) { footer }
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
        completion = vm.hostFiles.map { FileCompletionModel(scope: $0) }
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

  // MARK: - Bands

  private var header: some View {
    VStack(spacing: 0) {
      SessionHUDView(
        status: vm.state.status,
        pendingCount: vm.state.pendingApprovals.count,
        isConnected: vm.isConnected,
        contextUsage: vm.state.contextUsage,
        rateLimits: vm.rateLimitWindows
      ) {
        showDetails = true
      }
      if let serverVersion = vm.protocolMismatch {
        WarningStrip(
          text:
            "Server speaks protocol v\(serverVersion), this app mirrors v\(WorkerProtocol.version). Some events may not render.")
      }
      if let message = vm.lastProtocolError {
        WarningStrip(text: message) { vm.dismissProtocolError() }
      }
      Divider()
    }
  }

  private var footer: some View {
    VStack(spacing: 0) {
      if let request = vm.pendingApproval {
        approvalBanner(request)
          .padding(.horizontal, 12)
          .padding(.top, 8)
          .background(.bar)
      }
      ComposerView(
        text: $draft,
        isBusy: vm.state.status == .running,
        isEnabled: vm.state.status != .closed,
        completion: completion,
        onSend: {
          vm.send(draft)
          draft = ""
        },
        onStop: { vm.interrupt() })
    }
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
        if let models = vm.state.models, !models.isEmpty {
          Menu("Model") {
            ForEach(models) { option in
              Button {
                vm.setModel(option.value)
              } label: {
                CheckedLabel(option.displayName, isChecked: option.value == vm.state.model)
              }
            }
            Divider()
            Button("Server default") { vm.setModel(nil) }
          }
        }

        Menu("Permissions") {
          ForEach(permissionModes, id: \.self) { mode in
            Button {
              vm.setPermissionMode(mode)
            } label: {
              CheckedLabel(mode.label, isChecked: mode == vm.state.permissionMode)
            }
          }
        }

        Divider()
        Button("Session details") { showDetails = true }
        Button("Interrupt", systemImage: "stop.circle") { vm.interrupt() }
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

/// Menu row with a checkmark for the current choice. An `Image` is only emitted
/// when checked — an empty `systemImage` would log a missing-symbol warning.
private struct CheckedLabel: View {
  private let title: String
  private let isChecked: Bool

  init(_ title: String, isChecked: Bool) {
    self.title = title
    self.isChecked = isChecked
  }

  var body: some View {
    if isChecked {
      Label(title, systemImage: "checkmark")
    } else {
      Text(title)
    }
  }
}

/// A one-line, dismissible advisory strip under the HUD.
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
    .padding(.horizontal, 14)
    .padding(.vertical, 5)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.orange.opacity(0.12))
  }
}
