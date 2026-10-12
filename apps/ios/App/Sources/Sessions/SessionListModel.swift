import WorkerDeckKit
import Foundation
import Observation
import UserNotifications

/// Every configured gateway's sessions in one model - the phone's counterpart of
/// the VS Code extension's `SessionsModel`. The gateway is a *facet* of the one
/// list (filter/group/sort), never the frame: rows come from all hosts at once,
/// and a host that is unreachable or unauthorized is a visible state beside the
/// list, not a broken screen - on a tailnet the usual failure is "VPN dropped",
/// not "the data is gone".
///
/// The derived chain (`rows` → `filtered` → `groups`, plus `subset`) is the
/// shared rules from the kit's `SessionList.swift`; nothing else in the app
/// decides what is visible. The workspace scope those rules know about is passed
/// as nil throughout: a phone has no open folders, so the scope filter is
/// genuinely inert here rather than hiding everything.
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
  /// How the list is filtered, grouped and sorted - persisted, so the phone
  /// keeps the reader's layout the way the webview keeps its `bridge.setState`.
  var config: ViewConfig {
    didSet { persistConfig() }
  }
  private(set) var snapshots: [UUID: HostSnapshot] = [:]
  private(set) var hasLoaded = false
  /// Project icon bytes, keyed by content hash and shared across every gateway
  /// in the list - see `ProjectIconLoader`. Held here because this is where the
  /// per-gateway clients live and where new rows arrive.
  let projectIcons = ProjectIconLoader()
  let agentAvatars = AgentAvatarLoader()
  private(set) var metas: [UUID: GatewayMeta] = [:]
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

  init(hosts: HostStore, unread: UnreadModel, defaults: UserDefaults = .standard) {
    self.hostStore = hosts
    self.unread = unread
    self.defaults = defaults
    config =
      defaults.data(forKey: Self.configKey)
      .flatMap { try? JSONDecoder().decode(ViewConfig.self, from: $0) } ?? .default
  }

  private func persistConfig() {
    guard let data = try? JSONEncoder().encode(config) else { return }
    defaults.set(data, forKey: Self.configKey)
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
    // Forget worlds whose host is gone.
    snapshots = snapshots.filter { id, _ in hosts.contains { $0.id == id } }
    contexts = contexts.filter { id, _ in hosts.contains { $0.id == id } }

    await withTaskGroup(of: (UUID, Result<[SessionInfo], any Error>).self) { group in
      for host in hosts {
        guard let client = context(for: host.id)?.client else {
          snapshots[host.id, default: HostSnapshot()].probe = .failed("Invalid server address")
          continue
        }
        group.addTask {
          do {
            return (host.id, .success(try await client.listSessions()))
          } catch {
            return (host.id, .failure(error))
          }
        }
      }
      for await (id, outcome) in group {
        switch outcome {
        case .success(let sessions):
          snapshots[id, default: HostSnapshot()].probe = .connected
          // Most recently active first; a session that never emitted an event
          // sorts by creation instead of falling to the bottom. (The shared sort
          // re-orders anyway - this keeps recency as the preserved input order.)
          snapshots[id, default: HostSnapshot()].sessions = sessions.sorted {
            ($0.lastActivityAt ?? $0.createdAt) > ($1.lastActivityAt ?? $1.createdAt)
          }
        case .failure(let error):
          snapshots[id, default: HostSnapshot()].probe = .failed(Self.describe(error))
        }
      }
    }
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
    for host in hostStore.hosts where metas[host.id] == nil && snapshots[host.id]?.probe == .connected {
      guard let client = context(for: host.id)?.client,
        let meta = try? await client.meta()
      else { continue }
      metas[host.id] = meta
    }
  }

  var relayHosts: [String: String] {
    relayHostsOf(Dictionary(uniqueKeysWithValues: metas.map { ($0.key.uuidString, $0.value.relay) }))
  }

  func agentDefaults(for hostId: UUID) -> GatewayAgentDefaults? { metas[hostId]?.agents }

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
    let busy = rows.contains { $0.state == .attention || $0.state == .working }
    return busy ? .seconds(2) : .seconds(5)
  }

  // MARK: - Derived list (the shared rules)

  /// Every connected gateway's sessions, flattened, with unseen counts attached.
  var rows: [SessionRow] {
    var out: [SessionRow] = []
    for host in hostStore.hosts {
      guard let snapshot = snapshots[host.id], snapshot.probe == .connected else { continue }
      for info in snapshot.sessions {
        out.append(
          SessionRow(
            hostId: host.id.uuidString,
            hostName: host.displayName,
            local: host.isLoopback,
            adapter: (info.engine ?? .claude).rawValue,
            state: sessionState(info),
            info: info,
            unseen: unread.unseen(host: host.id, info: info)))
      }
    }
    return out
  }

  var filtered: [SessionRow] { filterRows(rows, config: config, scope: nil) }

  var groups: [SessionGroup] {
    groupRows(
      filtered, config: config, gatewayCount: Set(rows.map(\.hostId)).count, all: rows,
      relayHosts: relayHosts)
  }

  /// The one "you are seeing a subset" signal - nil when nothing is hidden.
  var subset: SubsetSummary? {
    subsetSummary(config: config, scope: nil, shown: filtered.count, total: rows.count)
  }

  /// Adapter chips for the filter menu, derived from what is actually present.
  var adapters: [String] { adaptersOf(rows) }
  /// The projects present, for the filter control. Derived like `adapters`, and
  /// handed to `FilterMenu` as a value for the reason documented there.
  var projects: [ProjectOption] { projectsOf(rows) }

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

  /// Rows unseen, summed over the sessions the filter is *showing* - the VS Code
  /// rule: a badge counting rows in hidden sessions sends you looking for
  /// something that isn't there.
  var unseenTotal: Int {
    filtered.reduce(0) { $0 + $1.unseen }
  }

  /// Stamp `unseenTotal` on the app icon. Fails silently when the badge
  /// permission was declined - the in-app badges still work.
  func syncAppBadge() async {
    try? await UNUserNotificationCenter.current().setBadgeCount(unseenTotal)
  }

  // MARK: - Actions

  func close(_ row: SessionRow) async {
    guard let hostId = UUID(uuidString: row.hostId),
      let client = context(for: hostId)?.client
    else { return }
    do {
      try await client.deleteSession(id: row.info.id)
      // Its mark is noise now - and would count the whole history as read if
      // the same id ever reappeared.
      unread.forget(host: hostId, sessionId: row.info.id)
      await refresh()
    } catch {
      snapshots[hostId, default: HostSnapshot()].probe = .failed(Self.describe(error))
    }
  }

  /// Rename a session on its gateway.
  ///
  /// `PATCH /sessions/:id`, never a local override - the dashboard and the VS
  /// Code extension read the same `meta.title`, and a name only this phone knew
  /// would be a name nobody else could search for. An empty string clears the
  /// override, restoring the title the gateway derives.
  func rename(_ row: SessionRow, to title: String) async {
    guard let hostId = UUID(uuidString: row.hostId),
      let client = context(for: hostId)?.client
    else { return }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      try await client.updateSession(
        id: row.info.id,
        UpdateSessionRequest(title: trimmed.isEmpty ? .clear : .set(trimmed)))
      await refresh()
    } catch {
      snapshots[hostId, default: HostSnapshot()].probe = .failed(Self.describe(error))
    }
  }

  /// Stop a background task the engine offered to stop (`stoppable`), then
  /// refresh so its row settles.
  func stopTask(_ row: SessionRow, toolUseId: String) async {
    await act(on: row) { try await $0.stopTask(sessionId: row.info.id, toolUseId: toolUseId) }
  }

  func sleep(_ row: SessionRow) async {
    await act(on: row) { _ = try await $0.sleepSession(id: row.info.id) }
  }

  func killShell(_ row: SessionRow, shellId: String) async {
    await act(on: row) { _ = try await $0.killShell(sessionId: row.info.id, shellId: shellId) }
  }

  private func act(on row: SessionRow, _ body: (WorkerClient) async throws -> Void) async {
    guard let hostId = UUID(uuidString: row.hostId),
      let client = context(for: hostId)?.client
    else { return }
    do {
      try await body(client)
      await refresh()
    } catch {
      snapshots[hostId, default: HostSnapshot()].probe = .failed(Self.describe(error))
    }
  }

  // MARK: - Agents

  func setStatus(_ row: SessionRow, to text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    await agentAct(on: row, "Could not set the status") {
      _ = try await $0.updateSession(
        id: row.info.id,
        UpdateSessionRequest(statusLabel: trimmed.isEmpty ? .clear : .set(text: trimmed, emoji: nil)))
    }
  }

  func renameAgent(_ row: SessionRow, to name: String) async {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let agent = row.info.agent, !trimmed.isEmpty, trimmed != agent.name else { return }
    await agentAct(on: row, "Rename failed") {
      _ = try await $0.updateAgent(id: agent.id, UpdateAgentRequest(name: trimmed))
    }
  }

  func changeAvatar(_ row: SessionRow) async {
    guard let agent = row.info.agent else { return }
    await agentAct(on: row, "Could not change the avatar") {
      _ = try await $0.changeAgentAvatar(id: agent.id)
    }
  }

  func makeAgent(_ row: SessionRow) async {
    await agentAct(on: row, "Could not make an agent") {
      _ = try await $0.createAgent(CreateAgentRequest(adopt: row.info.id))
    }
  }

  // Owners differ only when both rows name one; the gateway refuses a cross-owner join without `crossOwner`.
  func crossesOwners(_ row: SessionRow, into lead: SessionRow) -> Bool {
    guard let mine = row.info.owner, let theirs = lead.info.owner else { return false }
    return mine != theirs
  }

  func join(_ row: SessionRow, lead: SessionRow, crossOwner: Bool = false) async {
    guard let leadId = lead.info.agent?.id else { return }
    let crossing = crossOwner ? true : nil
    await agentAct(on: row, "Could not join the team") { client in
      if let agent = row.info.agent {
        try await client.updateAgent(
          id: agent.id, UpdateAgentRequest(lead: .join(leadId), crossOwner: crossing))
      } else {
        try await client.createAgent(
          CreateAgentRequest(lead: leadId, adopt: row.info.id, crossOwner: crossing))
      }
    }
  }

  func leave(_ row: SessionRow) async {
    guard let agent = row.info.agent else { return }
    await agentAct(on: row, "Could not leave the team") {
      _ = try await $0.updateAgent(id: agent.id, UpdateAgentRequest(lead: .leave))
    }
  }

  func dissolve(_ row: SessionRow) async {
    let members = teamMembers(row, in: rows).compactMap(\.info.agent?.id)
    await agentAct(on: row, "Could not dissolve the team") { client in
      for id in members {
        try await client.updateAgent(id: id, UpdateAgentRequest(lead: .leave))
      }
    }
  }

  func setSharing(_ row: SessionRow, _ sharing: AgentSharing) async {
    guard let agent = row.info.agent else { return }
    await agentAct(on: row, "Could not change sharing") {
      _ = try await $0.updateAgent(id: agent.id, UpdateAgentRequest(sharing: sharing))
    }
  }

  func restart(_ row: SessionRow) async -> SessionInfo? {
    guard let agent = row.info.agent else { return nil }
    var started: SessionInfo?
    await agentAct(on: row, "Could not start a new conversation") {
      started = try await $0.restartAgent(id: agent.id).session
    }
    return started
  }

  func retire(_ row: SessionRow) async {
    guard let agent = row.info.agent else { return }
    await agentAct(on: row, "Could not retire the agent") {
      _ = try await $0.retireAgent(id: agent.id)
    }
  }

  func agentSeed(for hostId: UUID, lead: SessionRow? = nil) -> AgentSeed {
    let leads = rows.filter {
      $0.hostId == hostId.uuidString && $0.info.agent != nil && $0.info.agent?.lead == nil
    }
    .sorted { ($0.info.agent?.isLead == true ? 0 : 1) < ($1.info.agent?.isLead == true ? 0 : 1) }
    .compactMap { row in row.info.agent.map { AgentSeed.Lead(id: $0.id, name: $0.name) } }
    let defaults = agentDefaults(for: hostId)
    return AgentSeed(
      leads: leads, lead: lead?.info.agent?.id, allowShared: defaults?.allowShared ?? false,
      sharing: defaults?.sharing ?? .private)
  }

  private func agentAct(
    on row: SessionRow, _ failure: String, _ body: (WorkerClient) async throws -> Void
  ) async {
    guard let hostId = UUID(uuidString: row.hostId),
      let client = context(for: hostId)?.client
    else { return }
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
