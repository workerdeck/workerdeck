import Foundation
import Testing

@testable import WorkerDeckKit

// Port of the "agent teams in the list" block of `packages/react/test/session-list.test.ts`.
@Suite("AgentTeams")
struct AgentTeamsTests {
  private func info(
    id: String, status: SessionStatus = .idle, pendingPermissionCount: Int = 0,
    createdAt: Double = 1_000, lastActivityAt: Double? = 1_000, agent: AgentRef? = nil
  ) -> SessionInfo {
    SessionInfo(
      id: id, status: status, cwd: "/work/alpha", createdAt: createdAt, lastSeq: 0,
      pendingPermissionCount: pendingPermissionCount, lastActivityAt: lastActivityAt, agent: agent)
  }

  private func row(_ info: SessionInfo, hostId: String = "mac", unseen: Int = 0) -> SessionRow {
    SessionRow(
      hostId: hostId, hostName: hostId, local: true, adapter: "claude", state: sessionState(info),
      info: info, unseen: unseen)
  }

  private var lead: SessionRow {
    row(
      info(
        id: "s-lead", lastActivityAt: 10,
        agent: AgentRef(id: "A", name: "Atlas", avatar: "/a", leads: true)))
  }
  private var pip: SessionRow {
    row(
      info(
        id: "s-pip", pendingPermissionCount: 1,
        agent: AgentRef(id: "P", name: "Pip", avatar: "/p", lead: "A", team: "Atlas", order: 1)))
  }
  private var juno: SessionRow {
    row(
      info(
        id: "s-juno", status: .running,
        agent: AgentRef(id: "J", name: "Juno", avatar: "/j", lead: "A", team: "Atlas", order: 0)))
  }
  private var solo: SessionRow {
    row(info(id: "s-solo", lastActivityAt: 5, agent: AgentRef(id: "M", name: "Marlow", avatar: "/m")))
  }
  private var oneOff: SessionRow { row(info(id: "s-old", status: .closed)) }
  private var all: [SessionRow] { [lead, pip, juno, solo, oneOff] }

  private func config(_ groupBy: GroupBy, states: [SessionState] = []) -> ViewConfig {
    ViewConfig(states: states, groupBy: groupBy)
  }

  @Test func drawsMembersUnderTheirLeadInTeamOrderNeverTopLevel() {
    let groups = groupRows(all, config: config(.none))
    #expect(groups.first?.rows.map(\.info.id) == ["s-lead", "s-solo"])
    #expect(groups.first?.rows.first?.members?.map(\.info.id) == ["s-juno", "s-pip"])
  }

  @Test func placesATeamByItsMostUrgentState() {
    let groups = groupRows(all, config: config(.state))
    #expect(groups.first?.key == "attention")
    #expect(groups.first?.rows.map(\.info.id) == ["s-lead"])
    #expect(groups.first?.rows.first?.teamState == .attention)
  }

  @Test func keepsTheLeadAsAContextRowWhenAFilterMatchesOnlyAMember() {
    let working = config(.none, states: [.working])
    let groups = groupRows(filterRows(all, config: working), config: working, all: all)
    #expect(groups.first?.rows.count == 1)
    #expect(groups.first?.rows.first?.context == true)
    #expect(groups.first?.rows.first?.info.id == "s-lead")
    #expect(groups.first?.rows.first?.members?.map(\.info.id) == ["s-juno"])
  }

  @Test func leavesAMemberTopLevelWhenItsLeadIsNotInTheListAtAll() {
    let groups = groupRows([pip, solo], config: config(.none))
    #expect(groups.first?.rows.map(\.info.id).sorted() == ["s-pip", "s-solo"])
  }

  @Test func drawsAMemberOnAnotherGatewayUnderItsLeadWhenThatGatewayIsConfigured() {
    let remote = row(
      info(
        id: "s-win",
        agent: AgentRef(
          id: "W", name: "MagWin", avatar: "/w", lead: "sw-mac:A", leadGateway: "sw-mac",
          team: "Atlas")), hostId: "win")
    let rows = [lead, remote]
    let relayHosts = relayHostsOf([
      "mac": GatewayRelayMeta(gateway: "sw-mac", online: true, features: ["teams"]), "win": nil,
    ])
    let joined = groupRows(rows, config: config(.none), relayHosts: relayHosts)
    #expect(joined.first?.rows.map(\.info.id) == ["s-lead"])
    #expect(joined.first?.rows.first?.members?.map(\.id) == ["win:s-win"])
    let apart = groupRows(rows, config: config(.none))
    #expect(apart.first?.rows.map(\.info.id).sorted() == ["s-lead", "s-win"])
  }

