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
    var sdkSessions: [SdkSession] = []
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

    await withTaskGroup(of: (UUID, Result<String, any Error>).self) { group in
      for host in hosts {
        guard let client = context(for: host.id)?.client else {
          snapshots[host.id, default: HostSnapshot()].probe = .failed("Invalid server address")
          continue
        }
        group.addTask {
          do {
            return (host.id, .success(String(decoding: try await client.perform(listSessionsCall()), as: UTF8.self)))
          } catch {
            return (host.id, .failure(error))
          }
        }
      }
      for await (id, outcome) in group {
        let host = hosts.first { $0.id == id }
        let read = outcome.flatMap { body in
          Result {
            try core.setHost(
              hostId: id.uuidString, hostName: host?.displayName ?? "", local: host?.isLoopback ?? false, body: body)
          }
        }
        switch read {
        case .success:
          snapshots[id, default: HostSnapshot()].probe = .connected
        case .failure(let error):
          snapshots[id, default: HostSnapshot()].probe = .failed(Self.describe(error))
          // An unreachable gateway's rows leave the list (its marks stay); the probe says why.
          _ = try? core.setHost(
            hostId: id.uuidString, hostName: host?.displayName ?? "", local: host?.isLoopback ?? false,
            body: #"{"sessions":[]}"#)
        }
      }
    }
    revision &+= 1
    hasLoaded = true
    ensureProjectIcons()
    ensureAgentAvatars()
    await syncAppBadge()
    await ensureMetas()
    await ensurePastAgents()
  }

  private func ensureAgentAvatars() {
    agentAvatars.ensure(list: core) { [weak self] hostId in
      UUID(uuidString: hostId).flatMap { self?.context(for: $0)?.client }
    }
  }

  private func ensureMetas() async {
    for host in hostStore.hosts where !metaRead.contains(host.id) && snapshots[host.id]?.probe == .connected {
      guard let client = context(for: host.id)?.client,
        let meta = try? await client.perform(metaCall()),
        core.setMeta(hostId: host.id.uuidString, body: String(decoding: meta, as: UTF8.self))
      else { continue }
      metaRead.insert(host.id)
      revision &+= 1
    }
  }

  // Any project picture a drawn row needs and the loader does not have; cheap when every hash is already known.
  private func ensureProjectIcons() {
    var requests: Set<ProjectIconLoader.Request> = []
    for group in core.groups(nowMs: Date().timeIntervalSince1970 * 1000) {
      for row in group.rows {
        guard let hash = row.projectIconHash, let hostId = UUID(uuidString: row.hostId) else { continue }
        requests.insert(.init(hostId: hostId, sessionId: row.sessionId, hash: hash))
      }
    }
    projectIcons.ensure(requests) { [weak self] id in self?.context(for: id)?.client }
  }

  /// The Agent SDK's on-disk sessions, per gateway, for the Resume tab.
  func refreshSdkSessions() async {
    let hosts = hostStore.hosts
    await withTaskGroup(of: (UUID, Result<[SdkSession], any Error>).self) { group in
      for host in hosts {
        guard let client = context(for: host.id)?.client else { continue }
        group.addTask {
          do {
            let body = String(decoding: try await client.perform(listSdkSessionsCall(limit: 50)), as: UTF8.self)
            guard let stored = sdkSessions(body: body, nowMs: Date().timeIntervalSince1970 * 1000) else {
              throw WorkerClientError(message: "The gateway sent stored sessions this app cannot read")
            }
            return (host.id, .success(stored))
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

  // The rows the last `sections` call drew, by the core's `host:session` key.
  @ObservationIgnored private var drawn: [String: ListRow] = [:]

  func row(hostId: String, sessionId: String) -> ListRow? { drawn["\(hostId):\(sessionId)"] }

  // Reads `unread.revision` too: a mark the session screen wrote must clear this list's badge.
  func sections(now: Double) -> [ListSection] {
    _ = (revision, unread.revision)
    let sections = core.sections(now: now)
    drawn = Dictionary(sections.flatMap(\.items).map { ($0.id, $0.row) }) { first, _ in first }
    return sections
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

  var projects: [ProjectChoice] {
    _ = revision
    return core.projects()
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
      try await client.perform(deleteSessionCall(id: item.sessionId))
      // Its mark is noise now, and would count the whole history as read if the same id ever reappeared.
      unread.forget(host: hostId, sessionId: item.sessionId)
      await refresh()
    } catch {
      snapshots[hostId, default: HostSnapshot()].probe = .failed(Self.describe(error))
    }
  }

  // `PATCH /sessions/:id`, never a local override: every client reads the same `meta.title`. Empty clears it.
  func rename(_ item: ListItem, to title: String) async {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    await act(on: item) {
      try await $0.perform(
        updateSessionCall(id: item.sessionId, patch: SessionPatch(title: trimmed.isEmpty ? .clear : .set(value: trimmed))))
    }
  }

  func stopTask(_ item: ListItem, toolUseId: String) async {
    await act(on: item) { try await $0.perform(stopTaskCall(sessionId: item.sessionId, toolUseId: toolUseId)) }
  }

  func sleep(_ item: ListItem) async {
    await act(on: item) { try await $0.perform(sleepSessionCall(id: item.sessionId)) }
  }

  func killShell(_ item: ListItem, shellId: String) async {
    await act(on: item) { try await $0.perform(killShellCall(sessionId: item.sessionId, shellId: shellId)) }
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
      let label: StatusEdit = trimmed.isEmpty ? .clear : .set(text: trimmed, emoji: nil)
      try await $0.perform(updateSessionCall(id: item.sessionId, patch: SessionPatch(statusLabel: label)))
    }
  }

  func renameAgent(_ item: ListItem, to name: String) async {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let agentId = item.row.agentId, !trimmed.isEmpty, trimmed != item.row.agent else { return }
    await agentAct(on: item, "Rename failed") {
      try await $0.perform(updateAgentCall(id: agentId, patch: AgentPatch(name: trimmed)))
    }
  }

  func changeAvatar(_ item: ListItem) async {
    guard let agentId = item.row.agentId else { return }
    await agentAct(on: item, "Could not change the avatar") {
      try await $0.perform(rerollAvatarCall(id: agentId))
    }
  }

  func makeAgent(_ item: ListItem) async {
    await agentAct(on: item, "Could not make an agent") {
      try await $0.perform(createAgentCall(request: NewAgent(adopt: item.sessionId)))
    }
  }

  // The lead's owner when it differs from the row's; the gateway refuses a cross-owner join without `crossOwner`.
  func crossedOwner(_ item: ListItem, into lead: TeamLead) -> String? {
    guard let mine = item.row.owner, let theirs = lead.owner, mine != theirs else { return nil }
    return theirs
  }

  func join(_ item: ListItem, lead: TeamLead, crossOwner: Bool = false) async {
    let crossing = crossOwner ? true : nil
    await agentAct(on: item, "Could not join the team") { client in
      if let agentId = item.row.agentId {
        try await client.perform(
          updateAgentCall(id: agentId, patch: AgentPatch(lead: .set(value: lead.agentId), crossOwner: crossing)))
      } else {
        try await client.perform(
          createAgentCall(request: NewAgent(lead: lead.agentId, adopt: item.sessionId, crossOwner: crossing)))
      }
    }
  }

  func leave(_ item: ListItem) async {
    guard let agentId = item.row.agentId else { return }
    await agentAct(on: item, "Could not leave the team") {
      try await $0.perform(updateAgentCall(id: agentId, patch: AgentPatch(lead: .clear)))
    }
  }

  func dissolve(_ item: ListItem) async {
    let members = core.teamMembers(hostId: item.row.hostId, sessionId: item.row.sessionId)
    await agentAct(on: item, "Could not dissolve the team") { client in
      for id in members {
        try await client.perform(updateAgentCall(id: id, patch: AgentPatch(lead: .clear)))
      }
    }
  }

  func setSharing(_ item: ListItem, _ sharing: AgentSharing) async {
    guard let agentId = item.row.agentId else { return }
    await agentAct(on: item, "Could not change sharing") {
      try await $0.perform(updateAgentCall(id: agentId, patch: AgentPatch(sharing: sharing == .shared ? .shared : .private)))
    }
  }

  // Names the conversation the row showed, so a row read before another client's rotation never rotates twice.
  func restart(_ item: ListItem) async {
    guard let agentId = item.row.agentId, item.row.newConversationBlocked == nil else { return }
    await agentAct(on: item, "Could not start a new conversation") {
      try await $0.perform(restartAgentCall(id: agentId, prompt: nil, expectedSessionId: item.sessionId))
    }
  }

  // The one removal for an agent: its conversations stay under Past agents and its members are released.
  func deleteAgent(_ item: ListItem) async {
    guard let agentId = item.row.agentId, let hostId = item.hostUUID else { return }
    await agentAct(on: item, "Could not delete the agent") {
      try await $0.perform(retireAgentCall(id: agentId, members: .release, expectedSessionId: item.sessionId))
    }
    await refreshPastAgents(hostId)
  }

  // MARK: - Conversations

  private(set) var pastAgents: [PastAgentEntry] = []
  private var pastRead: Set<UUID> = []

  func refreshPastAgents(_ hostId: UUID) async {
    guard let client = context(for: hostId)?.client else { return }
    let answer = await client.answer(retiredAgentsCall())
    let now = Date()
    let read = answer.status == 200 ? WorkerDeckCore.pastAgents(body: answer.body, nowMs: now.timeIntervalSince1970 * 1000, offsetMinutes: Self.offset(now)) : nil
    pastRead.insert(hostId)
    pastAgents = pastAgents.filter { $0.hostId != hostId } + (read ?? []).map { PastAgentEntry(hostId: hostId, agent: $0) }
  }

  private func ensurePastAgents() async {
    for host in hostStore.hosts where !pastRead.contains(host.id) && snapshots[host.id]?.probe == .connected {
      await refreshPastAgents(host.id)
    }
  }

  // Nil when the gateway could not answer; the sheet says so instead of showing an empty history.
  func conversations(hostId: UUID, agentId: String) async -> [ConversationItem]? {
    guard let client = context(for: hostId)?.client else { return nil }
    let answer = await client.answer(agentConversationsCall(id: agentId))
    let now = Date()
    guard answer.status == 200 else { return nil }
    return agentConversations(body: answer.body, nowMs: now.timeIntervalSince1970 * 1000, offsetMinutes: Self.offset(now))
  }

  static func offset(_ date: Date) -> Int32 { Int32(TimeZone.current.secondsFromGMT(for: date) / 60) }

  // Nil while the gateway has not said it runs agents.
  func agentSeed(for hostId: UUID) -> NewAgentSeed? {
    _ = revision
    return core.agentSeed(hostId: hostId.uuidString, leadSessionId: nil, profile: nil)
  }

  // The create form's agent seeding reads the list core directly.
  func createForm(for hostId: UUID, seed: CreateSessionSeed) -> CreateForm {
    seed.agent
      ? CreateForm.agent(cwd: seed.cwd, list: core, hostId: hostId.uuidString)
      : CreateForm.session(cwd: seed.cwd, resume: seed.resume)
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
