import Foundation

/// The sessions-list view model: how a list of sessions is filtered, grouped and
/// sorted, kept pure and separate from the views so every surface renders one
/// derived list and nothing else decides what is visible.
///
/// A line-by-line port of `packages/protocol/src/session-list.ts` - the
/// semantics are the contract, not the shape of the code. When the rules change
/// there, they change here. More than one party has to agree: the VS Code
/// sidebar (whose activity-bar badge counts the *same* rows the list shows), the
/// dashboard, and this app all derive their list from these rules.
///
/// Sessions are shown across ALL gateways by default; the gateway is a facet
/// like any other, not the frame the list lives in.

// MARK: - State buckets

/// Coarse lifecycle bucket - what a person actually filters on. Raw statuses are
/// too many and too engine-shaped ('starting' vs 'running' is not a decision).
public enum SessionState: String, Codable, Sendable, Hashable, CaseIterable {
  case attention
  case working
  case idle
  case ended

  /// Mirror of `STATE_ORDER` - worst first.
  public static let order: [SessionState] = [.attention, .working, .idle, .ended]

  /// Mirror of `STATE_LABELS`.
  public var label: String {
    switch self {
    case .attention: return "Needs attention"
    case .working: return "Working"
    case .idle: return "Idle"
    case .ended: return "Ended"
    }
  }
}

public func sessionState(_ info: SessionInfo) -> SessionState {
  // A pending approval outranks everything, a running background agent
  // included: it is the one thing the person has to act on.
  if info.pendingPermissionCount > 0 || info.status == .awaitingApproval { return .attention }
  // Terminal statuses before the sub-agent arm, defensively: the gateway's
  // `session_closed` sweep settles every sub-agent record (the process hosting
  // them is gone), so a closed session carrying a `running` record should be
  // unreachable - but a stale one must read `ended`, never `working`.
  if info.status == .failed || info.status == .closed { return .ended }
  if info.status == .running || info.status == .starting { return .working }
  // A *background* agent outlives its turn by design: the turn ends, `status`
  // comes to rest at idle, and the agent keeps working. Without this arm the
  // row read Idle while an agent burned tokens - the status alone cannot carry
  // it, because the status is the *turn's*.
  if !runningSubagents(info).isEmpty { return .working }
  return .idle
}

/// The sub-agents a list row draws as live.
///
/// `sessionState` deliberately does **not** grow a `subagents` bucket - a fifth
/// state would split `working` in two for every client that filters by it,
/// including the ones that have not shipped this yet. Instead `working`
/// *counts* them: a synchronous `Task` keeps the turn in flight so the status
/// already says `working`, and a **background** agent is the carve-out the
/// extra arm exists for. That is what makes "sub-agents are an annotation on a
/// working row" true rather than assumed.
public func runningSubagents(_ info: SessionInfo) -> [SubagentInfo] {
  (info.subagents ?? []).filter { $0.status == .running }
}

/// The shells a list row draws - the mirror of protocol's `promotedShells`.
///
/// A row is not a shell log: a `$ ls` that ran for 40ms and exited 0 is noise on
/// a card, and every client must agree on which ones earn a line. Running counts
/// once it has lasted ``WorkerProtocol/shellPromoteMs`` (that is what separates
/// `npm run dev` from `ls`); a failure counts for
/// ``WorkerProtocol/shellLingerMs`` after it ended, and only if it ran long
/// enough to have been promoted while it lived.
public func promotedShells(_ info: SessionInfo, now: Double) -> [ShellInfo] {
  (info.shells ?? []).filter { shell in
    if shell.status == .running {
      return now - shell.startedAt >= WorkerProtocol.shellPromoteMs
    }
    // A *reported* non-zero exit. A killed shell and one reconciled from a
    // gateway restart carry no exit code at all, and treating "not zero" as
    // "failed" kept both on the card for a minute wearing a failure's colour.
    guard let endedAt = shell.endedAt, let code = shell.exitCode, code != 0 else { return false }
    return endedAt - shell.startedAt >= WorkerProtocol.shellPromoteMs
      && now - endedAt < WorkerProtocol.shellLingerMs
  }
}

/// How much of one of a card's child lists (agents, shells, tasks) it draws. A
/// layout preference, not a facet filter, so `clearFilters` preserves it the way
/// it preserves grouping and sort. Mirror of protocol's `StepDisplay`.
public enum StepDisplay: String, Codable, Sendable, Hashable, CaseIterable {
  case all, active, none
}

public typealias SubagentDisplay = StepDisplay

/// `.active` is the promoted running shells; `.all` adds every shell that has
/// ended, whatever its exit. Mirror of protocol's `visibleShells`.
public func visibleShells(_ info: SessionInfo, _ show: StepDisplay, now: Double) -> [ShellInfo] {
  guard show != .none else { return [] }
  let shells = (info.shells ?? []).filter {
    $0.status != .running || now - $0.startedAt >= WorkerProtocol.shellPromoteMs
  }
  return show == .active ? shells.filter { $0.status == .running } : shells
}

