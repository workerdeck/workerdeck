import Testing

@testable import WorkerDeckKit

/// The sessions-list view model — a port of `packages/react/test/session-list.test.ts`.
/// These are the rules, not one client's preferences: the VS Code sidebar (whose
/// activity-bar badge counts the *same* rows the list shows), the dashboard, and
/// this app derive their list from them.
@Suite("SessionList")
struct SessionListTests {
  private func info(
    id: String = "sess-00000001", status: SessionStatus = .idle, cwd: String = "/work/alpha",
    title: String? = nil, pendingPermissionCount: Int = 0, createdAt: Double = 1_000,
    lastActivityAt: Double? = 1_000
  ) -> SessionInfo {
    SessionInfo(
      id: id, status: status, cwd: cwd, createdAt: createdAt, lastSeq: 0,
      pendingPermissionCount: pendingPermissionCount, title: title,
      lastActivityAt: lastActivityAt)
  }

  private func row(
    hostId: String = "mac", hostName: String = "Mac mini", local: Bool = true,
    adapter: String = "claude", unseen: Int = 0, info: SessionInfo
  ) -> SessionRow {
    SessionRow(
      hostId: hostId, hostName: hostName, local: local, adapter: adapter,
      state: sessionState(info), info: info, unseen: unseen)
  }

  // MARK: - sessionState

  @Test func promotesAPendingApprovalOverTheRawStatus() {
    // The rollup can still say `running` while a request waits — the thing a
    // person filters on is "does this need me", not what the engine calls it.
    #expect(sessionState(info(status: .running, pendingPermissionCount: 1)) == .attention)
    #expect(sessionState(info(status: .awaitingApproval)) == .attention)
  }

  @Test func collapsesTheEngineShapedStatusesIntoFourBuckets() {
    #expect(sessionState(info(status: .starting)) == .working)
    #expect(sessionState(info(status: .running)) == .working)
    #expect(sessionState(info(status: .idle)) == .idle)
    #expect(sessionState(info(status: .parked)) == .idle)
    #expect(sessionState(info(status: .failed)) == .ended)
    #expect(sessionState(info(status: .closed)) == .ended)
  }

  // MARK: - filterRows

  private var searchRows: [SessionRow] {
    [
      row(info: info(id: "a1", cwd: "/work/alpha", title: "Refactor parser")),
      row(
        hostId: "pi", hostName: "Pi", local: false, adapter: "codex",
        info: info(id: "b2", status: .running, cwd: "/srv/beta", title: "Fix flake")),
    ]
  }

  @Test func matchesSearchAcrossTitleCwdGatewayAdapterAndIdPrefix() {
    var config = ViewConfig.default
    config.scoped = false
    func find(_ search: String) -> [String] {
      config.search = search
      return filterRows(searchRows, config: config).map(\.info.id)
    }
    #expect(find("parser") == ["a1"])
    #expect(find("/srv") == ["b2"])
    #expect(find("pi") == ["b2"])
    #expect(find("codex") == ["b2"])
    #expect(find("a1") == ["a1"])
    // An id is matched by prefix only — a hex soup matching mid-string would
    // surface rows nobody was looking for.
    #expect(find("1") == [])
  }

  @Test func treatsAnEmptyFacetAsNoFilterAndFacetsAsAnd() {
    var config = ViewConfig.default
    config.scoped = false
    #expect(filterRows(searchRows, config: config).count == 2)
    config.adapters = ["codex"]
    config.gateways = ["mac"]
    #expect(filterRows(searchRows, config: config).isEmpty)
  }

  // MARK: - scope

  @Test func onlyLetsARealFolderScopeALoopbackGateway() {
    // The whole point: a remote gateway's identical-looking path is another
    // machine's directory, and matching it would show sessions from elsewhere.
    let local = row(info: info(cwd: "/work/alpha"))
    let remote = row(hostId: "pi", local: false, info: info(cwd: "/work/alpha"))
    let scope = WorkspaceScope(label: "alpha", roots: [ScopeRoot(path: "/work/alpha")])
    #expect(inScope(local, scope: scope))
    #expect(!inScope(remote, scope: scope))
  }

  @Test func letsAGatewayTaggedRootScopeExactlyThatGateway() {
    let local = row(info: info(cwd: "/work/alpha"))
    let remote = row(hostId: "pi", local: false, info: info(cwd: "/work/alpha"))
    let scope = WorkspaceScope(
      label: "alpha", roots: [ScopeRoot(hostId: "pi", path: "/work/alpha")])
    #expect(inScope(remote, scope: scope))
    #expect(!inScope(local, scope: scope))
  }

  @Test func doesNotLetAPrefixSwallowASiblingDirectory() {
    let scope = WorkspaceScope(label: "alpha", roots: [ScopeRoot(path: "/work/alpha")])
    #expect(!inScope(row(info: info(cwd: "/work/alpha-2")), scope: scope))
    #expect(inScope(row(info: info(cwd: "/work/alpha/pkg")), scope: scope))
  }

