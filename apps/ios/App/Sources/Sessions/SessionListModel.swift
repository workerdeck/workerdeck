import Foundation
import Observation
import UserNotifications
import WorkerDeckCore
import WorkerDeckKit

/// Every configured gateway's sessions in one model - the phone's counterpart of
/// the VS Code extension's `SessionsModel`. The gateway is a *facet* of the one
/// list (filter/group/sort), never the frame: rows come from all hosts at once,
/// and a host that is unreachable or unauthorized is a visible state beside the
/// list, not a broken screen - on a tailnet the usual failure is "VPN dropped",
/// not "the data is gone".
///
/// What is visible, in which group and order, with which steps and unread counts, is the native core's `SessionList`
/// (shared with Android); this model only fetches, feeds it the bodies, and runs the actions. A phone has no open
/// folders, so the core's workspace scope is inert here.
@MainActor
@Observable
final class SessionListModel {
  enum Tab: String, CaseIterable, Identifiable {
    case live
    case resume

    var id: String { rawValue }
    var label: String { self == .live ? "Live" : "Resume" }
  }

  /// One gateway's fetch outcome. `failed` carries the server's own message.
  enum Probe: Equatable {
    case pending
    case connected
    case failed(String)
  }

  /// What one gateway last answered. Sessions survive a failed refresh - the
  /// probe says the reading is stale, the rows say what was true last time.
  struct HostSnapshot {
    var probe: Probe = .pending
    var sessions: [SessionInfo] = []
    var sdkSessions: [SdkSessionSummary] = []
    var hasLoadedSdkSessions = false
  }

  var tab: Tab = .live
  // How the list is filtered, grouped and sorted. The core owns it; this is its last reading, for the filter menu and
  // the search box. Persisted so the phone keeps the reader's layout.
  private(set) var filter: ListFilter
  var search: String {
    get { filter.search }
    set {
      core.setSearch(search: newValue)
      syncConfig()
    }
  }
  private(set) var snapshots: [UUID: HostSnapshot] = [:]
  // Bumped whenever the core was fed, so Observation re-derives what reads it: the core is not observable.
  private(set) var revision = 0
  private(set) var hasLoaded = false
  /// Project icon bytes, keyed by content hash and shared across every gateway
  /// in the list - see `ProjectIconLoader`. Held here because this is where the
  /// per-gateway clients live and where new rows arrive.
  let projectIcons = ProjectIconLoader()
  let agentAvatars = AgentAvatarLoader()
  private var metaRead: Set<UUID> = []
  var actionError: String?

  private let hostStore: HostStore
  private let unread: UnreadModel
  private let defaults: UserDefaults
  /// One `HostContext` per gateway, rebuilt when its host record changes (an
  /// edited address or key is a different client). This is what replaced the
  /// ambient per-gateway environment: downstream screens get the context for
  /// *their* session's gateway, explicitly.
  private var contexts: [UUID: HostContext] = [:]

  private static let configKey = "bi.atomic.workerdeck.ios.sessionListConfig"

  private var core: SessionList { unread.list }
  // The core list the filter menu writes to; `syncConfig` after every edit.
  var list: SessionList { unread.list }

  init(hosts: HostStore, unread: UnreadModel, defaults: UserDefaults = .standard) {
    self.hostStore = hosts
    self.unread = unread
    self.defaults = defaults
    filter = unread.list.filter()
    if let stored = defaults.string(forKey: Self.configKey)
      ?? defaults.data(forKey: Self.configKey).map({ String(decoding: $0, as: UTF8.self) })
    {
      unread.list.setConfigJson(json: stored)
    }
    syncConfig()
  }

  func syncConfig() {
    filter = core.filter()
    defaults.set(core.configJson(), forKey: Self.configKey)
    revision &+= 1
  }

  // MARK: - Contexts

  /// The per-gateway world (client + recent cwds) for a host, cached by id and
  /// rebuilt when the host record itself changed.
  func context(for hostId: UUID) -> HostContext? {
    guard let host = hostStore.hosts.first(where: { $0.id == hostId }) else { return nil }
    if let cached = contexts[hostId], cached.host == host { return cached }
    let fresh = HostContext(host: host)
    contexts[hostId] = fresh
    return fresh
  }

  // MARK: - Refresh

