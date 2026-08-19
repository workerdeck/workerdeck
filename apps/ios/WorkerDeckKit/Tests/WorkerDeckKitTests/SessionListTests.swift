import Foundation
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
    lastActivityAt: Double? = 1_000, subagents: [SubagentInfo]? = nil,
    project: ProjectInfo? = nil
  ) -> SessionInfo {
    SessionInfo(
      id: id, status: status, cwd: cwd, createdAt: createdAt, lastSeq: 0,
      pendingPermissionCount: pendingPermissionCount, title: title,
      lastActivityAt: lastActivityAt, subagents: subagents, project: project)
  }

  private func agent(_ status: SubagentStatus, id: String = "toolu_1") -> SubagentInfo {
    SubagentInfo(
      toolUseId: id, agentType: "Explore", description: "find the auth check", status: status,
      startedAt: 1_000, toolCount: 3)
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

  @Test func countsARunningSubagentAsWorkingThoughTheTurnHasEnded() {
    // The bug this arm exists for. A *background* agent outlives its turn by
    // design: the turn ends, the status comes to rest at idle, and the record
    // stays `running` because the gateway's turn-end sweep deliberately spares
    // it. Read off the status alone the row said Idle while an agent worked.
    #expect(sessionState(info(status: .idle, subagents: [agent(.running)])) == .working)
  }

  @Test func settledSubagentsLeaveAnIdleSessionIdle() {
    #expect(sessionState(info(status: .idle, subagents: [agent(.done), agent(.failed, id: "t2")])) == .idle)
    #expect(sessionState(info(status: .idle, subagents: [])) == .idle)
  }

  @Test func aTerminalStatusOutranksAStaleRunningRecord() {
    // Should be unreachable — `session_closed` settles every record, the process
    // hosting them being gone — but a stale one must never read `working`.
    #expect(sessionState(info(status: .closed, subagents: [agent(.running)])) == .ended)
    #expect(sessionState(info(status: .failed, subagents: [agent(.running)])) == .ended)
  }

  @Test func aPendingApprovalStillOutranksARunningSubagent() {
    #expect(
      sessionState(info(status: .idle, pendingPermissionCount: 1, subagents: [agent(.running)]))
        == .attention)
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

  // MARK: - Project facet

  private var deckProject: ProjectInfo { ProjectInfo(name: "WorkerDeck", root: "/work/deck") }
  private var declaredUi: SessionRow {
    row(info: info(id: "p1", cwd: "/work/deck/packages/ui", project: deckProject))
  }
  private var declaredWeb: SessionRow {
    row(info: info(id: "p2", cwd: "/work/deck/packages/web", project: deckProject))
  }
  private var undeclared: SessionRow { row(info: info(id: "u1", cwd: "/work/alpha")) }
  /// The identical root on another gateway — another machine's directory
  /// wearing the same word.
  private var remoteTwin: SessionRow {
    row(
      hostId: "pi", hostName: "Pi", local: false,
      info: info(id: "r1", cwd: "/work/deck/packages/ui", project: deckProject))
  }
  /// A filesystem-less engine: no cwd, no project, no folder to name.
  private var nowhere: SessionRow { row(info: info(id: "n1", cwd: "")) }

  @Test func keysByRootPerGatewayANameIsNotAKeyAndARemoteTwinIsNotThisProject() {
    // Two cwds inside one project share the key; the identical root on another
    // gateway is another machine's directory (the ScopeRoot argument).
    #expect(projectKey(declaredUi) == projectKey(declaredWeb))
    #expect(projectKey(declaredUi) != projectKey(remoteTwin))
    // Undeclared sessions key by their cwd, so grouping works before anyone
    // has written a .workerdeck.json.
    #expect(projectKey(undeclared) == "mac:/work/alpha")
  }

  @Test func labelsByTheDeclaredNameElseTheCwdBasenameElseNoProject() {
    #expect(projectLabel(declaredUi.info) == "WorkerDeck")
    #expect(projectLabel(undeclared.info) == "alpha")
    #expect(projectLabel(nowhere.info) == "No project")
  }

  @Test func offersOneFilterEntryPerProjectKeyedByRootAndLabelledByName() {
    let options = projectsOf([declaredUi, declaredWeb, undeclared, remoteTwin, nowhere])
    // Two cwds of one project collapse to one entry; the remote twin does not,
    // because it is another machine's directory wearing the same word.
    // Alphabetical by label, case-insensitively, so the picker reads as a list
    // of words rather than of roots.
    #expect(
      options == [
        ProjectOption(key: projectKey(undeclared), label: "alpha"),
        ProjectOption(key: projectKey(nowhere), label: "No project"),
        ProjectOption(key: projectKey(declaredUi), label: "WorkerDeck"),
        ProjectOption(key: projectKey(remoteTwin), label: "WorkerDeck"),
      ])
  }

  @Test func groupsDeclaredAndUndeclaredRowsSideBySideAlphabeticallyByLabel() {
    var config = ViewConfig.default
    config.groupBy = .project
    config.sortBy = .recent
    let groups = groupRows([undeclared, declaredUi, declaredWeb], config: config)
    #expect(groups.map(\.label) == ["alpha", "WorkerDeck"])
    #expect(groups.last?.rows.map(\.info.id) == ["p1", "p2"])
  }

  @Test func filtersByProjectKeyAndAConfigPredatingTheFieldFiltersNothing() throws {
    let rows = [declaredUi, undeclared]
    var config = ViewConfig.default
    config.scoped = false
    config.projects = [projectKey(declaredUi)]
    #expect(filterRows(rows, config: config).map(\.info.id) == ["p1"])
    // A stored ViewConfig restored from before the field existed: absent and
    // empty must mean the same thing. TS deletes the property; the Swift
    // equivalent is a persisted config decoded without the key.
    let legacy = try JSONDecoder().decode(
      ViewConfig.self,
      from: Data(
        #"{"search":"","gateways":[],"adapters":[],"states":[],"scoped":false,"groupBy":"state","sortBy":"recent"}"#
          .utf8))
    #expect(filterRows(rows, config: legacy).count == 2)
    #expect(!hasFacetFilter(legacy))
  }

  @Test func matchesSearchAgainstTheDeclaredProjectName() {
    // The person knows the repo as "WorkerDeck", not by the folder's basename.
    var config = ViewConfig.default
    config.scoped = false
    config.search = "workerdeck"
    #expect(filterRows([declaredUi, undeclared], config: config).map(\.info.id) == ["p1"])
  }

  @Test func countsAProjectFilterIntoTheSubsetLineAndClearFiltersResetsIt() {
    var config = ViewConfig.default
    config.scoped = false
    config.projects = ["mac:/work/deck"]
    #expect(subsetSummary(config: config, scope: nil, shown: 1, total: 2)?.causes == ["1 filter"])
    #expect(hasFacetFilter(config))
    #expect(clearFilters(config).projects == [])
  }
}
