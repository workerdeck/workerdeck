import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

/// The app's home screen: every gateway's sessions in ONE list, with the gateway
/// as a facet (filter/group/sort) rather than the frame - the model the VS Code
/// extension proved. Search, the three facets, group/sort, teams, steps and the
/// subset line all come from the native core's `SessionList`; this view only
/// renders what it derives. Owns the navigation stack for everything
/// below, and each route names its gateway explicitly.
struct SessionListView: View {
  @Environment(HostStore.self) private var hosts
  @Environment(PushCoordinator.self) private var push
  @Environment(UnreadModel.self) private var unread
  @Environment(AppSettings.self) private var settings
  @Environment(\.scenePhase) private var scenePhase

  @State private var model: SessionListModel?
  @State private var path: [SessionRoute] = []
  @State private var showHostManager = false
  @State private var showSettings = false
  @State private var pendingClose: ListItem?
  /// The row being renamed, and the text so far. An alert with a text field
  /// rather than an inline editor: a List row is a navigation target on a phone,
  /// so an editable label inside one fights the tap that opens the session.
  @State private var pendingRename: ListItem?
  @State private var renameText = ""
  @State private var pendingStatus: ListItem?
  @State private var statusText = ""
  @State private var pendingRetire: ListItem?
  @State private var pendingCrossing: Crossing?

