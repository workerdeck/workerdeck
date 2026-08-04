import WorkerDeckKit
import SwiftUI

/// The host's home screen: live sessions, plus a Resume tab over the Agent SDK's
/// on-disk sessions. Owns the navigation stack for everything below it.
struct SessionListView: View {
  @Environment(HostContext.self) private var context
  @Environment(HostStore.self) private var hosts
  @Environment(PushCoordinator.self) private var push
  @Environment(\.scenePhase) private var scenePhase

  @State private var model: SessionListModel?
  @State private var path: [SessionRoute] = []
  @State private var showHostSwitcher = false
  @State private var pendingClose: SessionInfo?

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if let model {
          content(model)
        } else {
          ProgressView()
        }
      }
      .navigationTitle(context.host.displayName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbar }
      .navigationDestination(for: SessionRoute.self) { route in
        switch route {
        case .session(let id):
          SessionView(sessionId: id, client: context.client)
        case .create(let seed):
          CreateSessionView(seed: seed, client: context.client) { info in
            context.rememberCwd(info.cwd)
            // Replace the create step so Back from the session lands on the list.
            path = [.session(info.id)]
          }
        }
      }
    }
    .task {
      let live = model ?? SessionListModel(client: context.client)
      model = live
      if !live.hasLoaded { await live.refresh() }
    }
    // Back from a session (or from create) means the list has been out of date for
    // as long as that session was open — the registry moved on without us. The
    // `.task` above only fires once, so this is what makes the list current.
    .onChange(of: path) { _, stack in
      guard stack.isEmpty, let model else { return }
      Task { await model.refreshCurrentTab() }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      // The token can change while the app is away, and a gateway restart forgets
      // nothing — but a *first* launch after adding a host might have failed.
      Task { await push.syncRegistrations() }
      guard let model, path.isEmpty else { return }
      Task { await model.refreshCurrentTab() }
    }
    // Both an appear and a change: this subtree is rebuilt wholesale when a push
    // switches hosts, and after that rebuild there is no change left to observe.
    .task(id: push.pendingRoute) { consumePushRoute() }
    .sheet(isPresented: $showHostSwitcher) {
      NavigationStack { HostListView() }
    }
  }

  /// Open the session a notification was tapped for. A route naming a *different*
  /// gateway is left alone: `RootView` is mid-switch and this subtree is about to
  /// be replaced by the one that should handle it.
  private func consumePushRoute() {
    guard let route = push.pendingRoute else { return }
    if let hostId = route.hostId, hostId != context.host.id { return }
    // Replaces rather than appends, so Back from a pushed-to session lands on
    // the list however deep the stack happened to be.
    path = [.session(route.sessionId)]
    push.clearRoute()
  }

  // MARK: - Content

  @ViewBuilder
  private func content(_ model: SessionListModel) -> some View {
    @Bindable var model = model
    VStack(spacing: 0) {
      Picker("View", selection: $model.tab) {
        ForEach(SessionListModel.Tab.allCases) { tab in
          Text(tab.label).tag(tab)
        }
      }
      .pickerStyle(.segmented)
      .padding(.horizontal)
      .padding(.bottom, 8)

      if let message = model.errorMessage {
        ErrorBanner(message: message) {
          Task { await model.refreshCurrentTab() }
        }
        .padding(.horizontal)
        .padding(.bottom, 8)
      }

      switch model.tab {
      case .live: liveList(model)
      case .resume: resumeList(model)
      }
    }
    // Every switch, not just the first: the other tab's rows are as old as the last
    // time it was on screen, and both lists move without us.
    .onChange(of: model.tab) { _, _ in
      Task { await model.refreshCurrentTab() }
    }
    .confirmationDialog(
      "Close this session?",
      isPresented: Binding(get: { pendingClose != nil }, set: { if !$0 { pendingClose = nil } }),
      titleVisibility: .visible
    ) {
      Button("Close session", role: .destructive) {
        if let session = pendingClose {
          Task { await model.close(session) }
        }
        pendingClose = nil
      }
      Button("Cancel", role: .cancel) { pendingClose = nil }
    } message: {
      Text("The run is terminated on the server. Its transcript is no longer attachable.")
    }
  }

  @ViewBuilder
  private func liveList(_ model: SessionListModel) -> some View {
    List {
      if model.sessions.isEmpty, model.hasLoaded, model.errorMessage == nil {
        ContentUnavailableView {
          Label("No sessions", systemImage: "bubble.left.and.text.bubble.right")
        } description: {
          Text("Start one with the + button, or pick up an earlier one from Resume.")
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      ForEach(model.sessions) { session in
        NavigationLink(value: SessionRoute.session(session.id)) {
          SessionRowView(session: session)
        }
        .swipeActions(edge: .trailing) {
          Button(role: .destructive) { pendingClose = session } label: {
            Label("Close", systemImage: "xmark.circle")
          }
        }
      }
    }
    .listStyle(.plain)
    .refreshable { await model.refresh() }
  }

  @ViewBuilder
  private func resumeList(_ model: SessionListModel) -> some View {
    List {
      // Not while the load failed: "nothing to resume" under an error banner reads
      // as a fact about the server's disk, and it isn't one.
      if model.sdkSessions.isEmpty, model.hasLoadedSdkSessions, model.errorMessage == nil {
        ContentUnavailableView {
          Label("Nothing to resume", systemImage: "clock.arrow.circlepath")
        } description: {
          Text("Agent SDK sessions stored on the server's disk show up here.")
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      ForEach(model.sdkSessions) { summary in
        NavigationLink(
          value: SessionRoute.create(
            CreateSessionSeed(cwd: summary.cwd ?? "", resume: summary.sessionId))
        ) {
          SdkSessionRowView(summary: summary)
        }
      }
    }
    .listStyle(.plain)
    .refreshable { await model.refreshSdkSessions() }
  }

  // MARK: - Toolbar

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button { showHostSwitcher = true } label: {
        Label("Servers", systemImage: "server.rack")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Button {
        path.append(.create(CreateSessionSeed(cwd: context.recentCwds.first ?? "")))
      } label: {
        Label("New session", systemImage: "plus")
      }
    }
  }
}

/// One live session. Title falls back to the working directory's leaf, which is
/// what the session is "about" before the agent has said anything.
private struct SessionRowView: View {
  let session: SessionInfo

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title)
          .font(.body.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 0)
        if let activity = session.lastActivityAt {
          Text(Fmt.ago(epochMs: activity))
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }
      Text(session.cwd)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.head)
      HStack(spacing: 8) {
        StatusBadge(status: session.status, pendingCount: session.pendingPermissionCount)
        if let model = session.model {
          Text(model)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        if let cost = session.totalCostUsd, cost > 0 {
          Text(Fmt.cost(cost))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
        }
      }
    }
    .padding(.vertical, 3)
  }

  private var title: String {
    if let title = session.title, !title.isEmpty { return title }
    return Fmt.lastComponent(session.cwd)
  }
}

private struct SdkSessionRowView: View {
  let summary: SdkSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(summary.summary.isEmpty ? summary.sessionId : summary.summary)
        .font(.body)
        .lineLimit(2)
      HStack(spacing: 8) {
        if let cwd = summary.cwd {
          Text(Fmt.lastComponent(cwd))
            .lineLimit(1)
        }
        if let branch = summary.gitBranch, !branch.isEmpty {
          Label(branch, systemImage: "arrow.branch")
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        Text(Fmt.ago(epochMs: summary.lastModified))
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .padding(.vertical, 3)
  }
}
