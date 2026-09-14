import WorkerDeckKit
import SwiftUI

/// The iPad's detail pane: the project rail, the open files, and the session
/// screen, in the three bands the dashboard's `SessionWorkspace` has.
///
/// The whole column lives inside **one** `NavigationStack`, with the editor
/// pane as a sibling above `SessionView` rather than a layer around it. That is
/// what keeps the header at the top of the screen: `navigationTitle` and
/// `toolbar` are preferences, so `SessionView` still dresses the bar from
/// inside the stack while the tabs and the file sit under it.
///
/// `.id(route)` on the content is load-bearing: the detail pane is one position
/// in the view tree, so without it SwiftUI would hand the next session's screen
/// the previous one's `TranscriptViewModel`, attached to a session nobody is
/// looking at any more.
struct SessionWorkspaceView: View {
  let route: SessionRoute?
  let model: SessionListModel
  let onLeave: () -> Void
  let onCreated: (UUID, SessionInfo) -> Void

  var body: some View {
    content
      .id(route)
  }

  @ViewBuilder
  private var content: some View {
    switch route {
    case .none:
      placeholder
    case .session(let hostId, let sessionId, let seq, let epoch, let subagent, let reveal):
      if let context = model.context(for: hostId) {
        SessionColumn(
          scope: filesScope(hostId: hostId, sessionId: sessionId, context: context),
          session: {
            SessionView(
              sessionId: sessionId, hostId: hostId, client: context.client, focusSeq: seq,
              focusEpoch: epoch, openSubagent: subagent, revealToolUseId: reveal,
              showsFilesAction: false, onLeave: onLeave)
          })
      } else {
        MissingHostView()
      }
    case .create(let hostId, let seed):
      if let context = model.context(for: hostId) {
        NavigationStack {
          CreateSessionView(seed: seed, client: context.client) { info in
            context.rememberCwd(info.cwd)
            onCreated(hostId, info)
          }
          .environment(context)
        }
      } else {
        MissingHostView()
      }
    }
  }

  /// The rail is rooted at the session's working directory, and the list row is
  /// where that is known before the socket has said anything.
  private func filesScope(hostId: UUID, sessionId: String, context: HostContext) -> HostFileScope? {
    guard
      let row = model.rows.first(where: {
        $0.info.id == sessionId && $0.hostId == hostId.uuidString
      })
    else { return nil }
    return HostFileScope(client: context.client, cwd: row.info.cwd)
  }

  private var placeholder: some View {
    ContentUnavailableView {
      Label("No session selected", systemImage: "bubble.left.and.text.bubble.right")
    } description: {
      Text("Pick a session on the left, or start one with the + button.")
    }
  }
}

private struct SessionColumn<Session: View>: View {
  let scope: HostFileScope?
  @ViewBuilder let session: () -> Session

  @Environment(AppSettings.self) private var settings
  @State private var openFiles: OpenFilesModel?
  @State private var editorHeight = EditorPane.defaultHeight
  @State private var columnHeight: CGFloat = 0
  @State private var pendingClose: HostFileModel?

  var body: some View {
    // The rail is *inside* the stack, not beside it: the navigation bar spans
    // the whole detail pane, so a rail outside it was drawn under the bar.
    NavigationStack {
      HStack(spacing: 0) {
        if let scope, !settings.filesRailCollapsed {
          SessionFilesRail(scope: scope, onOpenFile: { openFiles?.open($0) })
        }
        VStack(spacing: 0) {
          if let openFiles, !openFiles.files.isEmpty {
            EditorPane(
              files: openFiles, canWrite: openFiles.canWrite, available: columnHeight,
              height: $editorHeight)
          }
          session()
        }
      }
      .toolbar { chrome }
      .confirmationDialog(
        "Close \(pendingClose.map { Fmt.lastComponent($0.path) } ?? "this file")?",
        isPresented: Binding(
          get: { pendingClose != nil }, set: { if !$0 { pendingClose = nil } }),
        titleVisibility: .visible
      ) {
        Button("Close and lose changes", role: .destructive) {
          if let file = pendingClose { openFiles?.close(file.path) }
          pendingClose = nil
        }
        Button("Keep editing", role: .cancel) { pendingClose = nil }
      } message: {
        Text("It has unsaved edits that were never written to the server.")
      }
    }
    .background(
      GeometryReader { proxy in
        Color.clear.preference(key: ColumnHeight.self, value: proxy.size.height)
      })
    .onPreferenceChange(ColumnHeight.self) { columnHeight = $0 }
    .task(id: scope?.cwd) {
      guard let scope else { return }
      // Rebuilt with the session: a tab is a path on one gateway's disk, and
      // carrying it into a different project would open a file nobody asked for.
      let live = OpenFilesModel(client: scope.client)
      openFiles = live
      await live.loadCapability()
    }
  }

  // One header line: Files on the left, the project and its open tabs in the
  // middle, Save beside the session's own actions on the right. The tabs are a
  // `.principal` item rather than a strip under the bar, which is what collapses
  // what used to be three stacked headers into the one the bar already draws.
  @ToolbarContentBuilder
  private var chrome: some ToolbarContent {
    if let scope, let openFiles {
      ToolbarItem(placement: .principal) {
        EditorTabsBar(
          project: Fmt.lastComponent(scope.cwd), files: openFiles,
          railShown: !settings.filesRailCollapsed,
          onToggleRail: { settings.filesRailCollapsed.toggle() },
          onClose: requestClose)
      }
      ToolbarItem(placement: .topBarTrailing) {
        if let file = openFiles.active, openFiles.canWrite {
          if file.saving {
            ProgressView().controlSize(.small)
          } else {
            Button("Save") { Task { await file.save() } }
              .disabled(!file.isDirty)
          }
        }
      }
    }
  }

  private func requestClose(_ file: HostFileModel) {
    if file.isDirty {
      pendingClose = file
    } else {
      openFiles?.close(file.path)
    }
  }
}

private struct ColumnHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

/// A route can outlive its gateway (deleted mid-navigation, a stale push).
struct MissingHostView: View {
  var body: some View {
    ContentUnavailableView {
      Label("Server removed", systemImage: "server.rack")
    } description: {
      Text("The gateway this session belongs to is no longer configured on this device.")
    }
  }
}