  private struct Crossing {
    let row: ListItem
    let lead: TeamLead
    let owner: String
  }
  /// The search bar is shown on request, like the dashboard's; closing it
  /// clears the query, so a hidden search can never be what empties the list.
  @State private var searchOpen = false
  @State private var clock = Date()

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
      // nothing - but a *first* launch after adding a host might have failed.
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
      ?? hosts.hosts.first { model?.info(hostId: $0.id.uuidString, sessionId: route.sessionId) != nil }?.id
      ?? hosts.hosts.first?.id
    guard let hostId = target, hosts.hosts.contains(where: { $0.id == hostId }) else {
      // A route naming a gateway this phone no longer has can never be served.
      push.clearRoute()
      return
    }
    // Replaces rather than appends, so Back from a pushed-to session lands on
    // the list however deep the stack happened to be.
    path = [
      .session(
        hostId: hostId, sessionId: route.sessionId, seq: route.seq, epoch: route.epoch)
    ]
    push.clearRoute()
  }

  // MARK: - Destinations

  @ViewBuilder
  private func destination(_ route: SessionRoute) -> some View {
    switch route {
    case .session(let hostId, let sessionId, let seq, let epoch, let subagent, let reveal, let shell):
      if let context = model?.context(for: hostId) {
        CoreSessionView(
          sessionId: sessionId, hostId: hostId, client: context.client,
          entry: SessionRoute.entry(seq: seq, epoch: epoch, subagent: subagent, reveal: reveal, shell: shell))
      } else {
        missingHost
      }
    case .create(let hostId, let seed):
      createScreen(hostId, seed)
    }
  }

  @ViewBuilder
  private func createScreen(_ hostId: UUID, _ seed: CreateSessionSeed) -> some View {
    if let model, let context = model.context(for: hostId) {
      CreateSessionView(
        form: model.createForm(for: hostId, seed: seed), client: context.client,
        onAgentCreated: { response in
          if let cwd = response.agent.config.cwd { context.rememberCwd(cwd) }
          path = response.session.map { [.session(hostId: hostId, sessionId: $0.id)] } ?? []
        }
      ) { info in
        context.rememberCwd(info.cwd)
        // Replace the create step so Back from the session lands on the list.
        path = [.session(hostId: hostId, sessionId: info.id)]
      }
      .environment(context)
    } else {
      missingHost
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

      // A gateway that is unreachable or unauthorized is a visible state - but
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

      // The one "you are seeing a subset" signal - unconditional while it
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
    // The icon badge mirrors the same summed count the list shows - rows unseen
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
      pendingRename?.info.agent != nil ? "Rename agent" : "Rename session",
      isPresented: Binding(
        get: { pendingRename != nil }, set: { if !$0 { pendingRename = nil } })
    ) {
      TextField("Name", text: $renameText)
      Button("Save") {
        if let row = pendingRename {
          if row.info.agent != nil {
            Task { await model.renameAgent(row, to: renameText) }
          } else {
            Task { await model.rename(row, to: renameText) }
          }
        }
        pendingRename = nil
      }
      Button("Cancel", role: .cancel) { pendingRename = nil }
    } message: {
      // Said out loud because it is not obvious: this is a gateway edit, so the
      // name lands on every client, and clearing it is how you get the derived
      // one back.
      Text(
        pendingRename?.info.agent != nil
          ? "The agent keeps this name across conversations, on every client."
          : "The name is stored on the gateway, so every client sees it. Leave it empty to go back to the derived name.")
    }
    .alert(
      "Status",
      isPresented: Binding(get: { pendingStatus != nil }, set: { if !$0 { pendingStatus = nil } })
    ) {
      TextField("What it is doing", text: $statusText)
      Button("Save") {
        if let row = pendingStatus {
          Task { await model.setStatus(row, to: statusText) }
        }
        pendingStatus = nil
      }
      Button("Cancel", role: .cancel) { pendingStatus = nil }
    } message: {
      Text("A short line under the name, on every client. Leave it empty to clear it.")
    }
    .confirmationDialog(
      "Retire \(pendingRetire?.info.agent?.name ?? "this agent")?",
      isPresented: Binding(get: { pendingRetire != nil }, set: { if !$0 { pendingRetire = nil } }),
      titleVisibility: .visible
    ) {
      Button("Retire", role: .destructive) {
        if let row = pendingRetire {
          Task { await model.retire(row) }
        }
        pendingRetire = nil
      }
      Button("Cancel", role: .cancel) { pendingRetire = nil }
    } message: {
      Text(
        "The agent and its session end. "
          + (pendingRetire?.info.agent?.isLead == true
            ? "Its members are released and stay as agents. " : "")
          + "Past conversations stay resumable from the engine's store.")
    }
    .alert(
      "Join another owner's team?",
      isPresented: Binding(get: { pendingCrossing != nil }, set: { if !$0 { pendingCrossing = nil } })
    ) {
      Button("Join") {
        if let crossing = pendingCrossing {
          Task { await model.join(crossing.row, lead: crossing.lead, crossOwner: true) }
        }
        pendingCrossing = nil
      }
      Button("Cancel", role: .cancel) { pendingCrossing = nil }
    } message: {
      Text(
        "\(pendingCrossing?.lead.name ?? "This lead") belongs to \(pendingCrossing?.owner ?? "another owner"). Its team will be able to message and read this agent.")
    }
    .alert(
      "Something went wrong",
      isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    ) {
      Button("OK", role: .cancel) { model.actionError = nil }
    } message: {
      Text(model.actionError ?? "")
    }
  }

  private func subsetLine(_ subset: Subset, model: SessionListModel) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("\(subset.shown) of \(subset.total)")
        .monospacedDigit()
      Text("· " + subset.causes.joined(separator: " · "))
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 0)
      Button("Show all") { model.clearFilters() }
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
    let sections = model.sections(now: clockMs)
    List {
      if sections.isEmpty, model.hasLoaded {
        emptyState(model)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
      ForEach(sections) { section in
        Section {
          if !section.group.collapsed {
            ForEach(section.items) { item in
              if item.row.depth > 0 {
                memberUnit(item, model: model)
              } else {
                unit(item, section: section, model: model)
              }
            }
          }
        } header: {
          if section.earlier {
            earlierHeader(section, model: model)
          } else if let label = section.group.label {
            Text(label)
          }
        }
      }
    }
    .listStyle(.plain)
    .task(id: model.lingerEnds) {
      guard let end = model.lingerEnds else { return }
      try? await Task.sleep(for: .milliseconds(max(0, end - Date().timeIntervalSince1970 * 1000) + 50))
      clock = Date()
    }
    .environment(\.defaultMinListRowHeight, SessionStepRow.height)
    .modifier(SessionSearch(open: $searchOpen, text: $model.search))
    .refreshable { await model.refresh() }
  }

  @ViewBuilder
  private func unit(_ item: ListItem, section: ListSection, model: SessionListModel) -> some View {
    if let route = sessionRoute(for: item) {
      let steps = item.row.steps
      if item.info.agent != nil {
        AgentCardView(
          item: item, frames: model.agentAvatars.frames(hostId: item.row.hostId, agent: item.info.agent),
          tray: item.row.tray.isEmpty && !item.row.teamExpanded
            ? nil
            : TeamTray(
              row: item.row,
              members: item.row.tray.compactMap { member in
                model.info(hostId: member.hostId, sessionId: member.sessionId).map { (member, $0) }
              },
              frames: { model.agentAvatars.frames(hostId: $0.hostId, agent: $1.agent) },
              select: { member in open(member, model: model) },
              toggle: { model.toggleTeam(item) }),
          onOpen: { path.append(route) },
          menu: { rowActions(for: item, model: model) })
        .opacity(item.row.context ? 0.5 : 1)
        .modifier(rowChrome(item, model: model))
        .contextMenu { rowActions(for: item, model: model) }
        .listRowInsets(AgentCardView<EmptyView>.insets(member: false, hasSteps: !steps.isEmpty))
        .listRowBackground(item.needsYou ? ListAttention.background : nil)
        stepRows(for: item, model: model)
      } else {
        SessionCardView(
          item: item,
          onOpen: { path.append(route) },
          // Grouped by project, the section header already names the gateway.
          hostName: showsHostNames(model) && model.filter.groupBy != .project
            ? item.row.hostName : nil,
          projectImage: projectImage(for: item, model: model),
          // Grouped by project, the section header already names it.
          showsProject: model.filter.groupBy != .project,
          menu: { rowActions(for: item, model: model) })
        .modifier(rowChrome(item, model: model))
        .contextMenu { rowActions(for: item, model: model) }
        .listRowInsets(SessionCardView<EmptyView>.insets(hasSteps: !steps.isEmpty))
        .listRowSeparator(steps.isEmpty ? .automatic : .hidden, edges: .bottom)
        .listRowBackground(item.needsYou ? ListAttention.background : nil)
        stepRows(for: item, model: model)
      }
    }
  }

  @ViewBuilder
  private func memberUnit(_ item: ListItem, model: SessionListModel) -> some View {
    if let route = sessionRoute(for: item) {
      AgentCardView(
        item: item, frames: model.agentAvatars.frames(hostId: item.row.hostId, agent: item.info.agent),
        member: true,
        onOpen: {
          model.select(hostId: item.row.hostId, sessionId: item.row.sessionId)
          path.append(route)
        },
        menu: { rowActions(for: item, model: model) })
      .modifier(rowChrome(item, model: model))
      .contextMenu { rowActions(for: item, model: model) }
      .listRowInsets(AgentCardView<EmptyView>.insets(member: true, hasSteps: false))
      .listRowSeparator(.hidden)
      .listRowBackground(
        ZStack {
          if item.needsYou { ListAttention.background }
          TeamTreeLine()
        })
    }
  }

  private var clockMs: Double { clock.timeIntervalSince1970 * 1000 }

  // A tray avatar opens its Member, which then counts as selected and so stays drawn under the lead.
  private func open(_ member: TrayMember, model: SessionListModel) {
    guard let hostId = UUID(uuidString: member.hostId) else { return }
    model.select(hostId: member.hostId, sessionId: member.sessionId)
    path.append(.session(hostId: hostId, sessionId: member.sessionId))
  }

  private func earlierHeader(_ section: ListSection, model: SessionListModel) -> some View {
    Button {
      model.toggleEarlier()
    } label: {
      HStack(spacing: 4) {
        Image(systemName: section.group.collapsed ? "chevron.right" : "chevron.down")
          .font(.caption2.weight(.semibold))
        Text(section.group.label ?? "Earlier")
        Text("\(section.group.sessions)").monospacedDigit().foregroundStyle(.tertiary)
        Spacer(minLength: 0)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private func rowChrome(_ row: ListItem, model: SessionListModel) -> RowChrome {
    RowChrome(
      row: row,
      onClose: {
        if row.info.status == .closed {
          Task { await model.close(row) }
        } else {
          pendingClose = row
        }
      },
      onRename: { beginRename(row) },
      onRestart: row.info.agent == nil ? nil : { Task { _ = await model.restart(row) } })
  }

  private func beginRename(_ row: ListItem) {
    renameText = row.info.agent?.name ?? row.info.title ?? ""
    pendingRename = row
  }

  // Every non-navigating thing a row can do, in one builder, because the row
  // offers three ways in and they must not drift apart: the card's persistent
  // `···`, a long press, and (for the destructive half) a trailing swipe. Close
  // and Remove are the same gesture wearing two meanings - see the swipe.
  @ViewBuilder
  private func rowActions(for row: ListItem, model: SessionListModel) -> some View {
    let agent = row.info.agent
    if let owner = row.info.owner {
      Text("Owner: \(owner)")
    }
    Button {
      beginRename(row)
    } label: {
      Label(agent != nil ? "Rename agent" : "Rename session", systemImage: "pencil")
    }
    Button {
      statusText = row.info.statusLabel?.text ?? ""
      pendingStatus = row
    } label: {
      Label(row.info.statusLabel != nil ? "Change status" : "Set status", systemImage: "text.bubble")
    }
    if agent?.avatar != nil {
      Button {
        Task { await model.changeAvatar(row) }
      } label: {
        Label("Change avatar", systemImage: "face.smiling")
      }
    }
    Divider()
    if agent == nil {
      Button {
        Task { await model.makeAgent(row) }
      } label: {
        Label("Make agent", systemImage: "person.badge.plus")
      }
    }
    let leads = model.teamLeads(for: row)
    if !leads.isEmpty {
      Menu {
        ForEach(leads, id: \.agentId) { lead in
          Button(lead.name) {
            if let owner = model.crossedOwner(row, into: lead) {
              pendingCrossing = Crossing(row: row, lead: lead, owner: owner)
            } else {
              Task { await model.join(row, lead: lead) }
            }
          }
        }
      } label: {
        Label("Add to team", systemImage: "person.2")
      }
    }
    if let agent, agent.lead != nil {
      Button {
        Task { await model.leave(row) }
      } label: {
        Label("Leave \(agent.team ?? "team")", systemImage: "rectangle.portrait.and.arrow.right")
      }
    }
    if agent?.isLead == true {
      Button {
        Task { await model.dissolve(row) }
      } label: {
        Label("Dissolve team", systemImage: "person.2.slash")
      }
    }
    if let agent, agent.lead == nil, let hostId = row.hostUUID {
      if agent.shared == true {
        Button {
          Task { await model.setSharing(row, .private) }
        } label: {
          Label("Make private", systemImage: "lock")
        }
      } else if model.agentSeed(for: hostId)?.allowShared == true {
        Button {
          Task { await model.setSharing(row, .shared) }
        } label: {
          Label("Share with other owners", systemImage: "globe")
        }
      }
    }
    if agent != nil {
      Button {
        Task { _ = await model.restart(row) }
      } label: {
        Label("New conversation", systemImage: "arrow.counterclockwise")
      }
    }
    if row.row.canSleep {
      Button {
        Task { await model.sleep(row) }
      } label: {
        Label("Sleep", systemImage: "moon.zzz")
      }
    }
    Divider()
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
    if agent != nil {
      Button(role: .destructive) { pendingRetire = row } label: {
        Label("Retire agent…", systemImage: "person.badge.minus")
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
  private func projectImage(for row: ListItem, model: SessionListModel) -> UIImage? {
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
      // Rows exist; the filters hide them all. A different sentence - and a
      // different way out - from "there are none".
      ContentUnavailableView {
        Label("No matches", systemImage: "line.3.horizontal.decrease.circle")
      } description: {
        Text("No session matches the current search and filters.")
      } actions: {
        Button("Clear filters") { model.clearFilters() }
      }
    } else {
      ContentUnavailableView {
        Label("No sessions", systemImage: "bubble.left.and.text.bubble.right")
      } description: {
        Text("Start one with the + button, or pick up an earlier one from Resume.")
      }
    }
  }

  private func sessionRoute(for row: ListItem) -> SessionRoute? {
    row.hostUUID.map { .session(hostId: $0, sessionId: row.info.id) }
  }

  // MARK: - Step lines

  // One list row per step, in the core's order (agents, tasks, shells). Rows rather than a stack inside the card,
  // because a full-width row is a real thumb target; the press follows the kind (`SessionRoute.step`).
  private func stepRows(for row: ListItem, model: SessionListModel) -> some View {
    SessionStepRows(row: row, steps: row.row.steps) {
      kill($0, row: row, model: model)
    }
  }

  private func kill(_ step: ListStep, row: ListItem, model: SessionListModel) -> (() -> Void)? {
    guard step.killable else { return nil }
    switch step.kind {
    case .shell:
      return { Task { await model.killShell(row, shellId: step.key) } }
    case .task:
      guard let toolUseId = step.toolUseId else { return nil }
      return { Task { await model.stopTask(row, toolUseId: toolUseId) } }
    case .agent:
      return nil
    }
  }

  // MARK: - Resume list

  @ViewBuilder
  private func resumeList(_ model: SessionListModel) -> some View {
    // A gateway that failed has settled too - it just settled badly. Waiting for
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
  /// filter dropdown closed itself whenever anything in the list changed - an
  /// unread badge ticking up was enough - so on a busy gateway it could not be
  /// used at all.
  ///
  /// The mechanism has two parts. The menu read `model.adapters`, which is
  /// *computed from the session rows*, so `@Observable` registered a dependency
  /// on every snapshot the 1.2s poll replaces: the menu's body was invalidated
  /// on each refresh whether or not the engine list had changed. And a
  /// `ToolbarItem` with no `id` is re-identified when the toolbar builder re-runs
  /// - which tears down the presented menu rather than updating it.
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
    ToolbarItem(id: "search", placement: .topBarTrailing) {
      Button {
        searchOpen.toggle()
      } label: {
        Label("Search", systemImage: "magnifyingglass")
      }
    }
    ToolbarItem(id: "filter", placement: .topBarTrailing) {
      Group {
        if let model {
          FilterMenu(
            filter: model.filter,
            hosts: hosts.hosts.map { FilterMenu.Gateway(id: $0.id, name: $0.displayName) },
            adapters: model.adapters,
            projects: model.projects,
            list: model.list,
            changed: { model.syncConfig() })
        }
      }
    }
    ToolbarItem(id: "add", placement: .topBarTrailing) {
      addButton
    }
  }

  /// New session - on which gateway is part of the question now, so with more
  /// than one host the + is a menu naming them.
  @ViewBuilder
  private var addButton: some View {
    Menu {
      ForEach(hosts.hosts) { host in
        Section(hosts.hosts.count > 1 ? host.displayName : "") {
          Button {
            path.append(.create(hostId: host.id, seed: seed(for: host)))
          } label: {
            Label("New session", systemImage: "bubble.left")
          }
          if model?.agentSeed(for: host.id) != nil {
            Button {
              var agentSeed = seed(for: host)
              agentSeed.agent = true
              path.append(.create(hostId: host.id, seed: agentSeed))
            } label: {
              Label("New agent", systemImage: "person.crop.square")
            }
          }
        }
      }
    } label: {
      Label("New", systemImage: "plus")
    } primaryAction: {
      if hosts.hosts.count == 1, let host = hosts.hosts.first {
        path.append(.create(hostId: host.id, seed: seed(for: host)))
      }
    }
  }

  private func seed(for host: Host) -> CreateSessionSeed {
    CreateSessionSeed(cwd: model?.context(for: host.id)?.recentCwds.first ?? "")
  }
}

/// The list's search bar, drawn only while it is open. `.searchable` has no
/// hidden state of its own, so the bar comes and goes with the modifier. Its
/// Cancel closes it, and closing clears the query.
private struct SessionSearch: ViewModifier {
  @Binding var open: Bool
  @Binding var text: String
  @State private var active = false

  func body(content: Content) -> some View {
    Group {
      if open {
        content
          .searchable(
            text: $text, isPresented: $active,
            placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions")
          // Opened by the button (the query is always empty then): focus it.
          // Reopened for a persisted query: show it, leave the keyboard down.
          .onAppear { if text.isEmpty { active = true } }
          .onChange(of: active) { _, now in
            if !now { open = false }
          }
      } else {
        content
      }
    }
    .onChange(of: open) { _, now in
      if !now { text = "" }
    }
    // A query persisted from an earlier launch must stay visible.
    .onAppear { if !text.isEmpty { open = true } }
  }
}

private struct RowChrome: ViewModifier {
  let row: ListItem
  let onClose: () -> Void
  let onRename: () -> Void
  let onRestart: (() -> Void)?

  func body(content: Content) -> some View {
    content
      .swipeActions(edge: .trailing) {
        Button(role: .destructive, action: onClose) {
          if row.info.status == .closed {
            Label("Remove", systemImage: "trash")
          } else {
            Label("Close", systemImage: "xmark.circle")
          }
        }
      }
      .swipeActions(edge: .leading) {
        Button(action: onRename) {
          Label("Rename", systemImage: "pencil")
        }
        .tint(.accentColor)
        if let onRestart {
          Button(action: onRestart) {
            Label("New conversation", systemImage: "arrow.counterclockwise")
          }
          .tint(.indigo)
        }
      }
  }
}