/// `.active` keeps only running records. Mirror of protocol's `visibleSubagents`.
public func visibleSubagents(_ info: SessionInfo, _ show: SubagentDisplay) -> [SubagentInfo] {
  guard show != .none else { return [] }
  let subagents = info.subagents ?? []
  return show == .all ? subagents : subagents.filter { $0.status == .running }
}

/// A sub-agent's identity on one line: `Explore · find the auth check`.
///
/// The mirror of protocol's `subagentLabel`, and the reason it is shared: the
/// dashboard, the extension and this app render the same records, and two
/// spellings would be two answers to "which agent is this". Falls back to the
/// bare type, then to a generic word - a row with no label reads as a bug, and
/// an engine may send neither field.
public func subagentLabel(_ sub: SubagentInfo) -> String {
  let agent = sub.agentType?.trimmingCharacters(in: .whitespacesAndNewlines)
  let description = sub.description?.trimmingCharacters(in: .whitespacesAndNewlines)
  if let agent, !agent.isEmpty, let description, !description.isEmpty {
    return "\(agent) · \(description)"
  }
  if let agent, !agent.isEmpty { return agent }
  if let description, !description.isEmpty { return description }
  return "Sub-agent"
}

/// Does this record name an **agent**, as opposed to a task the model merely
/// described? A 1:1 mirror of protocol's `isAgentRecord`.
///
/// The tracker opens a record for every spawner call and for any nested event
/// whose parent it has not seen, so the list holds two different things wearing
/// one shape. One carries a `subagent_type` - a delegated agent with an identity
/// (`Explore`), whose own work is worth a surface of its own. The other carries
/// only a description, and there is no agent there to open. An engine that runs
/// every record as an agent says so with `isAgent`, because its records may carry
/// no name at all.
///
/// Shared rather than re-derived because it decides two things no two clients
/// may disagree about: what is pressable, and what wears the sub-agent colour.
public func isAgentRecord(_ sub: SubagentInfo) -> Bool {
  if sub.isAgent == true { return true }
  guard let agent = sub.agentType?.trimmingCharacters(in: .whitespacesAndNewlines) else {
    return false
  }
  return !agent.isEmpty
}

// MARK: - View config

/// The facets a session can be grouped or sorted by.
public enum Facet: String, Codable, Sendable, Hashable {
  case gateway
  case adapter
  case state
  case project
}

/// Mirror of TS `GroupBy`, less `custom`, which this client does not draw yet.
/// There is no gateway grouping: project groups name their gateway once there
/// is more than one.
public enum GroupBy: String, Codable, Sendable, Hashable, CaseIterable {
  case none, adapter, state, project

  public var facet: Facet? { Facet(rawValue: rawValue) }
}

/// TS `SortBy` is `'recent' | 'name' | Facet`.
public enum SortBy: String, Codable, Sendable, Hashable, CaseIterable {
  case recent, name, gateway, adapter, state, project

  public var facet: Facet? { Facet(rawValue: rawValue) }
}

public struct ViewConfig: Codable, Sendable, Equatable, Hashable {
  public var search: String
  /// Empty = no filter. Ids, not names: names are editable.
  public var gateways: [String]
  public var adapters: [String]
  public var states: [SessionState]
  /// Empty = no filter. `projectKey` output, never names: a name is neither
  /// unique (two repos both called "api") nor stable (editing
  /// `.workerdeck.json` renames every session at once and must not empty a
  /// saved filter). TS keeps this field *optional* so a stored config
  /// predating it keeps filtering; here the lenient decode below carries that
  /// rule - absent decodes to empty, and empty means no filter.
  public var projects: [String]
  /// Show only sessions inside the host's own folders. Inert where there is no
  /// such notion (no folder open - which on a phone is always), which is why it
  /// can default on.
  public var scoped: Bool
  public var groupBy: GroupBy
  public var sortBy: SortBy
  public var subagents: StepDisplay
  public var shells: StepDisplay
  public var tasks: StepDisplay
  public var expandedTeams: [String]
  public var earlierOpen: Bool

  public init(
    search: String = "", gateways: [String] = [], adapters: [String] = [],
    states: [SessionState] = [], projects: [String] = [], scoped: Bool = true,
    groupBy: GroupBy = .state, sortBy: SortBy = .recent,
    subagents: StepDisplay = .active, shells: StepDisplay = .active, tasks: StepDisplay = .active,
    expandedTeams: [String] = [], earlierOpen: Bool = false
  ) {
    self.search = search
    self.gateways = gateways
    self.adapters = adapters
    self.states = states
    self.projects = projects
    self.scoped = scoped
    self.groupBy = groupBy
    self.sortBy = sortBy
    self.subagents = subagents
    self.shells = shells
    self.tasks = tasks
    self.expandedTeams = expandedTeams
    self.earlierOpen = earlierOpen
  }

