import WorkerDeckKit
import Foundation
import Observation
import UserNotifications

/// Every configured gateway's sessions in one model — the phone's counterpart of
/// the VS Code extension's `SessionsModel`. The gateway is a *facet* of the one
/// list (filter/group/sort), never the frame: rows come from all hosts at once,
/// and a host that is unreachable or unauthorized is a visible state beside the
/// list, not a broken screen — on a tailnet the usual failure is "VPN dropped",
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

  /// What one gateway last answered. Sessions survive a failed refresh — the
  /// probe says the reading is stale, the rows say what was true last time.
  struct HostSnapshot {
    var probe: Probe = .pending
    var sessions: [SessionInfo] = []
    var sdkSessions: [SdkSessionSummary] = []
    var hasLoadedSdkSessions = false
  }

  var tab: Tab = .live
  /// How the list is filtered, grouped and sorted — persisted, so the phone
  /// keeps the reader's layout the way the webview keeps its `bridge.setState`.
  var config: ViewConfig {
    didSet { persistConfig() }
  }
  private(set) var snapshots: [UUID: HostSnapshot] = [:]
  private(set) var hasLoaded = false
  /// Project icon bytes, keyed by content hash and shared across every gateway
  /// in the list — see `ProjectIconLoader`. Held here because this is where the
  /// per-gateway clients live and where new rows arrive.
  let projectIcons = ProjectIconLoader()

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
          // re-orders anyway — this keeps recency as the preserved input order.)
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
    await syncAppBadge()
  }

  /// Ask for any project icon this list needs and does not have.
  ///
  /// Driven off `snapshots` rather than `rows` for the plain reason that these
  /// are keyed by the gateway's `UUID`, which is what `context(for:)` wants —
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

  var groups: [SessionGroup] { groupRows(filtered, config: config) }

  /// The one "you are seeing a subset" signal — nil when nothing is hidden.
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

  // MARK: - App icon badge

  /// Rows unseen, summed over the sessions the filter is *showing* — the VS Code
  /// rule: a badge counting rows in hidden sessions sends you looking for
  /// something that isn't there.
  var unseenTotal: Int {
    filtered.reduce(0) { $0 + $1.unseen }
  }

  /// Stamp `unseenTotal` on the app icon. Fails silently when the badge
  /// permission was declined — the in-app badges still work.
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
      // Its mark is noise now — and would count the whole history as read if
      // the same id ever reappeared.
      unread.forget(host: hostId, sessionId: row.info.id)
      await refresh()
    } catch {
      snapshots[hostId, default: HostSnapshot()].probe = .failed(Self.describe(error))
    }
  }

  /// Rename a session on its gateway.
  ///
  /// `PATCH /sessions/:id`, never a local override — the dashboard and the VS
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

  static func describe(_ error: any Error) -> String {
    if let workerError = error as? WorkerClientError { return workerError.message }
    if let urlError = error as? URLError { return urlError.localizedDescription }
    return error.localizedDescription
  }
}
