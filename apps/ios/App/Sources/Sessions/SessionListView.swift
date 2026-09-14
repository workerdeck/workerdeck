import WorkerDeckKit
import SwiftUI

/// The app's home screen: every gateway's sessions in ONE list, with the gateway
/// as a facet (filter/group/sort) rather than the frame — the model the VS Code
/// extension proved. Search, the three facets, group/sort, and the subset line
/// all come from the shared rules in the kit (`SessionList.swift`); this view
/// only renders what they derive. Owns the routing for everything below — a
/// stack at compact width, a split view's sidebar at regular — and each route
/// names its gateway explicitly.
struct SessionListView: View {
  @Environment(HostStore.self) private var hosts
  @Environment(PushCoordinator.self) private var push
  @Environment(UnreadModel.self) private var unread
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.horizontalSizeClass) private var sizeClass

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
  /// Session ids whose agent lines are showing. Not persisted: a disclosure is
  /// about the glance you are having, and a list that reopened yesterday's
  /// twisties would be answering a question nobody asked twice.
  @State private var expandedAgents: Set<String> = []
  @State private var columnVisibility: NavigationSplitViewVisibility = .all

  // A regular width is the whole iPad claim: the list stops being a screen you
  // leave and becomes a column you keep. Size class rather than idiom, so a
  // Slide Over or a narrow multitasking split correctly gets the phone's stack.
  private var isSplit: Bool { sizeClass == .regular }

  /// Restarting identity for the poll loop: any of these changing means the
  /// current loop is polling for the wrong world (or should not run at all).
  private struct PollKey: Hashable {
    var active: Bool
    var hosts: [Host]
  }

  private var pollKey: PollKey {
    // Split keeps the list on screen behind an open session, so it keeps polling.
    PollKey(active: scenePhase == .active && (path.isEmpty || isSplit), hosts: hosts.hosts)
  }

  var body: some View {
    Group {
      if isSplit {
        splitLayout
      } else {
        stackLayout
      }
    }
    // One task owns both the model's existence and the poll. The poll runs only
    // while the list itself is on screen and the app is active: a session the
    // stack covered the list with has its own socket, and a backgrounded app has
    // no reader.
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

  private var stackLayout: some View {
    NavigationStack(path: $path) {
      listColumn
        .navigationDestination(for: SessionRoute.self) { route in
          destination(route)
        }
    }
  }

  private var splitLayout: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      listColumn
    } detail: {
      if let model {
        SessionWorkspaceView(
          route: path.first, model: model, onLeave: { path = [] },
          onCreated: { hostId, info in open(.session(hostId: hostId, sessionId: info.id)) })
      } else {
        ProgressView()
      }
    }
    .navigationSplitViewStyle(.balanced)
  }

  private var listColumn: some View {
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
    .navigationSplitViewColumnWidth(min: 320, ideal: 360, max: 460)
  }

  // The one way into a session, from either layout. Assignment rather than
  // append because the list never pushes deeper than one: the stack's root is
  // the list, and the split's detail is a single pane.
  private func open(_ route: SessionRoute) {
    path = [route]
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
    open(
      .session(hostId: hostId, sessionId: route.sessionId, seq: route.seq, epoch: route.epoch))
    push.clearRoute()
  }

  // MARK: - Destinations

  @ViewBuilder
  private func destination(_ route: SessionRoute) -> some View {
    switch route {
    case .session(let hostId, let sessionId, let seq, let epoch, let subagent, let reveal):
      if let context = model?.context(for: hostId) {
        SessionView(
          sessionId: sessionId, hostId: hostId, client: context.client, focusSeq: seq,
          focusEpoch: epoch, openSubagent: subagent, revealToolUseId: reveal)
      } else {
        MissingHostView()
      }
    case .create(let hostId, let seed):
      if let context = model?.context(for: hostId) {
        CreateSessionView(seed: seed, client: context.client) { info in
          context.rememberCwd(info.cwd)
          open(.session(hostId: hostId, sessionId: info.id))
        }
        .environment(context)
      } else {
        MissingHostView()
      }
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
              SessionCardView(
                row: row,
                onOpen: { open(route) },
                // Grouped by gateway, the section header already names it.
                hostName: showsHostNames(model) && model.config.groupBy != .gateway
                  ? row.hostName : nil,
                projectImage: projectImage(for: row, model: model),
                // Grouped by project, the section header already names it.
                showsProject: model.config.groupBy != .project,
                expanded: expandedAgents.contains(row.info.id),
                onToggle: { toggleAgents(row) },
                menu: { rowActions(for: row, model: model) })
              .listRowBackground(selectionBackground(for: route))
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
              .contextMenu { rowActions(for: row, model: model) }
              if expandedAgents.contains(row.info.id) {
                stepRows(for: row)
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

  // Every non-navigating thing a row can do, in one builder, because the row
  // offers three ways in and they must not drift apart: the card's persistent
  // `···`, a long press, and (for the destructive half) a trailing swipe. Close
  // and Remove are the same gesture wearing two meanings — see the swipe.
  @ViewBuilder
  private func rowActions(for row: SessionRow, model: SessionListModel) -> some View {
    Button {
      renameText = row.info.title ?? ""
      pendingRename = row
    } label: {
      Label("Rename", systemImage: "pencil")
    }
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

  // The split view's detail pane has no back button, so the list is the only
  // thing that can say which session it is showing.
  @ViewBuilder
  private func selectionBackground(for route: SessionRoute) -> some View {
    if isSplit, path.first == route {
      Color.accentColor.opacity(0.14)
    } else {
      Color.clear
    }
  }

  private func sessionRoute(for row: SessionRow) -> SessionRoute? {
    UUID(uuidString: row.hostId).map { .session(hostId: $0, sessionId: row.info.id) }
  }

  // MARK: - Step lines

  private func toggleAgents(_ row: SessionRow) {
    if expandedAgents.contains(row.info.id) {
      expandedAgents.remove(row.info.id)
    } else {
      expandedAgents.insert(row.info.id)
    }
  }

  /// One row per step, **agents first** and **all of them pressable** — the
  /// order and the kind both come from the kit's `sessionSteps`, which is the
  /// same derivation the dashboard and the extension draw from.
  ///
  /// Rows rather than a stack inside the session row: a full-width list row is
  /// a real thumb target where a line inside a two-line row is not, and it
  /// keeps the promise the disclosure makes — every target here has its own
  /// frame.
  ///
  /// **What a press means is what tells the two kinds apart**, and that is the
  /// whole of it. An *agent* has work of its own, so it opens that agent's
  /// takeover. A *task* is a reference to a place in this transcript, so it
  /// opens the session and travels to that tool call's row (`reveal:`). A task
  /// used to be drawn inert here, on the argument that there was nowhere to
  /// send it — but there always was, and a row that looks like a list item,
  /// sits in a list, and does nothing under a thumb is the worse lie. Both go
  /// through `open` to the same case with different payloads, so this is one row
  /// shape with one destination type, not a variant branch inside a row.
  @ViewBuilder
  private func stepRows(for row: SessionRow) -> some View {
    ForEach(sessionSteps(row.info)) { step in
      let route = UUID(uuidString: row.hostId).map {
        SessionRoute.step(hostId: $0, sessionId: row.info.id, step: step)
      }
      Group {
        if let route {
          Button { open(route) } label: { SessionStepRow(step: step) }
            .buttonStyle(.plain)
        } else {
          // No gateway id to route to — a shape this list has never actually
          // produced, but the row still draws rather than vanishing.
          SessionStepRow(step: step)
        }
      }
      .listRowInsets(EdgeInsets(top: 4, leading: 40, bottom: 4, trailing: 16))
    }
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
              Button {
                open(
                  .create(
                    hostId: host.id,
                    seed: CreateSessionSeed(cwd: summary.cwd ?? "", resume: summary.sessionId)))
              } label: {
                SdkSessionRowView(summary: summary)
              }
              .buttonStyle(.plain)
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
    // The sidebar is narrower than a phone's bar and carries the split view's
    // own toggle as well, so these two fold into one menu there rather than
    // being pushed into the system's "…" overflow.
    if isSplit {
      ToolbarItem(id: "app", placement: .topBarLeading) {
        Menu {
          Button("Servers", systemImage: "server.rack") { showHostManager = true }
          Button("Settings", systemImage: "gearshape") { showSettings = true }
        } label: {
          Label("App", systemImage: "gearshape")
        }
      }
    } else {
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
        open(.create(hostId: host.id, seed: seed(for: host)))
      } label: {
        Label("New session", systemImage: "plus")
      }
    } else {
      Menu {
        ForEach(hosts.hosts) { host in
          Button(host.displayName) {
            open(.create(hostId: host.id, seed: seed(for: host)))
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
