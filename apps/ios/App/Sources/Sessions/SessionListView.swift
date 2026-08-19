import WorkerDeckKit
import SwiftUI

/// The app's home screen: every gateway's sessions in ONE list, with the gateway
/// as a facet (filter/group/sort) rather than the frame — the model the VS Code
/// extension proved. Search, the three facets, group/sort, and the subset line
/// all come from the shared rules in the kit (`SessionList.swift`); this view
/// only renders what they derive. Owns the navigation stack for everything
/// below, and each route names its gateway explicitly.
struct SessionListView: View {
  @Environment(HostStore.self) private var hosts
  @Environment(PushCoordinator.self) private var push
  @Environment(UnreadModel.self) private var unread
  @Environment(\.scenePhase) private var scenePhase

  @State private var model: SessionListModel?
  @State private var path: [SessionRoute] = []
  @State private var showHostManager = false
  @State private var showSettings = false
  @State private var pendingClose: SessionRow?
  /// The row being renamed, and the text so far. An alert with a text field
  /// rather than an inline editor: a List row is a navigation target on a phone,
  /// so an editable label inside one fights the tap that opens the session.
  @State private var pendingRename: SessionRow?
  @State private var renameText = ""

  /// Restarting identity for the poll loop: any of these changing means the
  /// current loop is polling for the wrong world (or should not run at all).
  private struct PollKey: Hashable {
    var active: Bool
    var hosts: [Host]
  }

