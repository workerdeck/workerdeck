import Foundation

/// The sessions-list view model: how a list of sessions is filtered, grouped and
/// sorted, kept pure and separate from the views so every surface renders one
/// derived list and nothing else decides what is visible.
///
/// A line-by-line port of `packages/protocol/src/session-list.ts` — the
/// semantics are the contract, not the shape of the code. When the rules change
/// there, they change here. More than one party has to agree: the VS Code
/// sidebar (whose activity-bar badge counts the *same* rows the list shows), the
/// dashboard, and this app all derive their list from these rules.
///
/// Sessions are shown across ALL gateways by default; the gateway is a facet
/// like any other, not the frame the list lives in.

// MARK: - State buckets

/// Coarse lifecycle bucket — what a person actually filters on. Raw statuses are
/// too many and too engine-shaped ('starting' vs 'running' is not a decision).
public enum SessionState: String, Codable, Sendable, Hashable, CaseIterable {
  case attention
  case working
  case idle
  case ended

  /// Mirror of `STATE_ORDER` — worst first.
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
  // unreachable — but a stale one must read `ended`, never `working`.
  if info.status == .failed || info.status == .closed { return .ended }
  if info.status == .running || info.status == .starting { return .working }
  // A *background* agent outlives its turn by design: the turn ends, `status`
  // comes to rest at idle, and the agent keeps working. Without this arm the
  // row read Idle while an agent burned tokens — the status alone cannot carry
  // it, because the status is the *turn's*.
  if !runningSubagents(info).isEmpty { return .working }
  return .idle
}

/// The sub-agents a list row draws as live.
///
/// `sessionState` deliberately does **not** grow a `subagents` bucket — a fifth
/// state would split `working` in two for every client that filters by it,
/// including the ones that have not shipped this yet. Instead `working`
/// *counts* them: a synchronous `Task` keeps the turn in flight so the status
/// already says `working`, and a **background** agent is the carve-out the
/// extra arm exists for. That is what makes "sub-agents are an annotation on a
/// working row" true rather than assumed.
public func runningSubagents(_ info: SessionInfo) -> [SubagentInfo] {
  (info.subagents ?? []).filter { $0.status == .running }
}

/// A sub-agent's identity on one line: `Explore · find the auth check`.
///
/// The mirror of protocol's `subagentLabel`, and the reason it is shared: the
/// dashboard, the extension and this app render the same records, and two
/// spellings would be two answers to "which agent is this". Falls back to the
/// bare type, then to a generic word — a row with no label reads as a bug, and
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

// MARK: - View config

/// The facets a session can be grouped or sorted by.
public enum Facet: String, Codable, Sendable, Hashable {
  case gateway
  case adapter
  case state
}

/// TS `GroupBy` is `'none' | Facet`; the extra case folds in here.
public enum GroupBy: String, Codable, Sendable, Hashable, CaseIterable {
  case none, gateway, adapter, state

  public var facet: Facet? { Facet(rawValue: rawValue) }
}

/// TS `SortBy` is `'recent' | 'name' | Facet`.
public enum SortBy: String, Codable, Sendable, Hashable, CaseIterable {
  case recent, name, gateway, adapter, state

  public var facet: Facet? { Facet(rawValue: rawValue) }
}

public struct ViewConfig: Codable, Sendable, Equatable, Hashable {
  public var search: String
  /// Empty = no filter. Ids, not names: names are editable.
  public var gateways: [String]
  public var adapters: [String]
  public var states: [SessionState]
  /// Show only sessions inside the host's own folders. Inert where there is no
  /// such notion (no folder open — which on a phone is always), which is why it
  /// can default on.
  public var scoped: Bool
  public var groupBy: GroupBy
  public var sortBy: SortBy

  public init(
    search: String = "", gateways: [String] = [], adapters: [String] = [],
    states: [SessionState] = [], scoped: Bool = true, groupBy: GroupBy = .state,
    sortBy: SortBy = .recent
  ) {
    self.search = search
    self.gateways = gateways
    self.adapters = adapters
    self.states = states
    self.scoped = scoped
    self.groupBy = groupBy
    self.sortBy = sortBy
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
    scoped = try c.decodeIfPresent(Bool.self, forKey: .scoped) ?? true
    groupBy =
      (try c.decodeIfPresent(String.self, forKey: .groupBy)).flatMap { GroupBy(rawValue: $0) }
      ?? .state
    sortBy =
      (try c.decodeIfPresent(String.self, forKey: .sortBy)).flatMap { SortBy(rawValue: $0) }
      ?? .recent
  }

  private enum CodingKeys: String, CodingKey {
    case search, gateways, adapters, states, scoped, groupBy, sortBy
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

/// The host's own folders — the sessions list's intrinsic scope. A phone has no
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
  /// Its gateway is loopback — its cwds are paths on this machine.
  public var local: Bool
  public var adapter: String
  public var state: SessionState
  public var info: SessionInfo
  /// Transcript rows since this session was last on screen. 0 = nothing new (or
  /// never visited, which is not the same as unread).
  public var unseen: Int