  /// Mirror of `DEFAULT_VIEW_CONFIG`.
  public static let `default` = ViewConfig()

  /// Lenient decode over the defaults, the Swift spelling of the webview's
  /// "spread over the defaults": a config persisted by an older build is missing
  /// whatever fields have been added since, and unknown enum strings (a newer
  /// build's vocabulary) degrade to the default rather than failing the load.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    search = try c.decodeIfPresent(String.self, forKey: .search) ?? ""
    gateways = try c.decodeIfPresent([String].self, forKey: .gateways) ?? []
    adapters = try c.decodeIfPresent([String].self, forKey: .adapters) ?? []
    let rawStates = try c.decodeIfPresent([String].self, forKey: .states) ?? []
    states = rawStates.compactMap { SessionState(rawValue: $0) }
    // Absent must mean "no filter", never "filter by nothing": a config
    // persisted before the project facet existed has no such key, and failing
    // - or filtering - here would empty the list for everyone who upgraded.
    projects = try c.decodeIfPresent([String].self, forKey: .projects) ?? []
    scoped = try c.decodeIfPresent(Bool.self, forKey: .scoped) ?? true
    // A stored "gateway" predates the merge into project groups.
    groupBy =
      (try c.decodeIfPresent(String.self, forKey: .groupBy)).flatMap {
        $0 == "gateway" ? .project : GroupBy(rawValue: $0)
      }
      ?? .state
    sortBy =
      (try c.decodeIfPresent(String.self, forKey: .sortBy)).flatMap { SortBy(rawValue: $0) }
      ?? .recent
    subagents = try Self.display(c, .subagents)
    shells = try Self.display(c, .shells)
    tasks = try Self.display(c, .tasks)
    // A stored `collapsedTeams` is dropped, not migrated: it held the inverse.
    expandedTeams = (try? c.decodeIfPresent([String].self, forKey: .expandedTeams)) ?? []
    earlierOpen = (try? c.decodeIfPresent(Bool.self, forKey: .earlierOpen)) ?? false
  }

  private static func display(
    _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
  ) throws -> StepDisplay {
    (try c.decodeIfPresent(String.self, forKey: key)).flatMap { StepDisplay(rawValue: $0) }
      ?? .active
  }

  private enum CodingKeys: String, CodingKey {
    case search, gateways, adapters, states, projects, scoped, groupBy, sortBy, subagents, shells,
      tasks, expandedTeams, earlierOpen
  }
}

// MARK: - Workspace scope

/// One folder the surrounding host has open, as a place sessions can live in.
///
/// `hostId` present = the folder belongs to exactly that gateway. Absent = a
/// real local folder, which only a loopback gateway's cwds can be inside: a
/// remote gateway's paths are on another machine, where an identical-looking
/// path means nothing.
public struct ScopeRoot: Sendable, Equatable {
  public var hostId: String?
  public var path: String

  public init(hostId: String? = nil, path: String) {
    self.hostId = hostId
    self.path = path
  }
}

/// The host's own folders - the sessions list's intrinsic scope. A phone has no
/// open folders, so on iOS this is always nil and the scope filter is inert.
public struct WorkspaceScope: Sendable, Equatable {
  public var label: String
  public var roots: [ScopeRoot]

  public init(label: String, roots: [ScopeRoot]) {
    self.label = label
    self.roots = roots
  }
}

// MARK: - Rows and groups

/// A session with everything the list needs to filter, group and label it.
public struct SessionRow: Sendable, Equatable, Identifiable {
  public var hostId: String
  public var hostName: String
  /// Its gateway is loopback - its cwds are paths on this machine.
  public var local: Bool
  public var adapter: String
  public var state: SessionState
  public var info: SessionInfo
  /// Transcript rows since this session was last on screen. 0 = nothing new (or
  /// never visited, which is not the same as unread).
  public var unseen: Int
  public var members: [SessionRow]?
  public var teamState: SessionState?
  public var context: Bool

  /// Session ids are unique per gateway, not globally.
  public var id: String { "\(hostId):\(info.id)" }

  public init(
    hostId: String, hostName: String, local: Bool, adapter: String, state: SessionState,
    info: SessionInfo, unseen: Int, members: [SessionRow]? = nil, teamState: SessionState? = nil,
    context: Bool = false
  ) {
    self.hostId = hostId
    self.hostName = hostName
    self.local = local
    self.adapter = adapter
    self.state = state
    self.info = info
    self.unseen = unseen
    self.members = members
    self.teamState = teamState
    self.context = context
  }
}

public struct SessionGroup: Sendable, Equatable, Identifiable {
  public var key: String
  public var label: String?
  public var rows: [SessionRow]
  public var earlier: Bool

  public var id: String { key }

  public init(key: String, label: String? = nil, rows: [SessionRow], earlier: Bool = false) {
    self.key = key
    self.label = label
    self.rows = rows
    self.earlier = earlier
  }
}

