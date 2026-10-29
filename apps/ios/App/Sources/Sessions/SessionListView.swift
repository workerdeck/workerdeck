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
  @State private var routeAttempt = 0
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
  @State private var pendingDelete: ListItem?
  @State private var history: ConversationsTarget?
  @State private var pendingDiscard: PendingDiscard?
  @State private var pendingCrossing: Crossing?
  @State private var dragging: ListDragSession?
  @State private var frames = ListFrames()
  @State private var lifter = ListLifter()
  // The heading order drawn while a heading is lifted; the core's own order again once it drops.
  @State private var liveOrder: [String]?
  // A SwiftUI Button under the finger still fires on release after the lift cancelled its touch.
  @State private var droppedAt = Date.distantPast
  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

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
      chrome(
        Group {
          if let model {
            content(model)
          } else {
            ProgressView()
          }
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
      )
      .navigationDestination(for: SessionRoute.self) { route in
        destination(route)
      }
    }
    // One task owns both the model's existence and the poll. The poll runs only
    // while the list itself is what's on screen (stack empty, app active): an
    // open session has its own socket, and a backgrounded app has no reader.
    .task(id: pollKey) {
      let live = model ?? SessionListModel(hosts: hosts, unread: unread, defaults: defaults)
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
      // A notification route whose conversations read never answered is tried again.
      if push.pendingRoute != nil { routeAttempt &+= 1 }
      // The token can change while the app is away, and a gateway restart forgets
      // nothing - but a *first* launch after adding a host might have failed.
      Task { await push.syncRegistrations() }
    }
    // Both an appear and a change: a cold launch from a notification sets the
    // route before this view exists.
    .task(id: PushAttempt(route: push.pendingRoute, attempt: routeAttempt)) { await consumePushRoute() }
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
  private func consumePushRoute() async {
    guard let route = push.pendingRoute else { return }
    let target =
      route.hostId
      ?? hosts.hosts.first { model?.row(hostId: $0.id.uuidString, sessionId: route.sessionId) != nil }?.id
      ?? hosts.hosts.first?.id
    guard let hostId = target, hosts.hosts.contains(where: { $0.id == hostId }) else {
      // A route naming a gateway this phone no longer has can never be served.
      push.clearRoute()
      return
    }
    var conversation: Int64?
    if let n = route.conversation {
      // The list may not be loaded yet (a cold launch) or may predate another client's cut, so the notification's n
      // is weighed against a fresh read of the session's conversations. The route stays pending until that answers;
      // with no answer after a few tries it stays pending for the next foreground rather than open the wrong one.
      let current = await currentConversation(hostId: hostId, sessionId: route.sessionId)
      guard !Task.isCancelled, push.pendingRoute == route, let current else { return }
      conversation = addressOf(id: route.sessionId, conversation: n, current: current.n).conversation
    }
    // Replaces rather than appends, so Back from a pushed-to session lands on
    // the list however deep the stack happened to be.
    path = [
      .session(
        hostId: hostId, sessionId: route.sessionId, seq: route.seq, epoch: route.epoch, conversation: conversation,
        requested: conversation == nil ? route.conversation : nil)
    ]
    push.clearRoute()
  }

  private struct Current { let n: Int64? }

  private struct PushAttempt: Equatable {
    let route: PushRoute?
    let attempt: Int
  }

  // The session's current n from its own conversations list (nil n: closed, or out of scope), or nil when no answer
  // came after a few tries. Waits for the list model on a cold launch.
  private func currentConversation(hostId: UUID, sessionId: String) async -> Current? {
    for attempt in 0..<5 {
      if attempt > 0 { try? await Task.sleep(for: .seconds(2)) }
      guard !Task.isCancelled else { return nil }
      guard let client = model?.context(for: hostId)?.client else { continue }
      let answer = await client.answer(conversationsCall(id: sessionId))
      guard answer.status == 200 else { continue }
      let now = Date()
      let items = sessionConversations(
        body: answer.body, currentTitle: nil, nowMs: now.timeIntervalSince1970 * 1000,
        offsetMinutes: SessionListModel.offset(now))
      return Current(n: items?.first(where: \.current)?.n)
    }
    return nil
  }

  // MARK: - Destinations

  @ViewBuilder
  private func destination(_ route: SessionRoute) -> some View {
    switch route {
    case .session(
      let hostId, let sessionId, let seq, let epoch, let subagent, let reveal, let shell, let conversation, let requested):
      if let model, let context = model.context(for: hostId) {
        CoreSessionRoute(
          sessionId: sessionId, hostId: hostId, client: context.client,
          entry: SessionRoute.entry(seq: seq, epoch: epoch, subagent: subagent, reveal: reveal, shell: shell),
          conversation: conversation, requested: requested)
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
        onAgentCreated: { created in
          if let cwd = created.cwd { context.rememberCwd(cwd) }
          path = created.sessionId.map { [.session(hostId: hostId, sessionId: $0)] } ?? []
        }
      ) { created in
        if let cwd = created.cwd { context.rememberCwd(cwd) }
        // Replace the create step so Back from the session lands on the list.
        path = created.sessionId.map { [.session(hostId: hostId, sessionId: $0)] } ?? []
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
      pendingRename?.row.agent != nil ? "Rename agent" : "Rename session",
      isPresented: Binding(
        get: { pendingRename != nil }, set: { if !$0 { pendingRename = nil } })
    ) {
      TextField("Name", text: $renameText)
      Button("Save") {
        if let row = pendingRename {
          if row.row.agent != nil {
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
        pendingRename?.row.agent != nil
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
      deleteAgentTitle(name: pendingDelete?.row.agent ?? "this agent"),
      isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
      titleVisibility: .visible
    ) {
      Button("Delete agent", role: .destructive) {
        if let row = pendingDelete {
          Task { await model.deleteAgent(row) }
        }
        pendingDelete = nil
      }
      Button("Cancel", role: .cancel) { pendingDelete = nil }
    } message: {
      Text(deleteAgentMessage(name: pendingDelete?.row.agent ?? "This agent"))
    }
    .confirmationDialog(
      pendingDiscard?.confirmation.title ?? "",
      isPresented: Binding(get: { pendingDiscard != nil }, set: { if !$0 { pendingDiscard = nil } }),
      titleVisibility: .visible, presenting: pendingDiscard
    ) { pending in
      Button(pending.confirmation.confirm, role: .destructive) {
        Task { await model.discardAndCut(pending.row, pending.confirmation) }
        pendingDiscard = nil
      }
      Button("Cancel", role: .cancel) { pendingDiscard = nil }
    } message: { pending in
      Text(pending.confirmation.detail)
    }
    .sheet(item: $history) { target in
      ConversationsSheet(target: target, model: model) { route in
        history = nil
        path.append(route)
      }
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
    let sections = ordered(model.sections(now: clockMs))
    let drop = dragging.flatMap { cardDrop($0, sections: sections, model: model) }
    List {
      if sections.isEmpty, model.hasLoaded {
        emptyState(model)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
      ForEach(sections) { section in
        Section {
          if !section.group.collapsed, liveOrder == nil {
            ForEach(section.items) { item in
              card(item, model: model, sections: sections, drop: drop)
            }
          }
        } header: {
          if section.earlier {
            earlierHeader(section, model: model)
          } else if section.group.label != nil {
            groupHeader(section.group, model: model, sections: sections)
          }
        }
        .listSectionSeparator(.hidden)
      }
    }
    .listStyle(.plain)
    .listFrame { frames.list = $0 }
    .scrollDisabled(dragging != nil)
    .overlay(alignment: .topLeading) { lifted(model, sections: sections, drop: drop) }
    .sensoryFeedback(.impact(weight: .medium), trigger: dragging?.subject) { _, now in now != nil }
    .sensoryFeedback(.selection, trigger: liveOrder) { old, now in old != nil && now != nil }
    .sensoryFeedback(.selection, trigger: drop)
    .task(id: model.lingerEnds) {
      guard let end = model.lingerEnds else { return }
      try? await Task.sleep(for: .milliseconds(max(0, end - Date().timeIntervalSince1970 * 1000) + 50))
      clock = Date()
    }
    .environment(\.defaultMinListRowHeight, 0)
    .modifier(SessionSearch(open: $searchOpen, text: $model.search))
    .refreshable { await model.refresh() }
  }

  @ViewBuilder
  private func card(_ item: ListItem, model: SessionListModel, sections: [ListSection], drop: CardDrop?) -> some View {
    if sessionRoute(for: item) != nil {
      let row = item.row
      sessionCard(item, model: model)
        .opacity(dragging?.subject == .card(item.id) ? 0 : row.context ? 0.5 : 1)
        .overlay {
          if drop == .join(item.id) {
            RoundedRectangle(cornerRadius: 8)
              .fill(Color.accentColor.opacity(0.1))
              .strokeBorder(Color.accentColor, lineWidth: 1)
              .accessibilityHidden(true)
          }
        }
        .listFrame { frames.cards[item.id] = $0 }
        .modifier(rowChrome(item, model: model))
        .contextMenu { rowActions(for: item, model: model) }
        .background(ListLiftHook(lifter: lifter, handlers: liftHandlers(model, sections: sections)))
        .listRowInsets(CardBackground.insets(item))
        .listRowSeparator(.hidden)
        .listRowBackground(CardBackground(item: item))
    }
  }

  @ViewBuilder
  private func sessionCard(_ item: ListItem, model: SessionListModel) -> some View {
    if let route = sessionRoute(for: item) {
      let row = item.row
      SessionCard(
        item: item,
        tray: row.depth == 0 && (!row.tray.isEmpty || row.teamExpanded)
          ? TeamTray(
            row: row,
            select: { member in open(member, model: model) },
            toggle: { model.toggleTeam(item) })
          : nil,
        hostName: showsHostNames(model) && model.filter.groupBy != .project ? row.hostName : nil,
        showsProject: model.filter.groupBy != .project,
        projectImage: projectImage(for: item, model: model),
        actions: CardActions(
          open: {
            guard settled else { return }
            if row.depth > 0 { model.select(hostId: row.hostId, sessionId: row.sessionId) }
            path.append(route)
          },
          toggleChip: { model.toggleSteps(item, $0) },
          openStep: { step in
            if let hostId = item.hostUUID {
              path.append(.step(hostId: hostId, sessionId: item.sessionId, step: step))
            }
          },
          killStep: { kill($0, row: item, model: model) }))
    }
  }

  private var settled: Bool { dragging == nil && Date().timeIntervalSince(droppedAt) > 0.4 }

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
          .font(.system(size: 10, weight: .semibold))
        Text("Earlier · \(section.group.sessions) one-off session\(section.group.sessions == 1 ? "" : "s")")
        Spacer(minLength: 0)
      }
      .font(ListType.label())
      .foregroundStyle(ListPalette.fg4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .textCase(nil)
  }

  // `FacetGroupHeader`: fold chevron, project icon, label (capitals for a facet), gateway badge, count, the folded
  // summary, and on a project group a `+` that starts a session there. Drag it onto another heading to reorder.
  private func groupHeader(_ group: ListGroup, model: SessionListModel, sections: [ListSection]) -> some View {
    groupHeading(group, model: model)
      .opacity(dragging?.subject == .group(group.key) ? 0 : 1)
      .listFrame { frames.groups[group.key] = $0 }
      .background(ListLiftHook(lifter: lifter, handlers: liftHandlers(model, sections: sections)))
  }

  private func groupHeading(_ group: ListGroup, model: SessionListModel) -> some View {
    let label = group.label ?? ""
    return HStack(spacing: 8) {
      Button {
        if settled { model.toggleGroup(group.key) }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: group.collapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .frame(width: 12)
          if let glyph = group.projectGlyph {
            Image(systemName: projectSymbol(forLucideName: glyph)).font(.system(size: 11))
          } else if let hash = group.projectIconHash, let image = model.projectIcons.image(forHash: hash) {
            Image(uiImage: image)
          }
          Text(group.caps ? label.uppercased() : label)
            .tracking(group.caps ? 0.3 : 0)
            .foregroundStyle(group.caps ? ListPalette.fg4 : ListPalette.fg3)
            .lineLimit(1)
          if let gateway = group.gateway {
            Text(gateway)
              .font(ListType.label())
              .foregroundStyle(ListPalette.fg4)
              .padding(.horizontal, 4)
              .frame(height: 16)
              .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(ListPalette.border))
          }
          Text("\(group.rows.count)").foregroundStyle(ListPalette.fg4.opacity(0.7)).monospacedDigit()
          if let summary = group.foldSummary {
            Text(summary)
              .foregroundStyle(group.foldAttention ? ListPalette.warning : ListPalette.fg4.opacity(0.7))
              .lineLimit(1)
          }
          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(group.collapsed ? "Expand" : "Collapse") \(label)")
      if let hostId = group.hostId.flatMap(UUID.init(uuidString:)), model.filter.groupBy == .project {
        Button {
          if settled { path.append(.create(hostId: hostId, seed: CreateSessionSeed(cwd: group.cwd ?? ""))) }
        } label: {
          Image(systemName: "plus").font(.system(size: 12, weight: .semibold)).padding(.vertical, 4).contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .tint(ListPalette.fg3)
        .accessibilityLabel("New session in \(label)")
      }
    }
    .font(ListType.label(.medium))
    .foregroundStyle(ListPalette.fg4)
    .textCase(nil)
  }

  // MARK: - Drag and drop

  // A card held over an agent it could join, or a Member moved anywhere outside its own team.
  private enum CardDrop: Equatable {
    case join(String)
    case leave
  }

  private func ordered(_ sections: [ListSection]) -> [ListSection] {
    guard let liveOrder else { return sections }
    var queue = liveOrder.compactMap { key in sections.first { $0.id == key } }
    return sections.map { liveOrder.contains($0.id) && !queue.isEmpty ? queue.removeFirst() : $0 }
  }

  private func liftHandlers(_ model: SessionListModel, sections: [ListSection]) -> ListLifter.Handlers {
    ListLifter.Handlers(
      canLift: { liftable(at: $0, model: model, sections: sections) != nil },
      lift: { point in
        guard dragging == nil, let subject = liftable(at: point, model: model, sections: sections) else { return }
        lift(subject, at: point, sections: sections)
      },
      move: { moveDrag(to: $0) },
      end: { endDrag(commit: $0, sections: sections, model: model) })
  }

  // What a hold at this point would lift: a reorderable heading, a card that could join a team, or a Member.
  private func liftable(at point: CGPoint, model: SessionListModel, sections: [ListSection]) -> ListDragSubject? {
    let reorderable = sections.filter(\.group.reorderable)
    if reorderable.count > 1,
      let group = reorderable.first(where: { frames.groups[$0.id]?.contains(point) ?? false })
    {
      return .group(group.id)
    }
    let drawn = sections.filter { !$0.group.collapsed }.flatMap(\.items)
    guard let item = drawn.first(where: { frames.cards[$0.id]?.contains(point) ?? false }),
      item.row.member || !model.teamLeads(for: item).isEmpty
    else { return nil }
    return .card(item.id)
  }

  private func lift(_ subject: ListDragSubject, at point: CGPoint, sections: [ListSection]) {
    switch subject {
    case .card(let id):
      guard let frame = frames.cards[id] else { return }
      dragging = ListDragSession(subject: subject, frame: frame, startY: point.y, y: point.y)
    case .group(let key):
      guard let frame = frames.groups[key] else { return }
      dragging = ListDragSession(subject: subject, frame: frame, startY: point.y, y: point.y)
      liveOrder = sections.filter(\.group.reorderable).map(\.id)
    }
  }

  // A lifted heading takes the slot below every other heading whose middle it has passed.
  private func moveDrag(to point: CGPoint) {
    guard var session = dragging else { return }
    session.y = point.y
    dragging = session
    guard case .group(let key) = session.subject, let order = liveOrder else { return }
    var next = order.filter { $0 != key }
    let passed = next.filter { (frames.groups[$0]?.midY ?? .infinity) < session.lifted.midY }.count
    next.insert(key, at: passed)
    if next != order {
      withAnimation(.snappy(duration: 0.2)) { liveOrder = next }
    }
  }

  private func endDrag(commit: Bool, sections: [ListSection], model: SessionListModel) {
    guard let session = dragging else { return }
    droppedAt = Date()
    let order = liveOrder
    let drop = cardDrop(session, sections: sections, model: model)
    withAnimation(.snappy(duration: 0.2)) {
      dragging = nil
      liveOrder = nil
    }
    guard commit else { return }
    switch session.subject {
    case .group(let key):
      let drawn = model.sections(now: clockMs).filter(\.group.reorderable).map(\.id)
      guard let at = order?.firstIndex(of: key), drawn.indices.contains(at), drawn[at] != key else { return }
      model.moveGroup(key, onto: drawn[at])
    case .card(let id):
      guard let source = sections.flatMap(\.items).first(where: { $0.id == id }), let drop else { return }
      switch drop {
      case .join(let target):
        join(source, onto: sections.flatMap(\.items).first { $0.id == target }, model: model)
      case .leave:
        Task { await model.leave(source) }
      }
    }
  }

  private func cardDrop(_ session: ListDragSession, sections: [ListSection], model: SessionListModel) -> CardDrop? {
    guard case .card(let id) = session.subject else { return nil }
    let drawn = sections.filter { !$0.group.collapsed }.flatMap(\.items)
    guard let source = drawn.first(where: { $0.id == id }) else { return nil }
    let under = { (item: ListItem) in frames.cards[item.id].map { ($0.minY...$0.maxY).contains(session.y) } ?? false }
    if under(source) { return nil }
    let target = drawn.first { $0.id != id && under($0) }
    if let target, model.teamLeads(for: source).contains(where: { $0.sessionId == target.sessionId }) {
      return .join(target.id)
    }
    guard source.row.member else { return nil }
    if let target, target.row.team == source.row.team || (target.row.lead && target.row.agent == source.row.team) {
      return nil
    }
    return .leave
  }

  private func join(_ source: ListItem, onto target: ListItem?, model: SessionListModel) {
    guard let target, let lead = model.teamLeads(for: source).first(where: { $0.sessionId == target.sessionId })
    else { return }
    if let owner = model.crossedOwner(source, into: lead) {
      pendingCrossing = Crossing(row: source, lead: lead, owner: owner)
    } else {
      Task { await model.join(source, lead: lead) }
    }
  }

  // The lifted card or heading itself, drawn over the list where the finger holds it; its own row stays as a gap.
  @ViewBuilder
  private func lifted(_ model: SessionListModel, sections: [ListSection], drop: CardDrop?) -> some View {
    if let session = dragging {
      let box = session.lifted
      Group {
        switch session.subject {
        case .card(let id):
          if let item = sections.flatMap(\.items).first(where: { $0.id == id }) {
            sessionCard(item, model: model)
              .background(RoundedRectangle(cornerRadius: 8).fill(ListPalette.nest))
              .overlay {
                if case .join = drop {
                  RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 1.5)
                }
              }
              .overlay(alignment: .bottomTrailing) {
                if drop == .leave {
                  Text("Leave \(item.row.team ?? "team")")
                    .font(ListType.label(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .frame(height: 18)
                    .background(Capsule().fill(Color.accentColor))
                    .offset(x: -14, y: 9)
                }
              }
          }
        case .group(let key):
          if let group = sections.first(where: { $0.id == key })?.group {
            groupHeading(group, model: model)
              .background(RoundedRectangle(cornerRadius: 6).fill(Color(.systemBackground)).padding(-4))
          }
        }
      }
      .frame(width: box.width, height: box.height)
      .scaleEffect(1.02)
      .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
      .offset(x: box.minX - frames.list.minX, y: box.minY - frames.list.minY)
      .allowsHitTesting(false)
      .accessibilityElement(children: .ignore)
      .accessibilityIdentifier("Lifted")
    }
  }

  private func rowChrome(_ row: ListItem, model: SessionListModel) -> RowChrome {
    RowChrome(
      row: row,
      onClose: {
        if row.row.agentId != nil {
          pendingDelete = row
        } else if row.closed {
          Task { await model.close(row) }
        } else {
          pendingClose = row
        }
      },
      onRename: { beginRename(row) },
      onRestart: !row.row.canNewConversation || row.row.newConversationBlocked != nil
        ? nil : { newConversation(row, model: model) })
  }

  private func newConversation(_ row: ListItem, model: SessionListModel) {
    Task {
      if let confirmation = await model.newConversation(row) {
        pendingDiscard = PendingDiscard(row: row, confirmation: confirmation)
      }
    }
  }

  private func beginRename(_ row: ListItem) {
    renameText = row.row.title
    pendingRename = row
  }

  // Every non-navigating thing a row can do, in one builder, because the row
  // offers three ways in and they must not drift apart: the card's persistent
  // `···`, a long press, and (for the destructive half) a trailing swipe. Close
  // and Remove are the same gesture wearing two meanings - see the swipe.
  @ViewBuilder
  private func rowActions(for row: ListItem, model: SessionListModel) -> some View {
    let agent = row.row.agent
    if let owner = row.row.owner {
      Text("Owner: \(owner)")
    }
    Button {
      beginRename(row)
    } label: {
      Label(agent != nil ? "Rename agent" : "Rename session", systemImage: "pencil")
    }
    Button {
      statusText = row.row.statusText ?? ""
      pendingStatus = row
    } label: {
      Label(row.row.statusText != nil ? "Change status" : "Set status", systemImage: "text.bubble")
    }
    if row.row.agentId != nil {
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
    if row.row.member {
      Button {
        Task { await model.leave(row) }
      } label: {
        Label("Leave \(row.row.team ?? "team")", systemImage: "rectangle.portrait.and.arrow.right")
      }
    }
    if row.row.lead {
      Button {
        Task { await model.dissolve(row) }
      } label: {
        Label("Dissolve team", systemImage: "person.2.slash")
      }
    }
    if agent != nil, !row.row.member, let hostId = row.hostUUID {
      if row.row.shared {
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
    if row.row.canNewConversation {
      Button {
        newConversation(row, model: model)
      } label: {
        Label("New conversation", systemImage: "arrow.counterclockwise")
        Text(row.row.newConversationBlocked ?? newConversationHint())
      }
      .disabled(row.row.newConversationBlocked != nil)
    }
    if let target = ConversationsTarget(row) {
      Button {
        history = target
      } label: {
        Label("Conversations", systemImage: "clock.arrow.circlepath")
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
    if agent != nil {
      Button(role: .destructive) { pendingDelete = row } label: {
        Label("Delete agent…", systemImage: "trash")
      }
    } else if row.closed {
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
  private func projectImage(for row: ListItem, model: SessionListModel) -> UIImage? {
    guard let hash = row.row.projectIconHash else { return nil }
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
    row.hostUUID.map { .session(hostId: $0, sessionId: row.sessionId) }
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
            ForEach(summaries, id: \.sessionId) { summary in
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
  // iOS 26 floats search and + at the bottom, like Contacts; earlier systems keep all five in the top bar.
  @ViewBuilder
  private func chrome(_ content: some View) -> some View {
    if #available(iOS 26, *) {
      content.toolbar { glassToolbar }
    } else {
      content.toolbar { toolbar }
    }
  }

  @available(iOS 26, *)
  @ToolbarContentBuilder
  private var glassToolbar: some ToolbarContent {
    leadingItems
    filterItem
    DefaultToolbarItem(kind: .search, placement: .bottomBar)
    ToolbarSpacer(.fixed, placement: .bottomBar)
    ToolbarItem(id: "add", placement: .bottomBar) {
      addButton
    }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    leadingItems
    ToolbarItem(id: "search", placement: .topBarTrailing) {
      Button {
        searchOpen.toggle()
      } label: {
        Label("Search", systemImage: "magnifyingglass")
      }
    }
    filterItem
    ToolbarItem(id: "add", placement: .topBarTrailing) {
      addButton
    }
  }

  @ToolbarContentBuilder
  private var leadingItems: some ToolbarContent {
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

  @ToolbarContentBuilder
  private var filterItem: some ToolbarContent {
    ToolbarItem(id: "filter", placement: .topBarTrailing) {
      Group {
        if let model {
          FilterMenu(
            filter: model.filter,
            hosts: hosts.hosts.map { FilterMenu.Gateway(id: $0.id, name: $0.displayName) },
            adapters: model.adapters,
            projects: model.projects,
            pastAgents: model.pastAgents,
            orderCustomized: model.groupOrderCustomized,
            list: model.list,
            changed: { model.syncConfig() },
            openPast: { history = ConversationsTarget(past: $0) })
        }
      }
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

  @ViewBuilder
  func body(content: Content) -> some View {
    if #available(iOS 26, *) {
      content.searchable(text: $text, prompt: "Search sessions")
    } else {
      drawer(content)
    }
  }

  private func drawer(_ content: Content) -> some View {
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
          if row.row.agentId != nil {
            Label("Delete agent", systemImage: "trash")
          } else if row.closed {
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

// A card's New conversation the gateway refused over unconfirmed input: the row it was for and what discarding binds.
struct PendingDiscard: Identifiable {
  let row: ListItem
  let confirmation: DiscardConfirmation
  var id: String { "\(row.sessionId)#\(confirmation.conversation)" }
}
