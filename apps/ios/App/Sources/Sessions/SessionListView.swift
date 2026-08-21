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
    path = [.session(hostId: hostId, sessionId: route.sessionId, seq: route.seq)]
    push.clearRoute()
  }

  // MARK: - Destinations

  @ViewBuilder
  private func destination(_ route: SessionRoute) -> some View {
    switch route {
    case .session(let hostId, let sessionId, let seq):
      if let context = model?.context(for: hostId) {
        SessionView(
          sessionId: sessionId, hostId: hostId, client: context.client, focusSeq: seq)
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

      // A gateway that is unreachable or unauthorized is a visible state — but
      // only when there is nothing else working. With one gateway down and
      // another serving happily, the down one is a fact about a machine, not a
      // problem with what is on screen, and a warning strip over a list that is
      // fine reads as the app being broken. So: banners only while *no* gateway
      // is answering, and then one per host, because which one failed and why
      // is the whole content of the message.
      ForEach(model.allGatewaysDown ? model.failedHosts : [], id: \.host.id) { failed in
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
                  unseen: row.unseen,
                  projectImage: projectImage(for: row, model: model),
                  // Grouped by project, the section header already names it.
                  showsProject: model.config.groupBy != .project)
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

  /// The picture for this row's project, when it declared an image one and the
  /// loader has it. Nil for a glyph (drawn from SF Symbols, no bytes involved),
  /// for bytes not in yet, and for an icon that could not be decoded.
  private func projectImage(for row: SessionRow, model: SessionListModel) -> UIImage? {
    guard case .image(_, let hash) = row.info.project?.icon else { return nil }
    return model.projectIcons.image(forHash: hash)
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
    // A gateway that failed has settled too — it just settled badly. Waiting for
    // `hasLoadedSdkSessions` on a host that will never set it leaves this tab
    // permanently blank, which was survivable only while a banner was there to
    // explain it. Now that one working gateway suppresses the banner, "loaded"
    // has to mean "every host has answered", not "every host succeeded".
    let loaded = hosts.hosts.allSatisfy {
      guard let snapshot = model.snapshots[$0.id] else { return false }
      if case .failed = snapshot.probe { return true }
      return snapshot.hasLoadedSdkSessions
    }
    let empty = hosts.hosts.allSatisfy {
      (model.snapshots[$0.id]?.sdkSessions ?? []).isEmpty
    }
    List {
      // Not while the banner is up: "nothing to resume" under an error strip
      // reads as a fact about the server's disk, and it isn't one. With one
      // gateway working the strip is gone, and then this line is the honest
      // summary of every gateway that actually answered.
      if empty, loaded, !model.allGatewaysDown {
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
            adapters: model.adapters,
            projects: model.projects)
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
  /// Passed as a *value* for the same reason `adapters` is: it is derived from
  /// the session rows, so reading it off the model inside this body would make
  /// every 1.2s refresh invalidate the menu and shut an open dropdown. It is in
  /// the `==` below for the other half of that rule.
  let projects: [ProjectOption]

  /// `nonisolated` because SwiftUI compares views off the main actor. It only
  /// touches value types, so there is nothing to race on.
  nonisolated static func == (lhs: FilterMenu, rhs: FilterMenu) -> Bool {
    lhs.hosts == rhs.hosts && lhs.adapters == rhs.adapters && lhs.projects == rhs.projects
      && lhs.config == rhs.config
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
      if projects.count > 1 {
        Section("Project") {
          ForEach(projects) { project in
            Toggle(project.label, isOn: membership(\.projects, project.key))
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
            Text("Project").tag(GroupBy.project)
          }
        }
        Menu("Sort by") {
          Picker("Sort by", selection: $config.sortBy) {
            Text("Recent").tag(SortBy.recent)
            Text("Name").tag(SortBy.name)
            Text("Gateway").tag(SortBy.gateway)
            Text("Engine").tag(SortBy.adapter)
            Text("State").tag(SortBy.state)
            Text("Project").tag(SortBy.project)
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
/// Internal rather than private so `UIPreviewHarness` can render it against
/// canned data: every project state below (bytes in, bytes not in, a glyph this
/// build cannot map, no project at all) needs a differently-configured gateway
/// to reach in the real app.
struct SessionRowView: View {
  let session: SessionInfo
  /// Named only when more than one gateway is in the list (and the grouping
  /// isn't already saying it).
  var hostName: String?
  /// Transcript rows since this session was last on screen; 0 renders nothing.
  var unseen: Int = 0
  /// Resolved bytes for an `image` project icon, if this project has one and the
  /// loader has fetched it. Nil draws no picture — the name is already there.
  var projectImage: UIImage?
  /// False when the list is already grouped by project: the section header has
  /// said the name, so the slot carries the **sub-path inside the project**
  /// instead (`projectSubpath`) — the one thing the header cannot say. A session
  /// at the project root has nothing to add and the slot disappears. The rule
  /// `hostName` follows one facet over.
  var showsProject: Bool = true

  /// Two lines, in the order the dashboard's row uses
  /// (`packages/ui`'s `SessionBrowser`): what you scan the list by on top, what
  /// it *is* underneath. The same person reads all three clients, so the
  /// segments and their order are not this client's to choose — only how they
  /// are drawn is (a touch-sized row, SF Symbols, `Fmt.ago`).
  ///
  /// State leads both lines, in a gutter the engine's mark lands in underneath.
  /// It used to trail, and a trailing glyph has no fixed x — it sits wherever
  /// the age and the ring leave it, so a list of thirty gives the eye nothing to
  /// run down. Leading, every row's state stacks into one strip.
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        // The gutter: a fixed cell rather than a bare glyph, so the status above
        // and the engine mark below start at the same x however wide either
        // draws — and so the two text columns agree.
        SessionStatusIcon(session: session)
          .frame(width: 14)
          .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
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
        // How full the window is, at a glance and across the whole list — the
        // question you cannot ask from inside a session. Absent draws nothing:
        // an empty ring would claim an empty context where there is simply no
        // reading (see `SessionInfo.contextUsage`).
        if let context = session.contextUsage {
          ContextRing(
            percentage: context.percentage, diameter: 14, lineWidth: 2, showsLabel: false)
            // The ring sits with the caption text, not with the title's cap
            // height — baseline alignment would hang a circle off the row.
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
        }
      }
      // Line two: one truncating run, in one order, so the list reads the same
      // on a phone as it does in a sidebar. A `Text` concatenation rather than
      // an `HStack` of pieces, and that is the point: the parts have a priority
      // order and a single ellipsis honours it, where stack children would each
      // shrink a little and leave four half-words.
      HStack(spacing: 0) {
        // The engine's mark, in the vendor's colour, under the status glyph and
        // in the same 14pt cell. Absent engines draw nothing — the cell keeps
        // the column, so a mark-less row still lines up with its neighbours.
        EngineIconView(engine: session.engine?.rawValue ?? "claude", model: session.model)
          .frame(width: 14)
          .padding(.trailing, 8)
        if let icon = session.project?.icon, project != nil, showsProject {
          ProjectIconView(icon: icon, image: projectImage)
            .padding(.trailing, 3)
        }
        detailsText
          .font(.caption)
          .lineLimit(1)
          // Tail truncation: everything on this line leads with the fact that
          // identifies it, and the sub-path form (`packages/ui`) is read from
          // the front. The old head-truncated raw cwd is gone with the path.
          .truncationMode(.tail)
        // The work under this row, as a count and not a disclosure. The sidebar
        // gets a twisty (`StepToggle` in `packages/ui`); a phone row cannot,
        // because the whole row is one `NavigationLink` and a second tap target
        // inside it is a coin toss under a thumb. The number is the reading
        // anyway — `2/3` while some are still going, a bare total once they have
        // settled — and the session it opens is where they can be read.
        if subagentCount > 0 {
          Spacer(minLength: 6)
          HStack(spacing: 2) {
            Image(systemName: "person.2.fill").imageScale(.small)
            Text(subagentLabelText).monospacedDigit()
          }
          .font(.caption2)
          .foregroundStyle(runningSubagentCount > 0 ? Color.accentColor : .secondary)
          .accessibilityLabel(subagentAccessibilityLabel)
        }
      }
    }
    .padding(.vertical, 3)
  }

  private var subagentCount: Int { session.subagents?.count ?? 0 }
  private var runningSubagentCount: Int { runningSubagents(session).count }

  /// `2/3` while some are still going, `3` once they have all settled — the same
  /// two spellings `StepToggle` picks between, and for the same reason: "how
  /// many are still working" is the live question, and a bare total answers it
  /// wrong the moment one finishes.
  private var subagentLabelText: String {
    let running = runningSubagentCount
    return running > 0 && running < subagentCount ? "\(running)/\(subagentCount)" : "\(subagentCount)"
  }

  private var subagentAccessibilityLabel: String {
    let running = runningSubagentCount
    if running > 0 && running < subagentCount { return "\(running) of \(subagentCount) agents running" }
    return "\(subagentCount) agent\(subagentCount == 1 ? "" : "s")"
  }

  private var title: String {
    if let title = session.title, !title.isEmpty { return title }
    return Fmt.lastComponent(session.cwd)
  }

  /// The project slot: the declared name, or — under a project group — where in
  /// the project this session sits. Nil when there is nothing left to say.
  private var project: String? {
    showsProject ? projectLabel(session) : projectSubpath(session)
  }

  /// Line two, joined the way the dashboard joins it: model, project, gateway,
  /// profile, cost. Nothing empty ever reaches the join, so a missing part
  /// closes up rather than leaving ` ·  · ` behind.
  ///
  /// A `Text` concatenation rather than a `String`, because the model wears the
  /// vendor's colour and the rest does not — and one `Text` built from two is
  /// still one truncating run, which a stack of two would not be.
  private var detailsText: Text {
    // The shared rule, ported into the kit: a model spelled `claude-opus-5` here
    // and `Opus 5` in the sidebar is the same drift the shared list view model
    // exists to prevent.
    let model = friendlyModel(session.model)
    let rest = [
      project,
      hostName,
      session.profile.map { "@\($0)" },
      // `TermFmt.cost`, not `Fmt.cost`: the kit's is the port of the web's
      // `formatCost` ($3.10, and `<$0.01` rather than a fourth decimal), and a
      // list row is exactly where the same person compares the three clients.
      // `Fmt.cost` keeps its four decimals where a *single turn* is priced.
      (session.totalCostUsd ?? 0) > 0 ? TermFmt.cost(session.totalCostUsd) : nil,
    ]
    .compactMap { $0 }
    .joined(separator: " · ")

    guard let model else { return Text(rest).foregroundStyle(.secondary) }
    let head = Text(model).foregroundStyle(modelTint)
    return rest.isEmpty ? head : head + Text(" · " + rest).foregroundStyle(.secondary)
  }

  /// The model name's colour: the vendor's, but only where the vendor's own
  /// guidance allows it past the mark — see `EngineMark.tintsName`, and the note
  /// there on what a full-contrast name does to the title above it.
  private var modelTint: Color {
    guard let mark = engineMark(engine: session.engine?.rawValue ?? "claude", model: session.model),
      mark.tintsName
    else { return .secondary }
    return VendorPalette.color(mark)
  }
}

/// The session's state as one glyph, mirroring the dashboard's
/// `SessionStatusIcon` — same vocabulary, same precedence.
///
/// A glyph rather than the labelled `StatusBadge` this row used to carry: a
/// badge spends a third of a line saying "Idle" for every idle session, and on a
/// list the state is the thing you scan *past* until it is not idle. Waiting on
/// a person still wins over everything, because that is the one state that is
/// about you.
///
/// **It takes the whole `SessionInfo` and asks `sessionState`, rather than a bare
/// status**, and the old signature is why: given only `(status, pendingCount)` it
/// was *unable* to be right. `sessionState` folds in the arm no glyph can see for
/// itself — a **background** sub-agent outlives its turn by design, so the turn
/// ends, `status` comes to rest at `.idle`, and the agent keeps working. Off the
/// raw status this drew a moon on a row filed under the "Working" header.
///
/// The terminal symbols still come off `session.status`, because `.ended`
/// collapses failed and closed into one bucket and those are worth telling apart.
struct SessionStatusIcon: View {
  let session: SessionInfo

  private var status: SessionStatus { session.status }
  private var pendingCount: Int { session.pendingPermissionCount }
  private var state: SessionState { sessionState(session) }

  var body: some View {
    icon
      .font(.caption)
      .accessibilityLabel(label)
  }

  @ViewBuilder
  private var icon: some View {
    if state == .attention {
      // The one state that is about the reader, so it is the one that moves.
      Image(systemName: "bell.badge.fill")
        .foregroundStyle(.orange)
        .symbolEffect(.pulse)
    } else if state == .working {
      ProgressView()
        .controlSize(.mini)
    } else {
      Image(systemName: symbol)
        .foregroundStyle(tint)
    }
  }

  private var symbol: String {
    switch status {
    case .failed: return "exclamationmark.circle.fill"
    case .closed: return "slash.circle"
    case .parked: return "pause.circle.fill"
    default: return "moon.fill"
    }
  }

  private var tint: Color {
    switch status {
    case .failed: return .red
    case .parked: return .purple
    default: return .secondary
    }
  }

  private var label: String {
    if pendingCount > 0, status == .awaitingApproval {
      return "\(status.label) (\(pendingCount))"
    }
    // A background agent working past its turn is the case the status cannot
    // name: "Idle" would be a lie to a screen reader too, not just to the eye.
    let running = runningSubagents(session).count
    if state == .working, status != .running, status != .starting, running > 0 {
      return "Working — \(running) sub-agent\(running == 1 ? "" : "s")"
    }
    return status.label
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