/// The adapters actually present, for the filter chips - derived rather than
/// enumerated, so a new engine needs no change here.
public func adaptersOf(_ rows: [SessionRow]) -> [String] {
  Array(Set(rows.map(\.adapter))).sorted()
}

/// One entry of the project filter control - a pair because the two halves
/// differ: the *key* is what `ViewConfig.projects` holds (gateway-qualified
/// root, so a rename regroups nothing) and the *label* is what a person picks
/// by.
public struct ProjectOption: Sendable, Equatable, Hashable, Identifiable {
  public var key: String
  public var label: String

  public var id: String { key }

  public init(key: String, label: String) {
    self.key = key
    self.label = label
  }
}

/// The projects actually present, for the filter control - derived like
/// `adaptersOf`, so nothing needs enumerating. Sorted by label
/// case-insensitively, deduped by key. Two projects with the same name on two
/// gateways therefore stay two entries wearing one word - which is honest:
/// they really are two different directories, and the alternative is a filter
/// that silently selects both.
public func projectsOf(_ rows: [SessionRow]) -> [ProjectOption] {
  var order: [String] = []
  var labels: [String: String] = [:]
  for row in rows {
    let key = projectKey(row)
    if labels[key] == nil { order.append(key) }
    labels[key] = projectLabel(row.info)
  }
  // TS sorts a Map's entries with the stable `Array.sort`, so equal labels
  // (the remote twin) keep first-seen order; Swift's sort promises no such
  // thing, hence the explicit offset tiebreak.
  return order.enumerated()
    .sorted { a, b in
      let la = (labels[a.element] ?? "").lowercased()
      let lb = (labels[b.element] ?? "").lowercased()
      return la == lb ? a.offset < b.offset : la < lb
    }
    .map { ProjectOption(key: $0.element, label: labels[$0.element] ?? "") }
}

public func sessionLabel(_ info: SessionInfo) -> String {
  info.title ?? String(info.id.prefix(8))
}

/// The project facet's grouping key: gateway id + the project root, falling
/// back to the session's cwd when no project is declared.
///
/// The root and not the name, because a name is not a key (two repos can both
/// be called "api", and a rename must regroup nothing); qualified by gateway,
/// because a remote gateway's identical-looking path is another machine's
/// directory - the same rule `ScopeRoot` states. The cwd fallback is what
/// makes grouping by project useful before anyone has written a
/// `.workerdeck.json`: undeclared sessions group by their folder, and a
/// session in `packages/ui` joins its repo's group the moment the file
/// exists. Sessions with no cwd at all (a filesystem-less engine) share one
/// per-gateway bucket - see `projectLabel`.
public func projectKey(_ row: SessionRow) -> String {
  "\(row.hostId):\(normalizePath(row.info.project?.root ?? row.info.cwd))"
}

/// What a project group (or a row's project slot) is called: the declared
/// shortcode if there is one, else the declared name, else the cwd's basename - the exact string this client rendered
/// before the feature existed, so an undeclared project looks like today.
/// "No project" is only ever the no-cwd case (a sandboxed provider session),
/// where there is no folder to name.
///
/// Takes the bare `SessionInfo` - the mirror of TS narrowing its parameter to
/// `Pick<SessionRow, 'info'>`: a cell holding only the info must not invent
/// the rest of a row to name it, and two spellings of this string would put
/// the list and its group headers on different names.
public func projectLabel(_ info: SessionInfo) -> String {
  if let shortcode = info.project?.shortcode, !shortcode.isEmpty { return shortcode }
  return projectName(info)
}

/// The full project name, never abbreviated - what `projectLabel` returned
/// before shortcodes existed, and what a surface with room for the whole name
/// draws.
public func projectName(_ info: SessionInfo) -> String {
  if let name = info.project?.name, !name.isEmpty { return name }
  let dir = normalizePath(info.cwd)
  if let slash = dir.lastIndex(of: "/") {
    let base = String(dir[dir.index(after: slash)...])
    return base.isEmpty ? "No project" : base
  }
  return dir.isEmpty ? "No project" : dir
}

/// Where inside its project a session actually sits - the cwd with the project
/// root taken off the front, or nil when it sits at the root, has no declared
/// project, or has no cwd at all. Mirrors `projectSubpath` in
/// `packages/protocol/src/session-list.ts`.
///
/// The companion to `projectLabel`, for a list **grouped by project**: the
/// header has already said the name, so a row repeating it spends its most
/// valuable line on a fact the reader already has. What the header cannot say is
/// which *part* of the project a session is in, and that is what tells two
/// sessions in one repo apart.
///
/// Nil at the root is deliberate and callers must draw nothing - not a "."​, not
/// the name again. Nil is also the honest answer when the cwd is not under the
/// root at all, which is not paranoia: `root` is the gateway's **realpath'd**
/// directory while `cwd` is the path as given, so a session started through a
/// symlink (`/tmp/x` against `/private/tmp/x`) has a perfectly good project and
/// no computable relative path.
public func projectSubpath(_ info: SessionInfo) -> String? {
  guard let root = info.project?.root, !info.cwd.isEmpty else { return nil }
  let base = normalizePath(root)
  let dir = normalizePath(info.cwd)
  if dir == base { return nil }
  // A prefix match is not containment: '/a/repo-two' starts with '/a/repo'.
  guard dir.hasPrefix(base + "/") else { return nil }
  let relative = String(dir.dropFirst(base.count + 1))
  return relative.isEmpty ? nil : relative
}

