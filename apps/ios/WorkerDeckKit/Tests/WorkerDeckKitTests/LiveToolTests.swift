import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Live tool output")
struct LiveToolTests {
  private let started: Double = 1_722_300_000_000

  // MARK: - Wire

  @Test func backgroundTasksCapabilityIsClaudeOnlyAndAbsentReadsFalse() throws {
    #expect(ProfileEngine.claude.defaultCapabilities.backgroundTasks)
    #expect(!ProfileEngine.codex.defaultCapabilities.backgroundTasks)
    #expect(!ProfileEngine.provider.defaultCapabilities.backgroundTasks)
    let json = #"""
      {"interactiveApprovals":true,"permissionModes":["default"],"defaultPermissionMode":"default",
       "resume":true,"resumeBackfill":true,"listSessions":true,"contextUsage":true,"rateLimits":true,
       "mcpStatus":true,"mcpServerActions":true,"sessionMcpServers":true,"slashCommands":true,
       "skillsList":false,"settingSources":true,"budgets":true,"attachments":["image"],"vfs":false,
       "streaming":"token"
      """#
    let absent = try JSONDecoder().decode(EngineCapabilities.self, from: Data((json + "}").utf8))
    #expect(!absent.backgroundTasks)
    let present = try JSONDecoder().decode(
      EngineCapabilities.self, from: Data((json + #","backgroundTasks":true}"#).utf8))
    #expect(present.backgroundTasks)
  }

  // MARK: - Reducer

  // MARK: - Rules

  @Test func elapsedWaitsFiveSecondsAndFloorsToWholeSeconds() {
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 4999) == nil)
    #expect(LiveTool.elapsedLabel(startedAt: nil, now: started + 60_000) == nil)
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 5900) == "5.0s")
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 375_400) == "6m 15s")
  }

  @Test func theElapsedLabelStartsAfterTheTextAndItsWideCells() {
    let line = TermLine(text: "● 漢字  ", elapsedSince: started)
    #expect(LiveTool.elapsedColumn(line) == 6)
    #expect(LiveTool.elapsedText(line, now: started + 7000) == " · 7.0s")
    #expect(LiveTool.elapsedText(TermLine(text: "", elapsedSince: started), now: started + 7000) == "7.0s")
    #expect(LiveTool.elapsedText(line, now: started + 1000) == nil)
  }
}
