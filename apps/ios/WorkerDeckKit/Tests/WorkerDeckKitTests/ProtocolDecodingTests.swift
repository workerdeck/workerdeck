import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Protocol decoding")
struct ProtocolDecodingTests {
  @Test func decodesASessionCarryingAChecklist() throws {
    let json = #"""
      {"id":"s1","status":"idle","cwd":"/work","createdAt":1,"lastSeq":2,
       "pendingPermissionCount":0,
       "checklist":[{"text":"ship","status":"pending"}]}
      """#
    let info = try JSONDecoder().decode(SessionInfo.self, from: Data(json.utf8))
    #expect(info.checklist == [ChecklistItem(text: "ship", status: .pending)])
  }

  /// A gateway that predates the field says nothing, which must read as "no
  /// checklist" rather than as a row that failed to decode.
  @Test func anOlderRecordWithoutAChecklistStillDecodes() throws {
    let json = #"""
      {"id":"s1","status":"idle","cwd":"/work","createdAt":1,"lastSeq":2,
       "pendingPermissionCount":0}
      """#
    let info = try JSONDecoder().decode(SessionInfo.self, from: Data(json.utf8))
    #expect(info.checklist == nil)
  }

  /// `clearContext` and `hostCwd` are optional on the wire: absent reads as
  /// "no clear verb" and nil, not as a failed decode of the whole record.
  @Test func aRecordWithoutTheOptionalCapabilitiesDecodes() throws {
    let json = #"""
      {"interactiveApprovals":true,"permissionModes":["default"],
       "defaultPermissionMode":"default","resume":true,"resumeBackfill":true,
       "listSessions":true,"contextUsage":true,"rateLimits":true,"mcpStatus":true,
       "mcpServerActions":false,"sessionMcpServers":true,"slashCommands":true,
       "skillsList":false,"settingSources":true,"budgets":true,"attachments":["image"],
       "vfs":false,"streaming":"token"}
      """#
    let record = try JSONDecoder().decode(EngineCapabilities.self, from: Data(json.utf8))
    #expect(record.clearContext == false)
    #expect(record.hostCwd == nil)
    #expect(record.engineSleep == false)
    #expect(record.slashCommands == true)
  }

  // MARK: - Project identity

  private func decodeSession(project json: String) throws -> SessionInfo {
    try JSONDecoder().decode(
      SessionInfo.self,
      from: Data(
        #"""
        {"id":"s1","status":"idle","cwd":"/work/deck/packages/ui","createdAt":1722300000000,
         "lastSeq":4,"pendingPermissionCount":0,"project":\#(json)}
        """#.utf8))
  }

  @Test func decodesAGlyphProjectIcon() throws {
    let session = try decodeSession(
      project: #"{"name":"WorkerDeck","root":"/work/deck","icon":{"type":"glyph","name":"layers"}}"#)
    #expect(session.project == ProjectInfo(
      name: "WorkerDeck", root: "/work/deck", icon: .glyph(name: "layers")))
  }

  @Test func decodesAnImageProjectIconAsAnAddressNeverBytes() throws {
    // `hash` is the cross-session cache key; the bytes are a
    // `projectIcon(sessionId:)` fetch away.
    let png = try decodeSession(
      project:
        #"{"name":"WorkerDeck","root":"/work/deck","icon":{"type":"image","mediaType":"image/png","hash":"abc123"}}"#)
    #expect(png.project?.icon == .image(mediaType: .png, hash: "abc123"))
    let svg = try decodeSession(
      project:
        #"{"name":"WorkerDeck","root":"/work/deck","icon":{"type":"image","mediaType":"image/svg+xml","hash":"def456"}}"#)
    #expect(svg.project?.icon == .image(mediaType: .svg, hash: "def456"))
  }

  /// A newer gateway's icon vocabulary - a third arm, a new media type - must
  /// degrade to "no icon", never fail the decode of the whole `SessionInfo`: a
  /// display declaration must not cost a session its row.
  @Test func anUnknownIconShapeDegradesToNoIconNotAFailedRow() throws {
    let unknownType = try decodeSession(
      project: #"{"name":"WorkerDeck","root":"/work/deck","icon":{"type":"sprite","name":"x"}}"#)
    #expect(unknownType.project == ProjectInfo(name: "WorkerDeck", root: "/work/deck"))
    let unknownMedia = try decodeSession(
      project:
        #"{"name":"WorkerDeck","root":"/work/deck","icon":{"type":"image","mediaType":"image/webp","hash":"h"}}"#)
    #expect(unknownMedia.project?.name == "WorkerDeck")
    #expect(unknownMedia.project?.icon == nil)
  }

  /// No `.workerdeck.json` in the cwd's ancestry: absent means "render the
  /// folder basename".
  @Test func aSessionWithoutAProjectStillDecodes() throws {
    let session = try JSONDecoder().decode(
      SessionInfo.self,
      from: Data(
        #"{"id":"s1","status":"idle","cwd":"/work/alpha","createdAt":1722300000000,"lastSeq":4,"pendingPermissionCount":0}"#
          .utf8))
    #expect(session.project == nil)
  }

  /// The CLI names its rows with aliases and reports a resolved wire id; the chip
  /// is only useful if those meet.
  @Test func matchesTheModelASessionReports() throws {
    let opus = ModelOption(
      value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)")
    #expect(opus.matches("opus[1m]"))
    #expect(opus.matches("claude-opus-5[1m]"))
    #expect(opus.matches("claude-opus-5"))
    #expect(!opus.matches("claude-sonnet-5"))

    // Same family, older version: it must NOT also read as checked, which is the
    // whole reason a declared `resolvedModel` outranks the family heuristic.
    let previousOpus = ModelOption(
      value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8")
    #expect(!previousOpus.matches("claude-opus-5[1m]"))
    #expect(previousOpus.matches("claude-opus-4-8"))

    // No `resolvedModel` (a CLI that omits it): the family
    // token still gets the name right.
    let sonnet = ModelOption(value: "sonnet", displayName: "Sonnet")
    #expect(sonnet.matches("claude-sonnet-5[1m]"))
    #expect(!sonnet.matches("claude-haiku-4-5"))
  }

  @Test func decodesEngineAsleepOnSessionInfo() throws {
    let base = #"{"id":"s1","status":"idle","cwd":"/work","createdAt":1,"lastSeq":2,"pendingPermissionCount":0"#
    let asleep = try JSONDecoder().decode(
      SessionInfo.self, from: Data((base + #","engineAsleep":true}"#).utf8))
    #expect(asleep.engineAsleep == true)
    let awake = try JSONDecoder().decode(SessionInfo.self, from: Data((base + "}").utf8))
    #expect(awake.engineAsleep == nil)
  }

  @Test func engineSleepCapabilityMirrorsTheStaticRecords() {
    #expect(ProfileEngine.claude.defaultCapabilities.engineSleep == true)
    #expect(ProfileEngine.codex.defaultCapabilities.engineSleep == true)
    #expect(ProfileEngine.provider.defaultCapabilities.engineSleep == false)
  }

  @Test func decodesEffortOnSessionInfo() throws {
    let base = #"{"id":"s1","status":"idle","cwd":"/work","createdAt":1,"lastSeq":2,"pendingPermissionCount":0"#
    func decode(_ tail: String) throws -> SessionInfo {
      try JSONDecoder().decode(SessionInfo.self, from: Data((base + tail).utf8))
    }
    #expect(try decode(#","effort":"medium"}"#).effort == .level("medium"))
    #expect(try decode(#","effort":null}"#).effort == .unsupported)
    #expect(try decode("}").effort == nil)
    #expect(try decode(#","effort":3}"#).effort == nil)
  }

  @Test func decodesPerModelEffortDefaults() throws {
    let json = #"{"model":"gpt-6","efforts":{"gpt-6":"high"}}"#
    let defaults = try JSONDecoder().decode(ProfileDefaults.self, from: Data(json.utf8))
    #expect(defaults.efforts == ["gpt-6": "high"])
    let bare = try JSONDecoder().decode(ProfileDefaults.self, from: Data("{}".utf8))
    #expect(bare.efforts == nil)
  }


  @Test func encodesCreateSessionRequestOmittingNils() throws {
    let request = CreateSessionRequest(cwd: "/tmp/project", permissionMode: .plan)
    let data = try JSONEncoder().encode(request)
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["cwd"] as? String == "/tmp/project")
    #expect(object["permissionMode"] as? String == "plan")
    #expect(object.keys.contains("resume") == false)
    #expect(object.keys.contains("model") == false)
  }
}
