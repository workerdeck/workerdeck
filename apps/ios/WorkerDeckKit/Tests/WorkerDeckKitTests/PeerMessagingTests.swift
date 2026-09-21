import Foundation
import Testing

@testable import WorkerDeckKit

/// Peer traffic - a message from another session, and a `peers_send` to one -
/// draws as its own kind of row and never collapses. The port of the peer cases
/// in `packages/ui/test/tool-run.test.ts` and `terminal-blocks.test.ts`, plus
/// the planned rows this renderer has to get right without a browser.
@Suite("Peer messaging")
struct PeerMessagingTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 40, fontSize: 13)
  private let wide = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)
  private let origin = MessageOrigin(sessionId: "sess-abcdefgh", name: "Alpha", engine: .codex)

  private func send(
    _ id: String, _ input: JSONValue = .object([:]), status: ToolCallStatus = .settled,
    result: ToolCallResult? = nil, name: String = "mcp__workerdeck__peers_send"
  ) -> ToolCallItem {
    ToolCallItem(id: id, name: name, input: input, status: status, result: result)
  }

  private func bash(_ id: String, parent: String? = nil) -> ToolCallItem {
    ToolCallItem(
      id: id, name: "Bash", input: .object([:]), parentToolUseId: parent, status: .settled,
      result: ToolCallResult(text: "", isError: false))
  }

  private func delivered(_ sessionId: String, _ name: String? = nil) -> ToolCallResult {
    ToolCallResult(
      text: peerDeliveredPrefix(sessionId: sessionId, name: name) + "; it was idle.",
      isError: false)
  }

  private func plan(
    _ item: TranscriptItem, metrics: TerminalMetrics? = nil, open: Set<ExpansionKey> = []
  ) -> [TermLine] {
    TerminalPlanner.plan(
      item: item, metrics: metrics ?? self.metrics, expansion: TerminalExpansion(open: open),
      inOpen: false)
  }

  // MARK: - Names

  @Test("both spellings of the send tool are recognised, and nothing else is")
  func recognisesTheSendTool() {
    #expect(isPeerSendTool("peers_send"))
    #expect(isPeerSendTool("mcp__workerdeck__peers_send"))
    #expect(!isPeerSendTool("peers_list"))
    #expect(!isPeerSendTool("Bash"))
    #expect(isPeerSend(TranscriptItem.toolCall(send("s1"))))
    #expect(!isPeerSend(TranscriptItem.toolCall(bash("b1"))))
    #expect(!isPeerSend(TranscriptItem.user(id: "u", text: "hi", origin: origin)))
  }

  @Test("the delivery line round-trips through the one format both sides agree on")
  func deliveryLineRoundTrips() {
    #expect(peerDeliveredPrefix(sessionId: "sess-1", name: "Alpha") == "Delivered to Alpha (sess-1)")
    #expect(peerDeliveredPrefix(sessionId: "sess-1") == "Delivered to sess-1")
    #expect(
      peerDeliveredTo("Delivered to Alpha (sess-1); it was idle.")
        == PeerDelivery(sessionId: "sess-1", name: "Alpha"))
    #expect(
      peerDeliveredTo("Delivered to Alpha Two (sess-1); busy, it will read it between tool calls.")
        == PeerDelivery(sessionId: "sess-1", name: "Alpha Two"))
    #expect(peerDeliveredTo("Delivered to sess-1; it was idle.") == PeerDelivery(sessionId: "sess-1"))
    #expect(peerDeliveredTo("not delivered: rate limited") == nil)
    #expect(peerDeliveredTo("Delivered to sess-1 without the semicolon") == nil)
  }

  @Test("the recipient is named from the reply, and falls back to the addressed id")
  func namesTheRecipient() {
    let addressed: JSONValue = ["sessionId": "sess-abcdefgh", "text": "ping"]
    #expect(peerSendTarget(send("s1", addressed, result: delivered("sess-abcdefgh", "Alpha"))) == "Alpha")
    #expect(peerSendTarget(send("s2", addressed, result: delivered("sess-abcdefgh"))) == "sess-abc")
    #expect(peerSendTarget(send("s3", addressed, status: .running)) == "sess-abc")
    #expect(
      peerSendTarget(
        send(
          "s4", addressed, status: .failed,
          result: ToolCallResult(text: "not delivered: nope", isError: true))) == "sess-abc")
    #expect(peerSendTarget(send("s5")) == "peer")
    #expect(peerName(origin) == "Alpha")
    #expect(peerName(MessageOrigin(sessionId: "sess-abcdefgh")) == "sess-abc")
  }

  @Test("the sent message flattens to one line for the closed row")
  func flattensToOneLine() {
    #expect(peerOneLine(peerSendText(send("s1", ["text": " a\n\n  b "]))) == "a b")
    #expect(peerSendText(send("s2")) == "")
    #expect(peerOneLine("tabs\tand\r\nreturns") == "tabs and returns")
  }

  // MARK: - The fold

  @Test("a peer send never folds into a run, in either position")
  func neverFolds() {
    #expect(foldsTogether(bash("b1"), send("s1")) == false)
    #expect(foldsTogether(send("s1"), bash("b1")) == false)
    #expect(foldsTogether(send("s1"), send("s2")) == false)
    #expect(foldsTogether(bash("b1"), bash("b2")) == true)
  }

  @Test("it takes a blank line either side, like a message and unlike a tool row")
  func takesBlankLines() {
    #expect(needsBlank(.toolCall(bash("b1")), .toolCall(send("s1"))))
    #expect(needsBlank(.toolCall(send("s1")), .toolCall(bash("b1"))))
    #expect(needsBlank(.toolCall(send("s1")), .toolCall(send("s2"))))
    #expect(needsBlank(.toolCall(bash("b1")), .toolCall(bash("b2"))) == false)
    let rows = TerminalRows.build(items: [
      .toolCall(bash("b1")), .toolCall(send("s1", ["text": "hi"])), .toolCall(bash("b2")),
    ])
    #expect(rows.count == 3)
    #expect(rows.gapBefore(1))
    #expect(rows.gapBefore(2))
    // One line and its gap: closed, the row is exactly one line tall.
    #expect(TerminalHeightBook(rows: rows, metrics: metrics).height(at: 1) == 2 * metrics.line)
  }

  @Test("a peer send inside a Task is still its own leaf, spaced as a message")
  func insideATask() {
    let task = ToolCallItem(id: "T", name: "Task", input: .object([:]), status: .settled)
    var child = send("s1", ["text": "ping"])
    child.parentToolUseId = "T"
    let blocks = terminalBlocks([
      .toolCall(task), .toolCall(bash("b1", parent: "T")), .toolCall(child),
      .toolCall(bash("b2", parent: "T")),
    ])
    guard case .task(let block) = blocks[0] else { Issue.record("expected a task"); return }
    #expect(block.children.count == 3)
    guard case .item(let leaf) = block.children[1] else { Issue.record("expected a leaf"); return }
    #expect(leaf.item.id == "s1")
    #expect(leafNeedsBlank(block.children[0], block.children[1]))
    #expect(leafNeedsBlank(block.children[1], block.children[2]))
  }

  // MARK: - The inbound row

  @Test("a peer's message draws as an arrow, a bold name and the text in the peer tone, off the band")
  func inboundRow() throws {
    let lines = plan(.user(id: "u1", text: "ping", origin: origin))
    #expect(lines.count == 1)
    let line = lines[0]
    #expect(line.gutter == TermGlyph.peerIn)
    #expect(line.gutterTone == .peer)
    #expect(line.tone == .peer)
    #expect(line.band == .none)
    #expect(line.text == "Alpha: ping")
    // The name is bold and nothing else is, and the styled run is exactly the
    // measured characters.
    let styled = try #require(line.attributed)
    #expect(String(styled.characters) == line.text)
    let bold = styled.runs.filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
    #expect(bold.count == 1)
    #expect(bold.first.map { String(styled[$0.range].characters) } == "Alpha:")
  }

  @Test("continuation lines carry no glyph and stay in the peer tone")
  func inboundContinuation() {
    let lines = plan(.user(id: "u1", text: "first\nsecond", origin: origin))
    #expect(lines.map(\.text) == ["Alpha: first", "second"])
    #expect(lines.map(\.gutter) == [TermGlyph.peerIn, ""])
    #expect(lines.allSatisfy { $0.tone == .peer && $0.band == .none })
    let second = lines[1].attributed?.runs.contains { $0.inlinePresentationIntent != nil }
    #expect(second == false)
  }

  @Test("an unnamed peer is addressed by the head of its id")
  func inboundUnnamed() {
    let lines = plan(.user(id: "u1", text: "ping", origin: MessageOrigin(sessionId: "sess-abcdefgh")))
    #expect(lines.map(\.text) == ["sess-abc: ping"])
  }

  @Test("the human's own prompt is untouched")
  func humanPromptUnchanged() {
    let lines = plan(.user(id: "u1", text: "ping"))
    #expect(lines.count == 1)
    #expect(lines[0].gutter == TermGlyph.prompt)
    #expect(lines[0].band == .user)
    #expect(lines[0].tone == .fg)
    #expect(lines[0].text == "ping")
    #expect(lines[0].attributed == nil)
  }

  // MARK: - The outbound row

  @Test("closed, a peer send is exactly one ellipsised line, whatever the message's length")
  func closedIsOneLine() throws {
    let long = String(repeating: "word ", count: 40)
    let call = send(
      "s1", ["sessionId": "sess-abcdefgh", "text": .string(long + "\nmore")],
      result: delivered("sess-abcdefgh", "Alpha"))
    let rows = TerminalRows.build(items: [.toolCall(call)])
    #expect(rows.count == 1)
    guard case .block(.item) = rows[0] else {
      Issue.record("expected an item block, not a run")
      return
    }
    let lines = TerminalPlanner.plan(rows[0], metrics: metrics)
    #expect(lines.count == 1)
    let line = lines[0]
    #expect(line.gutter == TermGlyph.peerOut)
    #expect(line.gutterTone == .peer)
    #expect(line.tone == .peer)
    #expect(line.band == .none)
    #expect(line.text.hasPrefix("Alpha: word word"))
    #expect(line.text.hasSuffix("…"))
    let cols = metrics.columns(gutter: 2)
    #expect(line.text.count == cols)
    #expect(TerminalCells.textLines(line.text, cols: cols).lines == 1)
    #expect(line.press == .toggle(.call("s1")))
    let styled = try #require(line.attributed)
    #expect(String(styled.characters) == line.text)
    let bold = styled.runs.filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
    #expect(bold.first.map { String(styled[$0.range].characters) } == "Alpha:")
    #expect(TerminalHeightBook(rows: rows, metrics: metrics).height(at: 0) == metrics.line)
  }

  @Test("open, it is the whole message and then the delivery line in faint")
  func openShowsTheMessage() {
    let call = send(
      "s1", ["sessionId": "sess-abcdefgh", "text": "first line\n\nthird line"],
      result: delivered("sess-abcdefgh", "Alpha"))
    let lines = plan(.toolCall(call), metrics: wide, open: [.call("s1")])
    #expect(
      lines.map(\.text) == [
        "Alpha: first line", " ", "third line",
        "Delivered to Alpha (sess-abcdefgh); it was idle.",
      ])
    #expect(lines.map(\.gutter) == [TermGlyph.peerOut, "", "", ""])
    #expect(lines.map(\.tone) == [.peer, .peer, .peer, .faint])
    #expect(lines.allSatisfy { $0.press == .toggle(.call("s1")) && $0.inOpen })
  }

  @Test("a message that fits, with no reply yet, has nothing to open and offers no press")
  func shortUnsettledSendHasNoPress() {
    let call = send("s1", ["sessionId": "sess-abcdefgh", "text": "ping"], status: .running)
    let closed = plan(.toolCall(call))
    #expect(closed.count == 1)
    #expect(closed[0].text == "sess-abc: ping")
    #expect(closed[0].press == nil)
    // Asked to open anyway, it stays as it was: there is no other state to show.
    #expect(plan(.toolCall(call), open: [.call("s1")]) == closed)
    // The reply landing is what gives the row a second state, and the press.
    var settled = call
    settled.result = delivered("sess-abcdefgh", "Alpha")
    let planned = plan(.toolCall(settled))
    #expect(planned.map(\.text) == ["Alpha: ping"])
    #expect(planned[0].press == .toggle(.call("s1")))
  }

  @Test("a failed send reads red, with the delivery line still faint")
  func failedSendIsRed() {
    let call = send(
      "s1", ["sessionId": "sess-abcdefgh", "text": "ping"], status: .failed,
      result: ToolCallResult(text: "not delivered: rate limited", isError: true))
    let closed = plan(.toolCall(call))
    #expect(closed.count == 1)
    #expect(closed[0].tone == .red)
    #expect(closed[0].gutterTone == .red)
    #expect(closed[0].text == "sess-abc: ping")
    let open = plan(.toolCall(call), open: [.call("s1")])
    #expect(open.map(\.tone) == [.red, .faint])
    #expect(open[1].text == "not delivered: rate limited")
  }

  @Test("it is never summarised, mid-run or beside one")
  func neverSummarised() {
    let rows = TerminalRows.build(items: [
      .toolCall(bash("b1")),
      .toolCall(send("s1", ["text": "ping"], result: delivered("sess-1", "Alpha"))),
      .toolCall(bash("b2")), .toolCall(bash("b3")),
    ])
    #expect(rows.count == 3)
    #expect(TerminalPlanner.plan(rows[1], metrics: metrics).map(\.text) == ["Alpha: ping"])
    #expect(TerminalPlanner.plan(rows[2], metrics: metrics)[0].text == "Ran 2 shell commands")
    #expect(rows.position(forItem: 1) == nil)
  }

  @Test("the long-press menu copies the message, and bookmarks the call")
  func copyAndBookmark() {
    let call = send(
      "s1", ["sessionId": "sess-1", "text": "ping\npong"], result: delivered("sess-1", "Alpha"))
    let rows = TerminalRows.build(items: [.toolCall(call)])
    #expect(rows[0].copyText == "ping\npong")
    #expect(rows[0].bookmarkItemId == "s1")
    #expect(TerminalRows.build(items: [.toolCall(send("s2"))])[0].copyText == nil)
  }

  @Test("the cell clip keeps whole clusters and spends the last cell on the ellipsis")
  func cellClip() {
    #expect(TerminalCells.clipped("abcdef", cols: 6) == "abcdef")
    #expect(TerminalCells.clipped("abcdefg", cols: 6) == "abcde…")
    #expect(TerminalCells.clipped("日本語テキスト", cols: 6) == "日本…")
    #expect(TerminalCells.clipped("", cols: 3) == "")
    #expect(TerminalCells.clipped("abc", cols: 0) == "")
  }
}