  @Test func foldsEndedOneOffSessionsIntoATrailingEarlierGroupExceptUnderStateGrouping() {
    let groups = groupRows(all, config: config(.project))
    #expect(groups.last?.key == "earlier")
    #expect(groups.last?.earlier == true)
    #expect(groups.last?.rows.map(\.info.id) == ["s-old"])
    #expect(!groupRows(all, config: config(.state)).contains { $0.earlier })
  }

  @Test func togglesCollapsePerTeamKeyAndSumsTheMembersForTheFoldedSummary() throws {
    let unit = try #require(groupRows(all, config: config(.none)).first?.rows.first)
    let folded = toggleTeamCollapsed(.default, unit)
    #expect(folded.collapsedTeams == ["mac:A"])
    #expect(isTeamCollapsed(folded, unit))
    #expect(!isTeamCollapsed(toggleTeamCollapsed(folded, unit), unit))
    #expect(teamSummary(unit) == TeamSummary(members: 2, working: 1, attention: 1, unseen: 0))
  }

  @Test func matchesSearchOnTheAgentName() {
    let found = filterRows(all, config: ViewConfig(search: "marl", scoped: false))
    #expect(found.map(\.info.id) == ["s-solo"])
  }

  @Test func offersLeadsFirstThenSoloAgentsOnTheSameGatewayOnly() {
    let elsewhere = row(
      info(id: "s-far", agent: AgentRef(id: "F", name: "Far")), hostId: "win")
    let plain = row(info(id: "s-plain"))
    #expect(teamLeads(all + [elsewhere], for: plain).map(\.info.id) == ["s-lead", "s-solo"])
    #expect(teamLeads(all, for: solo).map(\.info.id) == ["s-lead"])
    #expect(teamLeads(all, for: pip).isEmpty)
    #expect(teamLeads(all, for: lead).isEmpty)
    #expect(teamMembers(lead, in: all).map(\.info.id).sorted() == ["s-juno", "s-pip"])
  }

  @Test func keepsFoldStateAcrossClearFiltersAndDecodesAnOlderConfig() throws {
    let cleared = clearFilters(ViewConfig(search: "x", collapsedTeams: ["mac:A"], earlierOpen: true))
    #expect(cleared.collapsedTeams == ["mac:A"] && cleared.earlierOpen)
    let old = try JSONDecoder().decode(ViewConfig.self, from: Data(#"{"groupBy":"none"}"#.utf8))
    #expect(old.collapsedTeams.isEmpty && !old.earlierOpen)
  }

  @Test func decodesAgentStatusLabelAndOwnerOnASessionAndToleratesAStrayField() throws {
    let json = #"""
      {"id":"s1","status":"idle","cwd":"/w","createdAt":1,"lastSeq":0,"pendingPermissionCount":0,
       "owner":"tobias","statusLabel":{"text":"reviewing","emoji":"🔍","setAt":5},
       "agent":{"id":"A","name":"Atlas","avatar":"/v1/agents/A/avatar.png","leads":true,"order":"x",
                "conversation":3}}
      """#
    let info = try JSONDecoder().decode(SessionInfo.self, from: Data(json.utf8))
    #expect(info.agent?.name == "Atlas" && info.agent?.isLead == true && info.agent?.order == nil)
    #expect(info.agent?.conversation == 3)
    #expect(teamRole(info.agent) == .lead)
    #expect(info.owner == "tobias")
    #expect(statusLine(info.statusLabel) == "🔍 reviewing")
  }

  @Test func encodesTheThreeStatesOfALeadEdit() throws {
    func body(_ request: UpdateAgentRequest) throws -> String {
      let encoder = JSONEncoder()
      encoder.outputFormatting = .sortedKeys
      return String(decoding: try encoder.encode(request), as: UTF8.self)
    }
    #expect(try body(UpdateAgentRequest(lead: .join("A"))) == #"{"lead":"A"}"#)
    #expect(try body(UpdateAgentRequest(lead: .leave)) == #"{"lead":null}"#)
    #expect(try body(UpdateAgentRequest(name: "Pip")) == #"{"name":"Pip"}"#)
  }

  @Test func readsFrameDurationsLeniently() {
    #expect(frameDurations("120, 80,x,0,-1") == [120, 80])
    #expect(frameDurations(nil) == nil)
    #expect(frameDurations("") == nil)
  }
}