  /// Re-fetch every gateway's session rollup, concurrently; one host failing is
  /// that host's probe, never the list's.
  func refresh() async {
    let hosts = hostStore.hosts
    // Forget worlds whose host is gone, read marks included.
    for id in snapshots.keys where !hosts.contains(where: { $0.id == id }) {
      unread.forget(host: id)
    }
    snapshots = snapshots.filter { id, _ in hosts.contains { $0.id == id } }
    contexts = contexts.filter { id, _ in hosts.contains { $0.id == id } }

    await withTaskGroup(of: (UUID, Result<(sessions: [SessionInfo], body: String), any Error>).self) { group in
      for host in hosts {
        guard let client = context(for: host.id)?.client else {
          snapshots[host.id, default: HostSnapshot()].probe = .failed("Invalid server address")
          continue
        }
        group.addTask {
          do {
            return (host.id, .success(try await client.listSessionsBody()))
          } catch {
            return (host.id, .failure(error))
          }
        }
      }
      for await (id, outcome) in group {
        let host = hosts.first { $0.id == id }
        switch outcome {
        case .success(let reading):
          snapshots[id, default: HostSnapshot()].probe = .connected
          snapshots[id, default: HostSnapshot()].sessions = reading.sessions
          _ = try? core.setHost(
            hostId: id.uuidString, hostName: host?.displayName ?? "", local: host?.isLoopback ?? false,
            body: reading.body)
        case .failure(let error):
          snapshots[id, default: HostSnapshot()].probe = .failed(Self.describe(error))
          // An unreachable gateway's rows leave the list (its marks stay); the probe says why.
          _ = try? core.setHost(
            hostId: id.uuidString, hostName: host?.displayName ?? "", local: host?.isLoopback ?? false,
            body: #"{"sessions":[]}"#)
        }
      }
    }
    reindex()
    hasLoaded = true
    ensureProjectIcons()
    ensureAgentAvatars()
    await syncAppBadge()
    await ensureMetas()
  }

  private func ensureAgentAvatars() {
    for (hostId, snapshot) in snapshots {
      let client = context(for: hostId)?.client
      for info in snapshot.sessions where info.agent != nil {
        agentAvatars.ensure(hostId: hostId.uuidString, agent: info.agent, client: client)
      }
    }
  }

  private func ensureMetas() async {
    for host in hostStore.hosts where !metaRead.contains(host.id) && snapshots[host.id]?.probe == .connected {
      guard let client = context(for: host.id)?.client,
        let body = try? await client.metaBody(),
        core.setMeta(hostId: host.id.uuidString, body: body)
      else { continue }
      metaRead.insert(host.id)
      revision &+= 1
    }
  }

  /// Ask for any project icon this list needs and does not have.
  ///
  /// Driven off `snapshots` rather than `rows` for the plain reason that these
  /// are keyed by the gateway's `UUID`, which is what `context(for:)` wants -
  /// `SessionRow.hostId` is that id stringified for the shared view model.
  /// Cheap on the common path: a walk that finds every hash already known.
  private func ensureProjectIcons() {
    var requests: Set<ProjectIconLoader.Request> = []
    for (hostId, snapshot) in snapshots {
      for info in snapshot.sessions {
        guard case .image(_, let hash) = info.project?.icon else { continue }
        requests.insert(.init(hostId: hostId, sessionId: info.id, hash: hash))
      }
    }
    projectIcons.ensure(requests) { [weak self] id in self?.context(for: id)?.client }
  }

  /// The Agent SDK's on-disk sessions, per gateway, for the Resume tab.
  func refreshSdkSessions() async {
    let hosts = hostStore.hosts
    await withTaskGroup(of: (UUID, Result<[SdkSessionSummary], any Error>).self) { group in
      for host in hosts {
        guard let client = context(for: host.id)?.client else { continue }
        group.addTask {
          do {
            return (host.id, .success(try await client.listSdkSessions(limit: 50)))
          } catch {
            return (host.id, .failure(error))
          }
        }
      }
      for await (id, outcome) in group {
        switch outcome {
        case .success(let sdkSessions):
          snapshots[id, default: HostSnapshot()].sdkSessions = sdkSessions
          snapshots[id, default: HostSnapshot()].hasLoadedSdkSessions = true
        case .failure(let error):
          // Resume rides the same probe: an unreachable gateway reads the same
          // on both tabs.
          snapshots[id, default: HostSnapshot()].probe = .failed(Self.describe(error))
        }
      }
    }
  }

  /// Refresh whichever tab is showing (pull-to-refresh, foreground, post-create).
  func refreshCurrentTab() async {
    switch tab {
    case .live: await refresh()
    case .resume: await refreshSdkSessions()
    }
  }

  /// The poll follows the work, like the extension's: while anything runs or
  /// waits on a human the rollups move fast enough that 5s reads as asleep.
  var pollInterval: Duration {
    _ = revision
    return core.busy() ? .seconds(2) : .seconds(5)
  }

  // MARK: - Derived list (the core)

  // Every connected gateway's rollups by `host:session`, the core's row key.
  private var infos: [String: SessionInfo] = [:]

  private func reindex() {
    var out: [String: SessionInfo] = [:]
    for (hostId, snapshot) in snapshots where snapshot.probe == .connected {
      for info in snapshot.sessions { out["\(hostId.uuidString):\(info.id)"] = info }
    }
    infos = out
    revision &+= 1
  }

  func info(hostId: String, sessionId: String) -> SessionInfo? { infos["\(hostId):\(sessionId)"] }

  // Reads `unread.revision` too: a mark the session screen wrote must clear this list's badge.
  func sections(now: Double) -> [ListSection] {
    _ = (revision, unread.revision)
    return core.sections(now: now) { infos[$0] }
  }

  // When the soonest lingering Member leaves Auto, as of the last `sections` call.
  var lingerEnds: Double? { core.lingerEnds() }

  // The Member opened last: a phone's stand-in for the dashboard's selected row.
  func select(hostId: String, sessionId: String) {
    core.select(hostId: hostId, sessionId: sessionId)
    revision &+= 1
  }

  var subset: Subset? {
    _ = (revision, unread.revision)
    return core.subset()
  }

  var adapters: [String] {
    _ = revision
    return core.adapters()
  }

  var projects: [ProjectOption] {
    _ = revision
    return core.projects().map { ProjectOption(key: $0.key, label: $0.label) }
  }

  func clearFilters() {
    core.clearFilters()
    syncConfig()
  }

  func toggleEarlier() {
    core.toggleGroup(key: "earlier")
    syncConfig()
  }

  func toggleTeam(_ item: ListItem) {
    core.toggleTeam(hostId: item.row.hostId, sessionId: item.row.sessionId)
    syncConfig()
  }

  // Agents on the row's gateway it could join, leads first.
  func teamLeads(for item: ListItem) -> [TeamLead] {
    _ = revision
    return core.teamLeads(hostId: item.row.hostId, sessionId: item.row.sessionId)
  }

  /// Gateways that failed their last fetch, in host order, for the trouble strip.
  var failedHosts: [(host: Host, message: String)] {
    hostStore.hosts.compactMap { host in
      guard case .failed(let message) = snapshots[host.id]?.probe else { return nil }
      return (host, message)
    }
  }

  var anyConnected: Bool {
    snapshots.values.contains { $0.probe == .connected }
  }

  /// A gateway that has not answered yet, either way. Distinct from failure:
  /// one slow gateway beside one that already failed is not "nothing is
  /// reachable", it is a verdict that has not arrived. Without this, a fast
  /// failure next to a slow success flashes a warning strip and then withdraws
  /// it, which is worse than either state on its own.
  var anyPending: Bool {
    snapshots.values.contains { $0.probe == .pending }
      || hostStore.hosts.contains { snapshots[$0.id] == nil }
  }

  /// Every gateway has answered, and every one of them failed - the only state
  /// that earns the trouble strip. One gateway down beside one that works is a
  /// fact about a machine, not a problem with the list on screen.
  var allGatewaysDown: Bool {
    !hostStore.hosts.isEmpty && !anyConnected && !anyPending
  }

  // MARK: - App icon badge

  // Rows unseen over the sessions the filter is showing (the VS Code rule): a badge counting hidden sessions sends
  // you looking for something that isn't there.
  var unseenTotal: Int {
    _ = (revision, unread.revision)
    return Int(core.unseenTotal())
  }

  // Fails silently when the badge permission was declined; the in-app badges still work.
  func syncAppBadge() async {
    try? await UNUserNotificationCenter.current().setBadgeCount(unseenTotal)
  }

  // MARK: - Actions

  func close(_ item: ListItem) async {
    guard let hostId = item.hostUUID, let client = context(for: hostId)?.client else { return }
    do {
      try await client.deleteSession(id: item.info.id)
      // Its mark is noise now, and would count the whole history as read if the same id ever reappeared.
      unread.forget(host: hostId, sessionId: item.info.id)
      await refresh()
    } catch {
      snapshots[hostId, default: HostSnapshot()].probe = .failed(Self.describe(error))
    }
  }

  // `PATCH /sessions/:id`, never a local override: every client reads the same `meta.title`. Empty clears it.
  func rename(_ item: ListItem, to title: String) async {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    await act(on: item) {
      _ = try await $0.updateSession(
        id: item.info.id, UpdateSessionRequest(title: trimmed.isEmpty ? .clear : .set(trimmed)))
    }
  }

  func stopTask(_ item: ListItem, toolUseId: String) async {
    await act(on: item) { try await $0.stopTask(sessionId: item.info.id, toolUseId: toolUseId) }
  }

  func sleep(_ item: ListItem) async {
    await act(on: item) { _ = try await $0.sleepSession(id: item.info.id) }
  }

  func killShell(_ item: ListItem, shellId: String) async {
    await act(on: item) { _ = try await $0.killShell(sessionId: item.info.id, shellId: shellId) }
  }

  private func act(on item: ListItem, _ body: (WorkerClient) async throws -> Void) async {
    guard let hostId = item.hostUUID, let client = context(for: hostId)?.client else { return }
    do {
      try await body(client)
      await refresh()
    } catch {
      snapshots[hostId, default: HostSnapshot()].probe = .failed(Self.describe(error))
    }
  }

  // MARK: - Agents

  func setStatus(_ item: ListItem, to text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    await agentAct(on: item, "Could not set the status") {
      _ = try await $0.updateSession(
        id: item.info.id,
        UpdateSessionRequest(statusLabel: trimmed.isEmpty ? .clear : .set(text: trimmed, emoji: nil)))
    }
  }

  func renameAgent(_ item: ListItem, to name: String) async {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let agent = item.info.agent, !trimmed.isEmpty, trimmed != agent.name else { return }
    await agentAct(on: item, "Rename failed") {
      _ = try await $0.updateAgent(id: agent.id, UpdateAgentRequest(name: trimmed))
    }
  }

  func changeAvatar(_ item: ListItem) async {
    guard let agent = item.info.agent else { return }
    await agentAct(on: item, "Could not change the avatar") {
      _ = try await $0.changeAgentAvatar(id: agent.id)
    }
  }

  func makeAgent(_ item: ListItem) async {
    await agentAct(on: item, "Could not make an agent") {
      _ = try await $0.createAgent(CreateAgentRequest(adopt: item.info.id))
    }
  }

  // The lead's owner when it differs from the row's; the gateway refuses a cross-owner join without `crossOwner`.
  func crossedOwner(_ item: ListItem, into lead: TeamLead) -> String? {
    guard let mine = item.info.owner,
      let theirs = info(hostId: item.row.hostId, sessionId: lead.sessionId)?.owner, mine != theirs
    else { return nil }
    return theirs
  }

  func join(_ item: ListItem, lead: TeamLead, crossOwner: Bool = false) async {
    let crossing = crossOwner ? true : nil
    await agentAct(on: item, "Could not join the team") { client in
      if let agent = item.info.agent {
        try await client.updateAgent(
          id: agent.id, UpdateAgentRequest(lead: .join(lead.agentId), crossOwner: crossing))
      } else {
        try await client.createAgent(
          CreateAgentRequest(lead: lead.agentId, adopt: item.info.id, crossOwner: crossing))
      }
    }
  }

  func leave(_ item: ListItem) async {
    guard let agent = item.info.agent else { return }
    await agentAct(on: item, "Could not leave the team") {
      _ = try await $0.updateAgent(id: agent.id, UpdateAgentRequest(lead: .leave))
    }
  }

  func dissolve(_ item: ListItem) async {
    let members = core.teamMembers(hostId: item.row.hostId, sessionId: item.row.sessionId)
    await agentAct(on: item, "Could not dissolve the team") { client in
      for id in members {
        try await client.updateAgent(id: id, UpdateAgentRequest(lead: .leave))
      }
    }
  }

  func setSharing(_ item: ListItem, _ sharing: AgentSharing) async {
    guard let agent = item.info.agent else { return }
    await agentAct(on: item, "Could not change sharing") {
      _ = try await $0.updateAgent(id: agent.id, UpdateAgentRequest(sharing: sharing))
    }
  }

  func restart(_ item: ListItem) async -> SessionInfo? {
    guard let agent = item.info.agent else { return nil }
    var started: SessionInfo?
    await agentAct(on: item, "Could not start a new conversation") {
      started = try await $0.restartAgent(id: agent.id).session
    }
    return started
  }

  func retire(_ item: ListItem) async {
    guard let agent = item.info.agent else { return }
    await agentAct(on: item, "Could not retire the agent") {
      _ = try await $0.retireAgent(id: agent.id)
    }
  }

  // The create form's lead picker: this gateway's top-level agents, leads first.
  // The create form's lead picker and sharing default, from the core; nil while the gateway has not said it runs
  // agents.
  func agentSeed(for hostId: UUID, lead: ListItem? = nil) -> AgentSeed? {
    _ = revision
    guard let seed = core.agentSeed(hostId: hostId.uuidString, leadSessionId: lead?.info.id) else { return nil }
    return AgentSeed(
      leads: seed.leads.map { AgentSeed.Lead(id: $0.agentId, name: $0.name) }, lead: seed.lead,
      allowShared: seed.allowShared, sharing: seed.shared ? .shared : .private)
  }

  private func agentAct(on item: ListItem, _ failure: String, _ body: (WorkerClient) async throws -> Void) async {
    guard let hostId = item.hostUUID, let client = context(for: hostId)?.client else { return }
    do {
      try await body(client)
    } catch {
      actionError = "\(failure): \(Self.describe(error))"
    }
    await refresh()
  }

  static func describe(_ error: any Error) -> String {
    if let workerError = error as? WorkerClientError { return workerError.message }
    if let urlError = error as? URLError { return urlError.localizedDescription }
    return error.localizedDescription
  }
}