/// This session is a job run - the queue created it, and `JobInfo.sessionId`
/// points at it. A 1:1 mirror of protocol's `isJobRun`.
///
/// A job run is an ordinary registry session in every other respect, which is
/// what makes it worth spelling once: a client that renders jobs on their own
/// surface should not list them again among the sessions, and a client with no
/// jobs surface - **the extension, this app** - should, or they would be
/// invisible. The phone has no jobs surface, so nothing here filters on it; it
/// is mirrored so that the day one appears, "should the list show these" is a
/// decision already made rather than one rediscovered. The queue stamps
/// `meta.jobId`; nothing else may write that key.
public func isJobRun(_ info: SessionInfo) -> Bool {
  info.meta?["jobId"]?.stringValue != nil
}

private func matchesSearch(_ row: SessionRow, needle: String) -> Bool {
  if needle.isEmpty { return true }
  return sessionLabel(row.info).lowercased().contains(needle)
    || (row.info.agent?.name.lowercased().contains(needle) ?? false)
    || row.info.cwd.lowercased().contains(needle)
    // The declared project name: the whole point of it is that a person knows
    // the repo as "WorkerDeck", not by whatever the folder happens to be
    // called.
    || (row.info.project?.name.lowercased().contains(needle) ?? false)
    || (row.info.project?.shortcode?.lowercased().contains(needle) ?? false)
    || row.hostName.lowercased().contains(needle)
    || row.adapter.lowercased().contains(needle)
    // An id is matched by prefix only - a hex soup matching mid-string would
    // surface rows nobody was looking for.
    || row.info.id.hasPrefix(needle)
}

// MARK: - Scope containment

/// Trailing separators dropped and separators unified, so containment is a
/// plain prefix test on both a posix and a Windows gateway.
private func normalizePath(_ path: String) -> String {
  var unified = path.replacingOccurrences(of: "\\", with: "/")
  while unified.hasSuffix("/") { unified.removeLast() }
  return unified
}

private func isWithin(root: String, path: String) -> Bool {
  let base = normalizePath(root)
  let dir = normalizePath(path)
  // The separator matters: /a/project must not swallow /a/project-2.
  return dir == base || dir.hasPrefix(base + "/")
}

/// Is this session inside one of the host's folders? A gateway-tagged root only
/// ever matches its own gateway; an untagged one only matches a loopback
/// gateway, because a remote gateway's identical-looking path is a different
/// machine's directory.
public func inScope(_ row: SessionRow, scope: WorkspaceScope) -> Bool {
  scope.roots.contains { root in
    let hostMatches =
      root.hostId.map { $0.lowercased() == row.hostId.lowercased() } ?? row.local
    return hostMatches && isWithin(root: root.path, path: row.info.cwd)
  }
}

/// Whether the scope filter is actually hiding anything - it is inert with no
/// folder open, and that is the difference between a default and a filter.
public func scopeActive(_ config: ViewConfig, scope: WorkspaceScope?) -> Bool {
  config.scoped && scope != nil
}

// MARK: - Filtering

public func filterRows(
  _ rows: [SessionRow], config: ViewConfig, scope: WorkspaceScope? = nil
) -> [SessionRow] {
  let needle = config.search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let scoping = scopeActive(config, scope: scope) ? scope : nil
  return rows.filter { row in
    (config.gateways.isEmpty || config.gateways.contains(row.hostId))
      && (config.adapters.isEmpty || config.adapters.contains(row.adapter))
      && (config.states.isEmpty || config.states.contains(row.state))
      && (config.projects.isEmpty || config.projects.contains(projectKey(row)))
      && (scoping.map { inScope(row, scope: $0) } ?? true)
      && matchesSearch(row, needle: needle)
  }
}

// MARK: - Sorting and grouping

private func facetKey(_ row: SessionRow, _ facet: Facet) -> String {
  switch facet {
  case .gateway: return row.hostId
  case .adapter: return row.adapter
  case .state: return unitState(row).rawValue
  case .project: return projectKey(row)
  }
}

private func unitState(_ row: SessionRow) -> SessionState {
  row.teamState ?? row.state
}

