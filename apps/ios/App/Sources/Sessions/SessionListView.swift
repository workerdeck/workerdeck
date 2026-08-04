import WorkerDeckKit
import SwiftUI

/// The host's home screen: live sessions, plus a Resume tab over the Agent SDK's
/// on-disk sessions. Owns the navigation stack for everything below it.
struct SessionListView: View {
  @Environment(HostContext.self) private var context
  @Environment(HostStore.self) private var hosts
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
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active, let model, path.isEmpty else { return }
      Task { await model.refreshCurrentTab() }
    }
    .sheet(isPresented: $showHostSwitcher) {
      NavigationStack { HostListView() }
    }
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
    .onChange(of: model.tab) { _, tab in
      guard tab == .resume, model.sdkSessions.isEmpty else { return }
      Task { await model.refreshSdkSessions() }
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
      if model.sdkSessions.isEmpty {
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
