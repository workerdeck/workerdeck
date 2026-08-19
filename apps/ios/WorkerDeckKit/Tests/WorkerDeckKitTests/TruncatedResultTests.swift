import Foundation
import Testing

@testable import WorkerDeckKit

/// A tool result that arrived as a **head**, and the press that fetches the rest.
///
/// The property worth stating is the same inequality the web client's test
/// states, and it is what makes this feature honest beside the rest of the
/// replay-rule family: truncation is *not* fold-equal. A truncated attach
/// differs from a full one in the result's text and its three markers and
/// **nowhere else**, and hydration restores exact equality — so a row that has
/// been fetched is indistinguishable from one that was never cut, which is what
/// lets every renderer carry a branch for one state rather than two.
@Suite("Truncated tool results")
struct TruncatedResultTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 60, fontSize: 13)

  private func event(_ seq: Int, _ body: SessionEventBody) -> SessionEvent {
    SessionEvent(seq: seq, ts: 1_722_300_000_000, body: body)
  }

  private func callEvent(_ seq: Int, id: String) -> SessionEvent {
    event(
      seq,
      .assistantMessage(
        AssistantMessageEvent(
          message: ApiMessage(
            role: "assistant", content: .blocks([.toolUse(id: id, name: "Bash", input: .null)])),
          parentToolUseId: nil, uuid: "a\(seq)")))
  }

  private func resultEvent(
    _ seq: Int, id: String, text: String, truncated: Bool? = nil, totalChars: Int? = nil
  ) -> SessionEvent {
    event(
      seq,
      .userMessage(
        UserMessageEvent(
          message: ApiMessage(
            role: "user",
            content: .blocks([
              .toolResult(
                ToolResultBlock(
                  toolUseId: id, content: .text(text), isError: false, truncated: truncated,
                  totalChars: totalChars))
            ])),
          synthetic: nil, uuid: "u\(seq)")))
  }

  private func result(_ state: TranscriptState, _ id: String) -> ToolCallResult? {
    for item in state.items {
      guard case .toolCall(let call) = item, call.id == id else { continue }
      return call.result
    }
    return nil
  }

  // MARK: - The wire, and what it sets on the item

  @Test("a marked block sets the three fields; an ordinary one leaves them alone")
  func markersAreSetOnlyWhenTruncated() {
    let head = String(repeating: "x", count: 8_000)
    let truncated = [
      callEvent(1, id: "t1"), resultEvent(2, id: "t1", text: head, truncated: true, totalChars: 641_003),
    ].reduce(TranscriptState.initial, applyEvent)
    #expect(result(truncated, "t1")?.truncated == true)
    #expect(result(truncated, "t1")?.totalChars == 641_003)
    // The seq of the event it arrived on — the only thing that can name it to
    // the fetch route.
    #expect(result(truncated, "t1")?.sourceSeq == 2)

    let whole = [callEvent(1, id: "t1"), resultEvent(2, id: "t1", text: "small")]
      .reduce(TranscriptState.initial, applyEvent)
    // Byte-identical to what it was before this feature: `ToolCallItem` is
    // `Equatable` and half the plan cache's key, so an always-present field
    // would miss the cache on every row in the transcript.
    #expect(result(whole, "t1") == ToolCallResult(text: "small", isError: false))
  }

  @Test("the truncated fold differs from the full one in the text and the markers, and nowhere else")
  func foldDiffersOnlyInTheResult() {
    let whole = String(repeating: "line\n", count: 5_000)
    let full = [callEvent(1, id: "t1"), resultEvent(2, id: "t1", text: whole)]
      .reduce(TranscriptState.initial, applyEvent)
    let cut = [
      callEvent(1, id: "t1"),
      resultEvent(
        2, id: "t1", text: String(whole.prefix(8_000)), truncated: true, totalChars: whole.count),
    ].reduce(TranscriptState.initial, applyEvent)

    #expect(cut != full)
    // Hydration restores exact equality — the whole claim of this feature.
    #expect(hydrateToolResult(cut, toolUseId: "t1", text: whole) == full)
  }

  @Test("hydration is refused where it would invent a row")
  func hydrationIsNarrow() {
    let cut = [
      callEvent(1, id: "t1"), resultEvent(2, id: "t1", text: "head", truncated: true, totalChars: 99),
    ].reduce(TranscriptState.initial, applyEvent)

    // An id that is not here — a press answered after a `/clear`.
    #expect(hydrateToolResult(cut, toolUseId: "nope", text: "x") == cut)
    // And a result that was never a head: a second answer must not overwrite a
    // whole result with whatever a stale fetch returned.
    let whole = [callEvent(1, id: "t1"), resultEvent(2, id: "t1", text: "all of it")]
      .reduce(TranscriptState.initial, applyEvent)
    #expect(hydrateToolResult(whole, toolUseId: "t1", text: "something else") == whole)
  }

  // MARK: - What the collapsed row says

  @Test("the collapsed row counts what is missing, not what it happens to hold")
  func collapsedCountsTheTruth() {
    let head = Array(repeating: String(repeating: "y", count: 40), count: 10)
    let held = head.joined(separator: "\n").count
    let cut = ResultPreview.collapsed(head, cols: 40, totalChars: 641_003)
    // Computed from the head this would say "+241 chars" where the truth is
    // 640,844 — and the wrong string is a different row height.
    let counted = Int(cut.more?.filter(\.isNumber) ?? "") ?? 0
    #expect(counted > 600_000)
    #expect(held < 1_000)
    #expect(cut.more != ResultPreview.collapsed(head, cols: 40).more)
  }

  @Test("a head that fits the line budget still says there is more")
  func aShortHeadStillOffersTheRest() {
    // Four short lines: nothing is clipped, so the line count is zero and the
    // old rule would have drawn no affordance at all — a row silently claiming
    // to be the whole of a 90,000-character result.
    let head = ["one", "two", "three", "four"]
    #expect(ResultPreview.collapsed(head, cols: 80).more == nil)
    let cut = ResultPreview.collapsed(head, cols: 80, totalChars: 90_000)
    #expect(cut.shown == head)
    #expect(cut.more?.hasSuffix("chars") == true)
  }

  // MARK: - The press

  @Test("a press on a head starts one fetch, and says so instead of doing nothing")
  func pressEntersPendingAndDrawsIt() {
    var expansion = TerminalExpansion()
    let key = TerminalExpansion.fullKey(callId: "t1")
    let first = expansion.beginFetch(fullKey: key)
    // A second press on a row already waiting must not open a second connection.
    let second = expansion.beginFetch(fullKey: key)
    #expect(first)
    #expect(!second)
    #expect(expansion.isFetching(key))
    #expect(!expansion.isFull(key))

    let rows = TerminalRows.build(items: [.toolCall(head("t1"))])
    expansion.open.insert(TerminalExpansion.openKey(callId: "t1"))
    let plan = TerminalPlanner.plan(rows[0], metrics: metrics, expansion: expansion)
    let fetching = plan.filter { $0.text.contains("fetching") }
    #expect(!fetching.isEmpty)
    // No press while one is in flight: the row says what it is doing rather than
    // offering a target that would do it again.
    #expect(fetching.allSatisfy { $0.press == nil })
    #expect(fetching.contains { $0.text.contains("641,003") })
  }

  @Test("open and not yet asked, the row offers the rest and names the size")
  func openOffersTheFetch() {
    var expansion = TerminalExpansion()
    expansion.open.insert(TerminalExpansion.openKey(callId: "t1"))
    let rows = TerminalRows.build(items: [.toolCall(head("t1"))])
    let plan = TerminalPlanner.plan(rows[0], metrics: metrics, expansion: expansion)
    let offer = plan.filter { $0.text.contains("fetch the rest") }
    #expect(!offer.isEmpty)
    #expect(
      offer.allSatisfy { $0.press == .expandFull(TerminalExpansion.fullKey(callId: "t1")) })
  }

  @Test("closing forgets the request, and the text lands full when it arrives")
  func closeForgetsAndArrivalPromotes() {
    var expansion = TerminalExpansion()
    let openKey = TerminalExpansion.openKey(callId: "t1")
    let fullKey = TerminalExpansion.fullKey(callId: "t1")
    expansion.apply(.toggle(openKey))
    expansion.beginFetch(fullKey: fullKey)
    expansion.apply(.toggle(openKey))
    #expect(!expansion.isFetching(fullKey))
    // And the bytes landing afterwards do not re-open what the reader closed.
    expansion.finishFetch(fullKey: fullKey)
    #expect(!expansion.isFull(fullKey))

    var waiting = TerminalExpansion()
    waiting.beginFetch(fullKey: fullKey)
    waiting.finishFetch(fullKey: fullKey)
    // One step, so the row goes from "fetching" straight to the whole result —
    // lifting the budget first would show 8,000 characters of head and then
    // replace them, which is a flash, not a state.
    #expect(waiting.isFull(fullKey))
    #expect(!waiting.isFetching(fullKey))
  }

  @Test("the audit's fully-open expansion plans a head as pending, never as full")
  func everythingPutsHeadsInPending() {
    let rows = TerminalRows.build(items: [
      .toolCall(head("t1")),
      .toolCall(
        ToolCallItem(
          id: "t2", name: "Bash", input: .null, status: .settled,
          result: ToolCallResult(text: "whole", isError: false))),
    ])
    let everything = TerminalExpansion.everything(in: rows)
    // A `full` state whose text was never delivered is a screen nobody can
    // reach; auditing it would be auditing a fiction.
    #expect(everything.pending.contains(TerminalExpansion.fullKey(callId: "t1")))
    #expect(!everything.full.contains(TerminalExpansion.fullKey(callId: "t1")))
    #expect(everything.full.contains(TerminalExpansion.fullKey(callId: "t2")))
  }

  @Test("a row reads only its own share of what is pending")
  func subsetCarriesPending() {
    // Separated by prose, or the fold would make the two calls one run row —
    // which is a different (and already tested) shape.
    let rows = TerminalRows.build(items: [
      .toolCall(head("t1")),
      .assistantText(id: "a", text: "and then", streaming: false, parentToolUseId: nil),
      .toolCall(head("t2")),
    ])
    var expansion = TerminalExpansion()
    expansion.beginFetch(fullKey: TerminalExpansion.fullKey(callId: "t1"))
    // The plan cache's second key: a fetch on one row must not re-plan the
    // sixteen thousand rows that know nothing about it.
    #expect(expansion.subset(for: rows[0]).pending.count == 1)
    #expect(expansion.subset(for: rows[2]).pending.isEmpty)
  }

  // MARK: - The attach

  @Test("the opt-in rides the attach URL, and is absent unless asked for")
  func attachAsksForHeads() throws {
    let client = WorkerClient(baseURL: URL(string: "http://gateway.test/v1")!)
    let plain = try client.webSocketURL(sessionId: "s1", afterSeq: 0)
    #expect(!plain.absoluteString.contains("truncateResults"))
    let asking = try client.webSocketURL(sessionId: "s1", afterSeq: 0, truncateResults: true)
    #expect(asking.absoluteString.hasSuffix("ws?afterSeq=0&truncateResults=1"))
  }

  /// A call whose result arrived as a head: 8,000 characters of a 641,003-char
  /// `find /`, which is the frame the whole feature was measured against.
  private func head(_ id: String) -> ToolCallItem {
    ToolCallItem(
      id: id, name: "Bash", input: .null, status: .settled,
      result: ToolCallResult(
        text: String(repeating: "found/a/path\n", count: 615), isError: false, truncated: true,
        totalChars: 641_003, sourceSeq: 2))
  }
}