private func facetLabel(_ row: SessionRow, _ facet: Facet, multiGateway: Bool = false) -> String {
  switch facet {
  case .gateway: return row.hostName
  case .adapter: return row.adapter
  case .state: return unitState(row).label
  case .project:
    return multiGateway ? "\(row.hostName) \(projectLabel(row.info))" : projectLabel(row.info)
  }
}

/// Comparable rank for a facet: states run worst-first (attention before ended),
/// project groups by gateway then project, the rest alphabetically by label.
private func facetRank(_ row: SessionRow, _ facet: Facet, multiGateway: Bool = false) -> String {
  if facet == .state { return String(SessionState.order.firstIndex(of: unitState(row)) ?? 0) }
  if facet == .project && multiGateway {
    return "\(row.hostName.lowercased())\u{0}\(projectLabel(row.info).lowercased())"
  }
  return facetLabel(row, facet).lowercased()
}

private func recency(_ info: SessionInfo) -> Double {
  info.lastActivityAt ?? info.createdAt
}

/// Most recent first.
private func byRecency(_ a: SessionRow, _ b: SessionRow) -> ComparisonResult {
  let x = recency(a.info)
  let y = recency(b.info)
  if x == y { return .orderedSame }
  return x > y ? .orderedAscending : .orderedDescending
}

private func compare(_ a: SessionRow, _ b: SessionRow, sortBy: SortBy) -> ComparisonResult {
  if sortBy == .recent { return byRecency(a, b) }
  if sortBy == .name {
    // TS localeCompare with sensitivity 'base' - case- and diacritic-insensitive.
    let order = sessionLabel(a.info).compare(
      sessionLabel(b.info), options: [.caseInsensitive, .diacriticInsensitive])
    return order == .orderedSame ? byRecency(a, b) : order
  }
  guard let facet = sortBy.facet else { return byRecency(a, b) }
  let ra = facetRank(a, facet)
  let rb = facetRank(b, facet)
  if ra == rb { return byRecency(a, b) }
  return ra < rb ? .orderedAscending : .orderedDescending
}

/// JS `Array.sort` is stable; Swift's makes no such promise, so ties past the
/// recency tiebreak keep their input order explicitly.
private func stableSorted(_ rows: [SessionRow], sortBy: SortBy) -> [SessionRow] {
  rows.enumerated()
    .sorted { a, b in
      switch compare(a.element, b.element, sortBy: sortBy) {
      case .orderedAscending: return true
      case .orderedDescending: return false
      case .orderedSame: return a.offset < b.offset
      }
    }
    .map(\.element)
}

// `all` is the unfiltered list: a member matched by a filter pulls its lead in from there as a context row.
// `relayHosts` maps a relay gateway name to this client's host id for it (`relayHostsOf`), so a member whose lead
// lives on another configured gateway still draws under that lead. `gatewayCount` defaults to the gateways among
// `rows`; pass the unfiltered count so a filter never renames a project heading.
public func groupRows(
  _ rows: [SessionRow], config: ViewConfig, gatewayCount: Int? = nil, all: [SessionRow]? = nil,
  relayHosts: [String: String] = [:]
) -> [SessionGroup] {
  let units = stableSorted(
    teamUnits(rows, all: all ?? rows, relayHosts: relayHosts), sortBy: config.sortBy)
  let earlier = config.groupBy == .state ? [] : units.filter(isEarlier)
  let sorted = earlier.isEmpty ? units : units.filter { !isEarlier($0) }
  let trailing =
    earlier.isEmpty ? [] : [SessionGroup(key: "earlier", label: "Earlier", rows: earlier, earlier: true)]
  guard let facet = config.groupBy.facet else {
    return (sorted.isEmpty ? [] : [SessionGroup(key: "all", rows: sorted)]) + trailing
  }
  let multiGateway = (gatewayCount ?? Set(rows.map(\.hostId)).count) > 1
  var order: [String] = []
  var built: [String: (label: String, rank: String, rows: [SessionRow])] = [:]
  for row in sorted {
    let key = facetKey(row, facet)
    if built[key] == nil {
      order.append(key)
      built[key] = (
        facetLabel(row, facet, multiGateway: multiGateway),
        facetRank(row, facet, multiGateway: multiGateway), [row]
      )
    } else {
      built[key]?.rows.append(row)
    }
  }
  let groups = order.enumerated()
    .sorted { a, b in
      guard let ra = built[a.element]?.rank, let rb = built[b.element]?.rank else {
        return a.offset < b.offset
      }
      return ra == rb ? a.offset < b.offset : ra < rb
    }
    .compactMap { entry -> SessionGroup? in
      guard let group = built[entry.element] else { return nil }
      return SessionGroup(key: entry.element, label: group.label, rows: group.rows)
    }
  return groups + trailing
}

// MARK: - Teams

public func teamKey(_ row: SessionRow) -> String? {
  row.info.agent.map { "\(row.hostId):\($0.id)" }
}