  /// Session ids are unique per gateway, not globally.
  public var id: String { "\(hostId):\(info.id)" }

  public init(
    hostId: String, hostName: String, local: Bool, adapter: String, state: SessionState,
    info: SessionInfo, unseen: Int
  ) {
    self.hostId = hostId
    self.hostName = hostName
    self.local = local
    self.adapter = adapter
    self.state = state
    self.info = info
    self.unseen = unseen
  }
}

public struct SessionGroup: Sendable, Equatable, Identifiable {
  public var key: String
  public var label: String?
  public var rows: [SessionRow]

  public var id: String { key }

  public init(key: String, label: String? = nil, rows: [SessionRow]) {
    self.key = key
    self.label = label
    self.rows = rows
  }
}

/// The adapters actually present, for the filter chips — derived rather than
/// enumerated, so a new engine needs no change here.
public func adaptersOf(_ rows: [SessionRow]) -> [String] {
  Array(Set(rows.map(\.adapter))).sorted()
}

public func sessionLabel(_ info: SessionInfo) -> String {
  info.title ?? String(info.id.prefix(8))
}

private func matchesSearch(_ row: SessionRow, needle: String) -> Bool {
  if needle.isEmpty { return true }
  return sessionLabel(row.info).lowercased().contains(needle)
    || row.info.cwd.lowercased().contains(needle)
    || row.hostName.lowercased().contains(needle)
    || row.adapter.lowercased().contains(needle)
    // An id is matched by prefix only — a hex soup matching mid-string would
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

/// Whether the scope filter is actually hiding anything — it is inert with no
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
      && (scoping.map { inScope(row, scope: $0) } ?? true)
      && matchesSearch(row, needle: needle)
  }
}

// MARK: - Sorting and grouping

private func facetKey(_ row: SessionRow, _ facet: Facet) -> String {
  switch facet {
  case .gateway: return row.hostId
  case .adapter: return row.adapter
  case .state: return row.state.rawValue
  }
}

private func facetLabel(_ row: SessionRow, _ facet: Facet) -> String {
  switch facet {
  case .gateway: return row.hostName
  case .adapter: return row.adapter
  case .state: return row.state.label
  }
}

/// Comparable rank for a facet: states run worst-first (attention before ended),
/// the rest alphabetically by their visible label.
private func facetRank(_ row: SessionRow, _ facet: Facet) -> String {
  if facet == .state { return String(SessionState.order.firstIndex(of: row.state) ?? 0) }
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
    // TS localeCompare with sensitivity 'base' — case- and diacritic-insensitive.
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

/// The list as rendered: filtered, grouped, and sorted within each group. Groups
/// themselves come out in the sort's own order — grouping by state and sorting
/// by name should still put "Needs attention" first, so groups are ordered by
/// their facet rank, never by the row sort.
public func groupRows(_ rows: [SessionRow], config: ViewConfig) -> [SessionGroup] {
  let sorted = stableSorted(rows, sortBy: config.sortBy)
  guard let facet = config.groupBy.facet else {
    return sorted.isEmpty ? [] : [SessionGroup(key: "all", rows: sorted)]
  }
  var order: [String] = []
  var built: [String: (label: String, rank: String, rows: [SessionRow])] = [:]
  for row in sorted {
    let key = facetKey(row, facet)
    if built[key] == nil {
      order.append(key)
      built[key] = (facetLabel(row, facet), facetRank(row, facet), [row])
    } else {
      built[key]?.rows.append(row)
    }
  }
  return order.enumerated()
    .sorted { a, b in
      guard let ra = built[a.element]?.rank, let rb = built[b.element]?.rank else {
        return a.offset < b.offset
      }
      return ra == rb ? a.offset < b.offset : ra < rb
    }
    .compactMap { entry in
      guard let group = built[entry.element] else { return nil }
      return SessionGroup(key: entry.element, label: group.label, rows: group.rows)
    }
}

// MARK: - Subset summary

/// What the list is hiding, and why — the one "you are seeing a subset" signal:
/// absent when nothing is hidden, and otherwise naming every cause, so the line
/// is never "12 of 30" with no way to guess why. Search is a cause like any
/// other: its box is visible, but the *consequence* of it — rows gone from the
/// list — is the thing being reported, and leaving it out would make the
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
    + (config.states.isEmpty ? 0 : 1)
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
/// none". Scope is excluded because it is on by default — it is the state, not a
/// choice someone made.
public func hasFacetFilter(_ config: ViewConfig) -> Bool {
  !config.search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    || !config.gateways.isEmpty || !config.adapters.isEmpty || !config.states.isEmpty
}

/// "Show me everything": every filter off, including scope. The group/sort
/// choices are a layout preference and survive.
public func clearFilters(_ config: ViewConfig) -> ViewConfig {
  var next = ViewConfig.default
  next.scoped = false
  next.groupBy = config.groupBy
  next.sortBy = config.sortBy
  return next
}