  private var pollKey: PollKey {
    PollKey(active: scenePhase == .active && path.isEmpty, hosts: hosts.hosts)
  }

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if let model {
          content(model)
        } else {
          ProgressView()
        }
      }
      .navigationTitle("Sessions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbar }
      .navigationDestination(for: SessionRoute.self) { route in
        destination(route)
      }
    }
    // One task owns both the model's existence and the poll. The poll runs only
    // while the list itself is what's on screen (stack empty, app active): an
    // open session has its own socket, and a backgrounded app has no reader.
    .task(id: pollKey) {
      let live = model ?? SessionListModel(hosts: hosts, unread: unread)
      if model == nil { model = live }
      guard pollKey.active else { return }
      while !Task.isCancelled {
        await live.refresh()
        try? await Task.sleep(for: live.pollInterval)
        if Task.isCancelled { return }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      // The token can change while the app is away, and a gateway restart forgets
      // nothing — but a *first* launch after adding a host might have failed.
      Task { await push.syncRegistrations() }
    }
    // Both an appear and a change: a cold launch from a notification sets the
    // route before this view exists.
    .task(id: push.pendingRoute) { consumePushRoute() }
    .sheet(isPresented: $showHostManager) {
      NavigationStack { HostListView() }
    }
    .sheet(isPresented: $showSettings) {
      NavigationStack { SettingsView() }
    }
  }

  /// Open the session a notification was tapped for. The route names its
  /// gateway; a payload without one (a hand-crafted `simctl push`) falls back to
  /// whichever gateway is showing that session, then to the first host.
  private func consumePushRoute() {
    guard let route = push.pendingRoute else { return }
    let target =
      route.hostId
      ?? model?.rows.first { $0.info.id == route.sessionId }
      .flatMap { UUID(uuidString: $0.hostId) }
      ?? hosts.hosts.first?.id
    guard let hostId = target, hosts.hosts.contains(where: { $0.id == hostId }) else {
      // A route naming a gateway this phone no longer has can never be served.
      push.clearRoute()
      return
    }
    // Replaces rather than appends, so Back from a pushed-to session lands on
    // the list however deep the stack happened to be.
    path = [.session(hostId: hostId, sessionId: route.sessionId)]
    push.clearRoute()
  }

  // MARK: - Destinations

  @ViewBuilder
  private func destination(_ route: SessionRoute) -> some View {
    switch route {
    case .session(let hostId, let sessionId):
      if let context = model?.context(for: hostId) {
        SessionView(sessionId: sessionId, hostId: hostId, client: context.client)
      } else {
        missingHost
      }
    case .create(let hostId, let seed):
      if let context = model?.context(for: hostId) {
        CreateSessionView(seed: seed, client: context.client) { info in
          context.rememberCwd(info.cwd)
          // Replace the create step so Back from the session lands on the list.
          path = [.session(hostId: hostId, sessionId: info.id)]
        }
        .environment(context)
      } else {
        missingHost
      }
    }
  }

  /// A route can outlive its gateway (deleted mid-navigation, a stale push).
  private var missingHost: some View {
    ContentUnavailableView {
      Label("Server removed", systemImage: "server.rack")
    } description: {
      Text("The gateway this session belongs to is no longer configured on this device.")
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

      // A gateway that is unreachable or unauthorized is a visible state, never
      // a broken list: the other gateways' rows are still below.
      ForEach(model.failedHosts, id: \.host.id) { failed in
        ErrorBanner(message: "\(failed.host.displayName): \(failed.message)") {
          Task { await model.refreshCurrentTab() }
        }
        .padding(.horizontal)
        .padding(.bottom, 8)
      }

      // The one "you are seeing a subset" signal — unconditional while it
      // applies, because the controls doing the hiding live behind a menu.
      if model.tab == .live, let subset = model.subset {
        subsetLine(subset, model: model)
      }

      switch model.tab {
      case .live: liveList(model)
      case .resume: resumeList(model)
      }
    }
    // Every switch, not just the first: the other tab's rows are as old as the
    // last time it was on screen, and both lists move without us.
    .onChange(of: model.tab) { _, _ in
      Task { await model.refreshCurrentTab() }
    }
    // The icon badge mirrors the same summed count the list shows — rows unseen
    // over the sessions the filter is showing, never over hidden ones.
    .task(id: model.unseenTotal) {
      await model.syncAppBadge()
    }
    .confirmationDialog(
      "Close this session?",
      isPresented: Binding(get: { pendingClose != nil }, set: { if !$0 { pendingClose = nil } }),
      titleVisibility: .visible
    ) {
      Button("Close session", role: .destructive) {
        if let row = pendingClose {
          Task { await model.close(row) }
        }
        pendingClose = nil
      }
      Button("Cancel", role: .cancel) { pendingClose = nil }
    } message: {
      Text("The run is terminated on the server. Its transcript is no longer attachable.")
    }
    .alert(
      "Rename session",
      isPresented: Binding(
        get: { pendingRename != nil }, set: { if !$0 { pendingRename = nil } })
    ) {
      TextField("Name", text: $renameText)
      Button("Save") {
        if let row = pendingRename {
          Task { await model.rename(row, to: renameText) }
        }
        pendingRename = nil
      }
      Button("Cancel", role: .cancel) { pendingRename = nil }
    } message: {
      // Said out loud because it is not obvious: this is a gateway edit, so the
      // name lands on every client, and clearing it is how you get the derived
      // one back.
      Text("The name is stored on the gateway, so every client sees it. Leave it empty to go back to the derived name.")
    }
  }

  private func subsetLine(_ subset: SubsetSummary, model: SessionListModel) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("\(subset.shown) of \(subset.total)")
        .monospacedDigit()
      Text("· " + subset.causes.joined(separator: " · "))
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 0)
      Button("Show all") {
        model.config = clearFilters(model.config)
      }
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal)
    .padding(.bottom, 8)
  }

  // MARK: - Live list

  @ViewBuilder
  private func liveList(_ model: SessionListModel) -> some View {
    @Bindable var model = model
    List {
      if model.groups.isEmpty, model.hasLoaded {
        emptyState(model)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
      ForEach(model.groups) { group in
        Section {
          ForEach(group.rows) { row in
            if let route = sessionRoute(for: row) {
              NavigationLink(value: route) {
                SessionRowView(
                  session: row.info,
                  // Grouped by gateway, the section header already names it.
                  hostName: showsHostNames(model) && model.config.groupBy != .gateway
                    ? row.hostName : nil,
                  unseen: row.unseen)
              }
              // Two different actions wearing one gesture. Closing a *live*
              // session terminates a run someone may be relying on, so it asks
              // first; removing an already-closed one only drops a finished
              // record off the list, and a confirmation for that is noise.
              .swipeActions(edge: .trailing) {
                if row.info.status == .closed {
                  Button(role: .destructive) {
                    Task { await model.close(row) }
                  } label: {
                    Label("Remove", systemImage: "trash")
                  }
                } else {
                  Button(role: .destructive) { pendingClose = row } label: {
                    Label("Close", systemImage: "xmark.circle")
                  }
                }
              }
              // Renaming is a leading swipe and a context menu, not a
              // destructive-edge action: it is the one thing here that is safe.
              .swipeActions(edge: .leading) {
                Button {
                  renameText = row.info.title ?? ""
                  pendingRename = row
                } label: {
                  Label("Rename", systemImage: "pencil")
                }
                .tint(.accentColor)
              }
              .contextMenu {
                Button {
                  renameText = row.info.title ?? ""
                  pendingRename = row
                } label: {
                  Label("Rename", systemImage: "pencil")
                }
              }
            }
          }
        } header: {
          if let label = group.label {
            Text(label)
          }
        }
      }
    }
    .listStyle(.plain)
    .searchable(text: $model.config.search, placement: .navigationBarDrawer(displayMode: .automatic))
    .refreshable { await model.refresh() }
  }

  /// A gateway name on each card earns its space only when there is more than
  /// one gateway to tell apart.
  private func showsHostNames(_ model: SessionListModel) -> Bool {
    hosts.hosts.count > 1
  }

  @ViewBuilder
  private func emptyState(_ model: SessionListModel) -> some View {
    if !model.anyConnected {
      // The per-host banners above carry the details; this is the summary.
      ContentUnavailableView {
        Label(
          model.failedHosts.isEmpty ? "Connecting…" : "No gateway reachable",
          systemImage: "wifi.slash")
      } description: {
        Text(
          model.failedHosts.isEmpty
            ? "Reaching the configured servers."
            : "Check the servers screen, or that the gateways are still running.")
      }
    } else if model.subset != nil {
      // Rows exist; the filters hide them all. A different sentence — and a
      // different way out — from "there are none".
      ContentUnavailableView {
        Label("No matches", systemImage: "line.3.horizontal.decrease.circle")
      } description: {
        Text("No session matches the current search and filters.")
      } actions: {
        Button("Clear filters") { model.config = clearFilters(model.config) }
      }
    } else {
      ContentUnavailableView {
        Label("No sessions", systemImage: "bubble.left.and.text.bubble.right")
      } description: {
        Text("Start one with the + button, or pick up an earlier one from Resume.")
      }
    }
  }

  private func sessionRoute(for row: SessionRow) -> SessionRoute? {
    UUID(uuidString: row.hostId).map { .session(hostId: $0, sessionId: row.info.id) }
  }

  // MARK: - Resume list

  @ViewBuilder
  private func resumeList(_ model: SessionListModel) -> some View {
    let loaded = hosts.hosts.allSatisfy {
      model.snapshots[$0.id]?.hasLoadedSdkSessions == true
    }
    let empty = hosts.hosts.allSatisfy {
      (model.snapshots[$0.id]?.sdkSessions ?? []).isEmpty
    }
    List {
      // Not while a load failed: "nothing to resume" under an error banner reads
      // as a fact about the server's disk, and it isn't one.
      if empty, loaded, model.failedHosts.isEmpty {
        ContentUnavailableView {
          Label("Nothing to resume", systemImage: "clock.arrow.circlepath")
        } description: {
          Text("Agent SDK sessions stored on each server's disk show up here.")
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      ForEach(hosts.hosts) { host in
        let summaries = model.snapshots[host.id]?.sdkSessions ?? []
        if !summaries.isEmpty {
          Section {
            ForEach(summaries) { summary in
              NavigationLink(
                value: SessionRoute.create(
                  hostId: host.id,
                  seed: CreateSessionSeed(cwd: summary.cwd ?? "", resume: summary.sessionId))
              ) {
                SdkSessionRowView(summary: summary)
              }
            }
          } header: {
            if hosts.hosts.count > 1 {
              Text(host.displayName)
            }
          }
        }
      }
    }
    .listStyle(.plain)
    .refreshable { await model.refreshSdkSessions() }
    .task {
      if !loaded { await model.refreshSdkSessions() }
    }
  }

  // MARK: - Toolbar

  /// Every item carries an explicit `id`, and the filter menu's *content* is a
  /// view of its own. Both halves are load-bearing, and they fix a real bug: the
  /// filter dropdown closed itself whenever anything in the list changed — an
  /// unread badge ticking up was enough — so on a busy gateway it could not be
  /// used at all.
  ///
  /// The mechanism has two parts. The menu read `model.adapters`, which is
  /// *computed from the session rows*, so `@Observable` registered a dependency
  /// on every snapshot the 1.2s poll replaces: the menu's body was invalidated
  /// on each refresh whether or not the engine list had changed. And a
  /// `ToolbarItem` with no `id` is re-identified when the toolbar builder re-runs
  /// — which tears down the presented menu rather than updating it.
  ///
  /// So: stable ids stop the teardown, and `FilterMenu` being `Equatable` over
  /// plain values (never the model) stops the body re-running when the poll
  /// brought nothing this control shows. `if let model` also moved *inside* the
  /// item, because an optional at the top of a `ToolbarItem` makes the item
  /// itself conditional, which is another way to lose identity.
  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(id: "hosts", placement: .topBarLeading) {
      Button { showHostManager = true } label: {
        Label("Servers", systemImage: "server.rack")
      }
    }
    ToolbarItem(id: "settings", placement: .topBarLeading) {
      Button { showSettings = true } label: {
        Label("Settings", systemImage: "gearshape")
      }
    }
    ToolbarItem(id: "filter", placement: .topBarTrailing) {
      Group {
        if let model {
          FilterMenu(
            config: Binding(get: { model.config }, set: { model.config = $0 }),
            hosts: hosts.hosts.map { FilterMenu.Gateway(id: $0.id, name: $0.displayName) },
            adapters: model.adapters)
        }
      }
    }
    ToolbarItem(id: "add", placement: .topBarTrailing) {
      addButton
    }
  }

  /// New session — on which gateway is part of the question now, so with more
  /// than one host the + is a menu naming them.
  @ViewBuilder
  private var addButton: some View {
    if hosts.hosts.count == 1, let host = hosts.hosts.first {
      Button {
        path.append(.create(hostId: host.id, seed: seed(for: host)))
      } label: {
        Label("New session", systemImage: "plus")
      }
    } else {
      Menu {
        ForEach(hosts.hosts) { host in
          Button(host.displayName) {
            path.append(.create(hostId: host.id, seed: seed(for: host)))
          }
        }
      } label: {
        Label("New session", systemImage: "plus")
      }
    }
  }

  private func seed(for host: Host) -> CreateSessionSeed {
    CreateSessionSeed(cwd: model?.context(for: host.id)?.recentCwds.first ?? "")
  }

}

/// The three facets plus the two layout choices. Search is `.searchable` on the
/// list itself; everything else lives here, which is why the subset line above
/// the list is unconditional — with this menu closed it is the only thing saying
/// rows are hidden.
///
/// **A view of its own, and `Equatable` over plain values.** It used to be a
/// method on the list, which meant its body read `model.adapters` — a property
/// *computed from the session rows* — so `@Observable` invalidated it on every
/// one of the 1.2s poll's refreshes, and an open dropdown closed itself as soon
/// as anything moved. An unread badge ticking up was enough. Taking `hosts` and
/// `adapters` as values means SwiftUI can see that a refresh which brought no
/// new engine and no new gateway changes nothing here, and skip the body
/// entirely; the `config` binding still writes straight through to the model.
///
/// The `Binding` is deliberately not in the `==`: two bindings are never equal
/// and comparing them would defeat the whole thing. It is safe to leave out
/// because the *values* it reads — `config` — are covered by `configSnapshot`.
private struct FilterMenu: View, Equatable {
  struct Gateway: Equatable, Identifiable {
    let id: UUID
    let name: String
  }

  @Binding var config: ViewConfig
  let hosts: [Gateway]
  let adapters: [String]

  /// `nonisolated` because SwiftUI compares views off the main actor. It only
  /// touches value types, so there is nothing to race on.
  nonisolated static func == (lhs: FilterMenu, rhs: FilterMenu) -> Bool {
    lhs.hosts == rhs.hosts && lhs.adapters == rhs.adapters && lhs.config == rhs.config
  }

  var body: some View {
    Menu {
      Section("State") {
        ForEach(SessionState.order, id: \.self) { state in
          Toggle(state.label, isOn: membership(\.states, state))
        }
      }
      if hosts.count > 1 {
        Section("Gateway") {
          ForEach(hosts) { host in
            Toggle(host.name, isOn: membership(\.gateways, host.id.uuidString))
          }
        }
      }
      if adapters.count > 1 {
        Section("Engine") {
          ForEach(adapters, id: \.self) { adapter in
            Toggle(adapter, isOn: membership(\.adapters, adapter))
          }
        }
      }
      Section {
        Menu("Group by") {
          Picker("Group by", selection: $config.groupBy) {
            Text("None").tag(GroupBy.none)
            Text("Gateway").tag(GroupBy.gateway)
            Text("Engine").tag(GroupBy.adapter)
            Text("State").tag(GroupBy.state)
          }
        }
        Menu("Sort by") {
          Picker("Sort by", selection: $config.sortBy) {
            Text("Recent").tag(SortBy.recent)
            Text("Name").tag(SortBy.name)
            Text("Gateway").tag(SortBy.gateway)
            Text("Engine").tag(SortBy.adapter)
            Text("State").tag(SortBy.state)
          }
        }
      }
    } label: {
      Label(
        "Filter",
        systemImage: facetFilterOn
          ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
    }
  }

  /// Whether a *facet* is filtering (the funnel's fill). Search shows its own
  /// state in the search field, so it does not light the funnel too.
  private var facetFilterOn: Bool {
    !config.gateways.isEmpty || !config.adapters.isEmpty || !config.states.isEmpty
  }

  /// A Toggle binding for membership of one value in one facet array.
  private func membership<Value: Equatable>(
    _ keyPath: WritableKeyPath<ViewConfig, [Value]>, _ value: Value
  ) -> Binding<Bool> {
    Binding(
      get: { config[keyPath: keyPath].contains(value) },
      set: { on in
        if on {
          if !config[keyPath: keyPath].contains(value) { config[keyPath: keyPath].append(value) }
        } else {
          config[keyPath: keyPath].removeAll { $0 == value }
        }
      })
  }
}

/// One live session. Title falls back to the working directory's leaf, which is
/// what the session is "about" before the agent has said anything.
private struct SessionRowView: View {
  let session: SessionInfo
  /// Named only when more than one gateway is in the list (and the grouping
  /// isn't already saying it).
  var hostName: String?
  /// Transcript rows since this session was last on screen; 0 renders nothing.
  var unseen: Int = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title)
          .font(.body.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 0)
        if unseen > 0 {
          Text("\(unseen)")
            .font(.caption2.weight(.semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(.tint))
            .accessibilityLabel("\(unseen) new rows")
        }
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
        if let hostName {
          Label(hostName, systemImage: "server.rack")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
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