public func relayHostsOf(_ relays: [String: GatewayRelayMeta?]) -> [String: String] {
  var hosts: [String: String] = [:]
  for (hostId, relay) in relays {
    if let relay { hosts[relay.gateway] = hostId }
  }
  return hosts
}

private func leadKeyOf(_ row: SessionRow, relayHosts: [String: String]) -> String? {
  guard let agent = row.info.agent, let lead = agent.lead else { return nil }
  guard let gateway = agent.leadGateway else { return "\(row.hostId):\(lead)" }
  guard let host = relayHosts[gateway] else { return nil }
  return "\(host):\(lead.dropFirst(gateway.count + 1))"
}

private func isEarlier(_ row: SessionRow) -> Bool {
  row.info.agent == nil && row.state == .ended
}

// A member whose lead is not in the list at all (its session gone) stays top-level rather than vanish.
private func teamUnits(_ rows: [SessionRow], all: [SessionRow], relayHosts: [String: String])
  -> [SessionRow]
{
  var leads: [String: SessionRow] = [:]
  for row in all {
    if let key = teamKey(row), row.info.agent?.lead == nil { leads[key] = row }
  }
  let shown = Set(rows.map(\.id))
  var members: [String: [SessionRow]] = [:]
  var leadOrder: [String] = []
  var top: [SessionRow] = []
  for row in rows {
    if let lead = leadKeyOf(row, relayHosts: relayHosts), leads[lead] != nil {
      if members[lead] == nil { leadOrder.append(lead) }
      members[lead, default: []].append(row)
    } else {
      top.append(row)
    }
  }
  for lead in leadOrder {
    guard var leadRow = leads[lead], !shown.contains(leadRow.id) else { continue }
    leadRow.context = true
    top.append(leadRow)
  }
  return top.map { row in
    guard let key = teamKey(row), let crew = members[key] else { return row }
    var unit = row
    let ordered = crew.enumerated().sorted { a, b in
      let order = byTeamOrder(a.element, b.element)
      return order == .orderedSame ? a.offset < b.offset : order == .orderedAscending
    }.map(\.element)
    unit.members = ordered
    unit.teamState = teamState([row] + ordered)
    return unit
  }
}

private func byTeamOrder(_ a: SessionRow, _ b: SessionRow) -> ComparisonResult {
  let ao = a.info.agent?.order ?? .greatestFiniteMagnitude
  let bo = b.info.agent?.order ?? .greatestFiniteMagnitude
  if ao != bo { return ao < bo ? .orderedAscending : .orderedDescending }
  if a.info.createdAt != b.info.createdAt {
    return a.info.createdAt < b.info.createdAt ? .orderedAscending : .orderedDescending
  }
  return .orderedSame
}

public func teamState(_ rows: [SessionRow]) -> SessionState {
  var best = SessionState.order.count - 1
  for row in rows {
    best = min(best, SessionState.order.firstIndex(of: row.state) ?? best)
  }
  return SessionState.order[best]
}

public func isTeamExpanded(_ config: ViewConfig, _ row: SessionRow) -> Bool {
  guard let key = teamKey(row) else { return false }
  return config.expandedTeams.contains(key)
}

public func toggleTeamExpanded(_ config: ViewConfig, _ row: SessionRow) -> ViewConfig {
  guard let key = teamKey(row) else { return config }
  var next = config
  if next.expandedTeams.contains(key) {
    next.expandedTeams.removeAll { $0 == key }
  } else {
    next.expandedTeams.append(key)
  }
  return next
}

/// Mirror of `TEAM_LINGER_MS`.
public let teamLingerMs: Double = 30_000

public struct TeamView: Sendable, Equatable {
  public var expanded: Bool
  public var shown: [SessionRow]
  public var tray: [SessionRow]

  public init(expanded: Bool, shown: [SessionRow], tray: [SessionRow]) {
    self.expanded = expanded
    self.shown = shown
    self.tray = tray
  }
}

/// Mirror of protocol's `teamView`: Auto draws a member that is busy, selected,
/// unread, or idle for under `teamLingerMs`; the rest sit in the lead's tray.
public func teamView(_ lead: SessionRow, config: ViewConfig, selected: String?, now: Double)
  -> TeamView
{
  let members = lead.members ?? []
  let expanded = isTeamExpanded(config, lead)
  if expanded || hasFacetFilter(config) {
    return TeamView(expanded: expanded, shown: members, tray: [])
  }
  var shown: [SessionRow] = []
  var tray: [SessionRow] = []
  for member in members {
    let lingering = member.info.lastActivityAt.map { now - $0 < teamLingerMs } ?? false
    let auto =
      member.state == .working || member.state == .attention || member.unseen > 0
      || member.id == selected || lingering
    if auto { shown.append(member) } else { tray.append(member) }
  }
  return TeamView(expanded: expanded, shown: shown, tray: tray)
}

