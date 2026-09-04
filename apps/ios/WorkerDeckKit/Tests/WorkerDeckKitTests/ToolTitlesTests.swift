import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Tool titles")
struct ToolTitlesTests {
  @Test func declaredTitleWinsOverTheBuiltInTable() {
    #expect(ToolTitles.title(for: "fs_read") == "Reading a file")
    #expect(ToolTitles.title(for: "fs_read", titles: ["fs_read": "Peeking"]) == "Peeking")
  }

  @Test func inventsNothingForANameNobodyDeclared() {
    #expect(ToolTitles.title(for: "mcp__roam__roam_ask") == nil)
    #expect(ToolTitles.title(for: "Bash", titles: ["fs_read": "Reading a file"]) == nil)
  }

  @Test func flattensControlCharactersAndWhitespaceToOneLine() {
    #expect(ToolTitles.sanitize("  Read\n\ta   file \u{7f} now  ") == "Read a file now")
    #expect(ToolTitles.sanitize("   ") == nil)
    #expect(ToolTitles.sanitize(nil) == nil)
  }

  @Test func dropsATitleThatOnlyRestatesTheWireName() {
    #expect(ToolTitles.sanitize("fs_read", name: "fs_read") == nil)
    #expect(ToolTitles.sanitize(" fs_read \n", name: "fs_read") == nil)
    #expect(ToolTitles.sanitize("fs_read", name: "fs_write") == "fs_read")
  }

  @Test func clampsALongTitleWithAnEllipsis() {
    let long = String(repeating: "a", count: 200)
    let clamped = ToolTitles.sanitize(long)
    #expect(clamped?.count == ToolTitles.maxChars)
    #expect(clamped?.hasSuffix("…") == true)
    let exact = String(repeating: "b", count: ToolTitles.maxChars)
    #expect(ToolTitles.sanitize(exact) == exact)
  }

  @Test func decodesTheToolTitlesEvent() throws {
    let event = try JSONDecoder().decode(
      SessionEvent.self,
      from: Data(
        #"{"type":"tool_titles","seq":4,"ts":1722300000000,"titles":{"fs_read":"Peeking"}}"#.utf8))
    #expect(event.body == .toolTitles(["fs_read": "Peeking"]))
  }

  @Test func decodesAnMcpToolTitle() throws {
    let tool = try JSONDecoder().decode(
      McpServerToolInfo.self,
      from: Data(#"{"name":"roam_ask","title":"Ask the codebase"}"#.utf8))
    #expect(tool.title == "Ask the codebase")
  }

  @Test func theReducerMergesSuccessiveToolTitlesEvents() {
    func event(_ seq: Int, _ body: SessionEventBody) -> SessionEvent {
      SessionEvent(seq: seq, ts: 1_722_300_000_000, body: body)
    }
    var state = applyEvent(.initial, event(1, .toolTitles(["fs_read": "Reading"])))
    state = applyEvent(
      state, event(2, .toolTitles(["fs_write": "Writing", "fs_read": "Peeking"])))
    #expect(state.toolTitles == ["fs_read": "Peeking", "fs_write": "Writing"])
  }

  @Test func aTitleLandingLateRetitlesTheCallsAlreadyOnScreen() {
    func event(_ seq: Int, _ body: SessionEventBody) -> SessionEvent {
      SessionEvent(seq: seq, ts: 1_722_300_000_000, body: body)
    }
    let call = event(
      1,
      .assistantMessage(
        AssistantMessageEvent(
          message: ApiMessage(
            role: "assistant",
            content: .blocks([
              .toolUse(id: "tu1", name: "mcp__roam__roam_ask", input: ["q": "why"])
            ])),
          parentToolUseId: nil, uuid: "a1")))
    var state = applyEvent(.initial, call)
    guard case .toolCall(let untitled) = state.items[0] else {
      Issue.record("expected a tool call")
      return
    }
    #expect(untitled.title == nil)

    state = applyEvent(
      state, event(2, .toolTitles(["mcp__roam__roam_ask": "Asking the codebase"])))
    guard case .toolCall(let titled) = state.items[0] else {
      Issue.record("expected a tool call")
      return
    }
    #expect(titled.title == "Asking the codebase")
  }

  @Test func aCallArrivingAfterItsTitleIsBornWithIt() {
    func event(_ seq: Int, _ body: SessionEventBody) -> SessionEvent {
      SessionEvent(seq: seq, ts: 1_722_300_000_000, body: body)
    }
    var state = applyEvent(.initial, event(1, .toolTitles(["helper": "Helping out"])))
    state = applyEvent(
      state,
      event(
        2,
        .assistantMessage(
          AssistantMessageEvent(
            message: ApiMessage(
              role: "assistant",
              content: .blocks([.toolUse(id: "tu1", name: "helper", input: [:])])),
            parentToolUseId: nil, uuid: "a1"))))
    guard case .toolCall(let call) = state.items[0] else {
      Issue.record("expected a tool call")
      return
    }
    #expect(call.title == "Helping out")
  }

  @Test func theTerminalRowLeadsWithTheTitleAndRevealsTheNameWhenOpen() {
    let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)
    let call = ToolCallItem(
      id: "tu1", name: "fs_read", title: "Reading a file", input: ["path": "/tmp/a"],
      status: .settled, result: ToolCallResult(text: "ok", isError: false))
    let collapsed = TerminalPlanner.planToolCall(
      call, metrics: metrics, expansion: TerminalExpansion(), inOpen: false)
    let collapsedHeader = collapsed[0].text
    #expect(collapsedHeader.contains("Reading a file"))
    #expect(!collapsedHeader.contains("fs_read"))

    let open = TerminalPlanner.planToolCall(
      call, metrics: metrics, expansion: TerminalExpansion(open: [.call("tu1")]), inOpen: false)
    #expect(open[0].text.contains("Reading a file"))
    #expect(open[0].text.contains("· fs_read"))
  }
}
