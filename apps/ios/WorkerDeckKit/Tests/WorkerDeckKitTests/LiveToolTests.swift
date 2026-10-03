import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Live tool output")
struct LiveToolTests {
  private let started: Double = 1_722_300_000_000
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)

  private func event(_ seq: Int, ts: Double? = nil, _ body: SessionEventBody) -> SessionEvent {
    SessionEvent(seq: seq, ts: ts ?? started, body: body)
  }

  private func toolUse(_ seq: Int, id: String = "tu1", name: String = "Bash", parent: String? = nil)
    -> SessionEvent
  {
    event(
      seq,
      .assistantMessage(
        AssistantMessageEvent(
          message: ApiMessage(
            role: "assistant",
            content: .blocks([.toolUse(id: id, name: name, input: .object(["command": "make"]))])),
          parentToolUseId: parent, uuid: "a\(seq)")))
  }

  private func toolResult(_ seq: Int, id: String = "tu1") -> SessionEvent {
    event(
      seq,
      .userMessage(
        UserMessageEvent(
          message: ApiMessage(
            role: "user", content: .blocks([.toolResult(ToolResultBlock(toolUseId: id, content: .text("done"), isError: false))])),
          uuid: "u\(seq)")))
  }

  private func output(_ seq: Int, id: String = "tu1", _ tail: String) -> SessionEvent {
    event(seq, .toolOutput(toolUseId: id, tail: tail))
  }

  private func call(_ state: TranscriptState, _ id: String = "tu1") -> ToolCallItem? {
    for item in state.items { if case .toolCall(let call) = item, call.id == id { return call } }
    return nil
  }

  private func running(
    _ id: String = "tu1", name: String = "Bash", parent: String? = nil, ts: Double? = nil,
    tail: String? = nil
  ) -> ToolCallItem {
    ToolCallItem(
      id: id, name: name, input: .object(["command": "make"]), parentToolUseId: parent,
      status: .running, ts: ts, liveTail: tail)
  }

  // MARK: - Wire

  @Test func decodesToolOutput() throws {
    let event = try JSONDecoder().decode(
      SessionEvent.self,
      from: Data(#"{"type":"tool_output","toolUseId":"tu1","tail":"a\nb","seq":3,"ts":1}"#.utf8))
    #expect(event.body == .toolOutput(toolUseId: "tu1", tail: "a\nb"))
  }

  @Test func encodesBackgroundTaskWithAndWithoutAnId() throws {
    let named = try #require(
      try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(SessionCommand.backgroundTask(toolUseId: "tu1")))
        as? [String: Any])
    #expect(named["type"] as? String == "background_task")
    #expect(named["toolUseId"] as? String == "tu1")
    let bare = try #require(
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(SessionCommand.backgroundTask()))
        as? [String: Any])
    #expect(bare.count == 1)
  }

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

  @Test func aToolCallIsStampedWithItsEventTs() {
    let state = [toolUse(1)].reduce(TranscriptState.initial, applyEvent)
    #expect(call(state)?.ts == started)
  }

  @Test func theTailReplacesWholeWhileRunningAndClearsOnTheResult() {
    let live = [toolUse(1), output(2, "one"), output(3, "one\ntwo")]
      .reduce(TranscriptState.initial, applyEvent)
    #expect(call(live)?.liveTail == "one\ntwo")
    let settled = applyEvent(live, toolResult(4))
    #expect(call(settled)?.liveTail == nil)
    #expect(call(settled)?.status == .settled)
  }

  @Test func aTailForASettledOrUnknownCallChangesNothing() {
    let settled = [toolUse(1), toolResult(2)].reduce(TranscriptState.initial, applyEvent)
    let late = applyEvent(settled, output(3, "late"))
    #expect(late.items == settled.items)
    let unknown = applyEvent(settled, output(4, id: "nope", "x"))
    #expect(unknown.items == settled.items)
  }

  // MARK: - Rules

  @Test func elapsedWaitsFiveSecondsAndFloorsToWholeSeconds() {
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 4999) == nil)
    #expect(LiveTool.elapsedLabel(startedAt: nil, now: started + 60_000) == nil)
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 5900) == "5.0s")
    #expect(LiveTool.elapsedLabel(startedAt: started, now: started + 375_400) == "6m 15s")
  }

  @Test func theTailShowsItsLastFiveLinesOnlyWhileBusy() {
    let tail = (1...8).map { "line \($0)" }.joined(separator: "\n")
    #expect(LiveTool.tailLines(running(tail: tail)) == (4...8).map { "line \($0)" })
    var done = running(tail: tail)
    done.status = .settled
    #expect(LiveTool.tailLines(done).isEmpty)
  }

  @Test func aRunTakesItsEarliestRunningStartAndItsLatestTail() {
    var settled = running("a", ts: started - 10_000, tail: "old")
    settled.status = .settled
    let calls = [
      settled, running("b", ts: started + 2000, tail: "b out"), running("c", ts: started),
    ]
    #expect(LiveTool.runStartedAt(calls) == started)
    #expect(LiveTool.runTailLines(calls) == ["b out"])
  }

  @Test func onlyARunningTopLevelShellOrSubagentCanBeBackgrounded() {
    #expect(LiveTool.canBackground(running()))
    #expect(LiveTool.canBackground(running(name: "Task")))
    #expect(LiveTool.canBackground(running(name: "Agent")))
    #expect(!LiveTool.canBackground(running(name: "Read")))
    #expect(!LiveTool.canBackground(running(parent: "task1")))
    var done = running()
    done.status = .settled
    #expect(!LiveTool.canBackground(done))
  }

  @Test func hasBackgroundableStopsAtTheLastPrompt() {
    let call = TranscriptItem.toolCall(running())
    #expect(LiveTool.hasBackgroundable([.user(id: "u", text: "go"), call]))
    #expect(!LiveTool.hasBackgroundable([call, .user(id: "u", text: "next")]))
    #expect(
      LiveTool.hasBackgroundable([call, .user(id: "b", text: "brief", parentToolUseId: "task1")]))
  }

  // MARK: - Terminal

  @Test func aBusyCallReservesItsElapsedLabelAndDrawsItsTail() {
    let rows = TerminalRows.build(items: [.toolCall(running(ts: started, tail: "a\n\nc"))])
    let lines = TerminalPlanner.plan(rows[0], metrics: metrics)
    #expect(lines.count == 4)
    #expect(lines[0].elapsedSince == started)
    #expect(lines[1...].map(\.text) == ["a", " ", "c"])
    #expect(lines[1].gutter.hasPrefix(TermGlyph.output))
    #expect(lines[1...].allSatisfy { $0.tone == .faint && $0.elapsedSince == nil })
    #expect(rows[0].backgroundableCallId == "tu1")
  }

  @Test func aSettledCallCarriesNeitherClockNorTail() {
    var done = running(ts: started, tail: "a")
    done.status = .settled
    let lines = TerminalPlanner.plan(
      TerminalRows.build(items: [.toolCall(done)])[0], metrics: metrics)
    #expect(lines.allSatisfy { $0.elapsedSince == nil })
    #expect(lines.count == 1)
  }

  @Test func aHeaderWithNoRoomLeftGetsALineOfItsOwnForTheLabel() {
    let narrow = TerminalMetrics(cell: 8, line: 18, width: 8 * 20, fontSize: 13)
    let fits = TerminalPlanner.reserveElapsed(
      TerminalPlanner.wrapBody("Bash(ls)", metrics: narrow, gutter: ""), since: started,
      metrics: narrow)
    #expect(fits.count == 1)
    #expect(fits[0].elapsedSince == started)
    let full = TerminalPlanner.reserveElapsed(
      TerminalPlanner.wrapBody("Bash(make test)", metrics: narrow, gutter: ""), since: started,
      metrics: narrow)
    #expect(full.count == 2)
    #expect(full[0].elapsedSince == nil)
    #expect(full[1].text.isEmpty && full[1].elapsedSince == started)
    #expect(LiveTool.elapsedText(full[1], now: started + 6000) == "6.0s")
    #expect(LiveTool.elapsedText(fits[0], now: started + 6000) == " · 6.0s")
  }

  @Test func aCollapsedRunCarriesTheClockAndTheLatestTail() {
    let rows = TerminalRows.build(items: [
      .toolCall(running("a", ts: started, tail: "first")),
      .toolCall(running("b", ts: started + 1000, tail: "second")),
    ])
    #expect(rows.count == 1)
    #expect(rows[0].backgroundableCallId == nil)
    let lines = TerminalPlanner.plan(rows[0], metrics: metrics)
    #expect(lines[0].elapsedSince == started)
    #expect(lines.last?.text == "second")
  }
}