  @Test func toleratesTrailingSeparatorsAndWindowsSeparators() {
    let scope = WorkspaceScope(
      label: "alpha", roots: [ScopeRoot(path: #"C:\work\alpha\"#)])
    #expect(inScope(row(info: info(cwd: #"C:\work\alpha\pkg"#)), scope: scope))
  }

  @Test func isInertNotMerelyEmptyWithNoScopeAtAll() {
    // This is what lets `scoped` default to on: with nothing open it hides
    // nothing, so it is a default rather than a filter someone has to find —
    // and on a phone, where no folder is ever open, it is permanently inert.
    let local = row(info: info(cwd: "/work/alpha"))
    let remote = row(hostId: "pi", local: false, info: info(cwd: "/work/alpha"))
    #expect(!scopeActive(ViewConfig.default, scope: nil))
    #expect(filterRows([local, remote], config: ViewConfig.default, scope: nil).count == 2)
  }

  // MARK: - groupRows

  @Test func ordersGroupsByFacetRankEvenWhenRowsSortByName() {
    // Grouping by state and sorting by name must still lead with "Needs
    // attention" — groups follow the facet's own worst-first order.
    let attention = row(
      info: info(id: "x", status: .awaitingApproval, title: "Zebra", lastActivityAt: 5))
    let idle = row(info: info(id: "y", title: "Apple", lastActivityAt: 9))
    var config = ViewConfig.default
    config.groupBy = .state
    config.sortBy = .name
    let groups = groupRows([idle, attention], config: config)
    #expect(groups.map(\.key) == ["attention", "idle"])
  }

  @Test func fallsBackToRecencyAsTheUniversalTiebreak() {
    let same = [
      row(info: info(id: "old", title: "Same", lastActivityAt: 1)),
      row(info: info(id: "new", title: "Same", lastActivityAt: 2)),
    ]
    var config = ViewConfig.default
    config.groupBy = .none
    config.sortBy = .name
    let groups = groupRows(same, config: config)
    #expect(groups.first?.rows.map(\.info.id) == ["new", "old"])
  }

  @Test func returnsNoGroupsAtAllForAnEmptyList() {
    var config = ViewConfig.default
    config.groupBy = .none
    #expect(groupRows([], config: config).isEmpty)
  }

  // MARK: - subsetSummary

  private var alphaScope: WorkspaceScope {
    WorkspaceScope(label: "alpha", roots: [ScopeRoot(path: "/work/alpha")])
  }

  @Test func isAbsentWhenNothingIsHidden() {
    #expect(subsetSummary(config: ViewConfig.default, scope: alphaScope, shown: 12, total: 12) == nil)
  }

  @Test func namesEveryCauseCountingTheFacetsRatherThanListingThem() {
    var config = ViewConfig.default
    config.search = "parser"
    config.adapters = ["codex"]
    config.states = [.idle]
    let summary = subsetSummary(config: config, scope: alphaScope, shown: 3, total: 30)
    #expect(summary == SubsetSummary(shown: 3, total: 30, causes: ["alpha", "2 filters", "search"]))
  }

  @Test func omitsScopeWhenTheScopeFilterIsOff() {
    var config = ViewConfig.default
    config.scoped = false
    config.search = "x"
    let summary = subsetSummary(config: config, scope: alphaScope, shown: 1, total: 2)
    #expect(summary?.causes == ["search"])
  }

  // MARK: - clearFilters

  @Test func turnsOffEveryFilterIncludingScopeAndKeepsTheLayoutChoices() {
    var config = ViewConfig.default
    config.search = "x"
    config.states = [.idle]
    config.groupBy = .gateway
    config.sortBy = .name
    let next = clearFilters(config)
    #expect(!hasFacetFilter(next))
    #expect(!next.scoped)
    #expect(next.groupBy == .gateway)
    #expect(next.sortBy == .name)
  }

  @Test func doesNotCountScopeAsAFacetFilter() {
    // An empty list under scope alone wants a different sentence ("nothing in
    // this folder") from one under filters ("no matches").
    #expect(!hasFacetFilter(ViewConfig.default))
  }

  // MARK: - labels

  @Test func fallsBackToAnIdPrefixWhenASessionHasNoTitle() {
    #expect(sessionLabel(info(id: "abcdef0123456789")) == "abcdef01")
    #expect(sessionLabel(info(title: "Named")) == "Named")
  }

  @Test func derivesTheAdapterChipsFromTheRowsPresent() {
    let rows = [
      row(info: info()), row(adapter: "codex", info: info()), row(adapter: "codex", info: info()),
    ]
    #expect(adaptersOf(rows) == ["claude", "codex"])
  }
}