/// Mirror of protocol's `teamLingerEnds`.
public func teamLingerEnds(_ view: TeamView, now: Double) -> Double? {
  view.shown.compactMap { member -> Double? in
    guard let at = member.info.lastActivityAt, now - at < teamLingerMs else { return nil }
    return at + teamLingerMs
  }.min()
}

public struct TeamSummary: Sendable, Equatable {
  public var members: Int
  public var working: Int
  public var attention: Int
  public var unseen: Int

  public init(members: Int, working: Int, attention: Int, unseen: Int) {
    self.members = members
    self.working = working
    self.attention = attention
    self.unseen = unseen
  }
}

public func teamSummary(_ lead: SessionRow) -> TeamSummary {
  let members = lead.members ?? []
  return TeamSummary(
    members: members.count,
    working: members.filter { $0.state == .working }.count,
    attention: members.filter { $0.state == .attention }.count,
    unseen: members.reduce(0) { $0 + $1.unseen })
}

// Top-level agents on the row's gateway that could take it as a member: leads first, then solo agents.
public func teamLeads(_ rows: [SessionRow], for row: SessionRow) -> [SessionRow] {
  let agent = row.info.agent
  guard agent?.lead == nil, agent?.isLead != true else { return [] }
  let open = rows.filter { other in
    guard let candidate = other.info.agent else { return false }
    return other.hostId == row.hostId && other.info.id != row.info.id && candidate.lead == nil
      && candidate.id != agent?.id
  }
  return open.filter { $0.info.agent?.isLead == true } + open.filter { $0.info.agent?.isLead != true }
}

public func teamMembers(_ row: SessionRow, in rows: [SessionRow]) -> [SessionRow] {
  guard let id = row.info.agent?.id else { return [] }
  return rows.filter { $0.hostId == row.hostId && $0.info.agent?.lead == id }
}

// MARK: - Subset summary

/// What the list is hiding, and why - the one "you are seeing a subset" signal:
/// absent when nothing is hidden, and otherwise naming every cause, so the line
/// is never "12 of 30" with no way to guess why. Search is a cause like any
/// other: its box is visible, but the *consequence* of it - rows gone from the
/// list - is the thing being reported, and leaving it out would make the
/// arithmetic wrong.
public struct SubsetSummary: Sendable, Equatable {
  public var shown: Int
  public var total: Int
  public var causes: [String]

  public init(shown: Int, total: Int, causes: [String]) {
    self.shown = shown
    self.total = total
    self.causes = causes
  }
}

public func subsetSummary(
  config: ViewConfig, scope: WorkspaceScope?, shown: Int, total: Int
) -> SubsetSummary? {
  if shown >= total { return nil }
  var causes: [String] = []
  if let scope, scopeActive(config, scope: scope) { causes.append(scope.label) }
  // The facets collapse to a count: naming three of them would wrap the line,
  // and the filter control beside it is where their detail already lives.
  let facets =
    (config.gateways.isEmpty ? 0 : 1) + (config.adapters.isEmpty ? 0 : 1)
    + (config.states.isEmpty ? 0 : 1) + (config.projects.isEmpty ? 0 : 1)
  if facets > 0 { causes.append("\(facets) filter\(facets == 1 ? "" : "s")") }
  if !config.search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    causes.append("search")
  }
  return SubsetSummary(shown: shown, total: total, causes: causes)
}

/// Is anything OTHER than the workspace scope narrowing the list?
///
/// The distinction an empty list turns on: "this project has no sessions" wants
/// a different sentence, and a different way out, from "your filters match
/// none". Scope is excluded because it is on by default - it is the state, not a
/// choice someone made.
public func hasFacetFilter(_ config: ViewConfig) -> Bool {
  !config.search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    || !config.gateways.isEmpty || !config.adapters.isEmpty || !config.states.isEmpty
    || !config.projects.isEmpty
}

/// "Show me everything": every filter off, including scope. The group/sort
/// choices are a layout preference and survive.
public func clearFilters(_ config: ViewConfig) -> ViewConfig {
  var next = ViewConfig.default
  next.scoped = false
  next.groupBy = config.groupBy
  next.sortBy = config.sortBy
  next.subagents = config.subagents
  next.shells = config.shells
  next.tasks = config.tasks
  next.expandedTeams = config.expandedTeams
  next.earlierOpen = config.earlierOpen
  return next
}

/// How many facets are narrowing the list - the filter button's count. Search
/// and scope are not facets. Mirror of protocol's `facetFilterCount`.
public func facetFilterCount(_ config: ViewConfig) -> Int {
  [config.gateways.isEmpty, config.adapters.isEmpty, config.states.isEmpty, config.projects.isEmpty]
    .filter { !$0 }.count
}

/// Whether any of the three card displays is off its default - the other half
/// of what fills the filter glyph. Mirror of protocol's `displayCustomized`.
public func displayCustomized(_ config: ViewConfig) -> Bool {
  let d = ViewConfig.default
  return config.subagents != d.subagents || config.shells != d.shells || config.tasks != d.tasks
}
