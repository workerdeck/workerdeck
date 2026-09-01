import Foundation
import Testing

@testable import WorkerDeckKit

/// A tool result's pictures, delivered as addresses instead of bytes.
///
/// The three claims worth pinning are the ones a second client could get
/// subtly wrong and nobody would notice until a box was empty: the wire shape
/// decodes, its **absence** decodes to exactly what it did before, and the
/// planner reserves the same box the web client does.
@Suite("ImageRefs")
struct ImageRefTests {
  private let metrics = TerminalMetrics(cell: 8, line: 18, width: 8 * 80, fontSize: 13)

  private func decodeBlock(_ json: String) throws -> ContentBlock {
    try JSONDecoder().decode(ContentBlock.self, from: Data(json.utf8))
  }

  // MARK: - The wire shape

  @Test("an image_ref part decodes to its address")
  func decodesImageRef() throws {
    let block = try decodeBlock(
      """
      {"type":"tool_result","tool_use_id":"t1","content":[
        {"type":"text","text":"took a screenshot"},
        {"type":"image_ref","media_type":"image/png","bytes":343040,"part_index":3}
      ]}
      """)
    guard case .toolResult(let result) = block else { return #expect(Bool(false)) }
    // The fold is untouched: a part with no `text` contributes nothing, exactly
    // as the CLI's own `tool_reference` already does.
    #expect(result.content?.joinedText == "took a screenshot")
    let refs = try #require(result.content?.imageRefs(sourceSeq: 42))
    #expect(refs.count == 1)
    // `part_index` is the address, not the position: this part sits at index 1
    // of what arrived and at index 3 of what is stored.
    #expect(refs[0].partIndex == 3)
    #expect(refs[0].mediaType == "image/png")
    #expect(refs[0].bytes == 343_040)
    #expect(refs[0].sourceSeq == 42)
  }

  @Test("a media type the gateway could not name falls back rather than failing")
  func toleratesMissingMediaType() throws {
    let block = try decodeBlock(
      """
      {"type":"tool_result","tool_use_id":"t1","content":[
        {"type":"image_ref","bytes":10,"part_index":0}
      ]}
      """)
    guard case .toolResult(let result) = block else { return #expect(Bool(false)) }
    let refs = try #require(result.content?.imageRefs(sourceSeq: 1))
    #expect(refs[0].mediaType == "application/octet-stream")
  }

  @Test("a gateway that never heard of image_ref decodes exactly as before")
  func toleratesAbsence() throws {
    // The compatibility claim, asserted rather than argued: an old gateway, or
    // a socket that did not ask, sends these — and a raw base64 image part is
    // still dropped on arrival, never folded into state.
    let block = try decodeBlock(
      """
      {"type":"tool_result","tool_use_id":"t1","is_error":false,"content":[
        {"type":"text","text":"ok"},
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},
        {"type":"tool_reference","name":"Read"}
      ]}
      """)
    guard case .toolResult(let result) = block else { return #expect(Bool(false)) }
    #expect(result.content?.joinedText == "ok")
    #expect(result.content?.imageRefs(sourceSeq: 1) == nil)
  }

  @Test("a string result has no images, and says so with nil rather than empty")
  func stringContentHasNoRefs() {
    // nil and [] are not the same fact here: `ToolCallItem` is `Equatable` and
    // half the plan cache's key, so an always-present empty array would be a
    // new value for every row in the transcript.
    #expect(ToolResultContent.text("plain").imageRefs(sourceSeq: 1) == nil)
    #expect(ToolResultContent.parts([]).imageRefs(sourceSeq: 1) == nil)
  }

  // MARK: - The byte arithmetic

  @Test("decoded size comes out of the base64 length and its padding")
  func base64Arithmetic() {
    // Computed, never decoded: measuring a 665 KB screenshot by decoding it is
    // the allocation this whole rule exists to avoid.
    #expect(base64DecodedBytes("") == 0)
    #expect(base64DecodedBytes("AAAA") == 3)  // no padding
    #expect(base64DecodedBytes("AAA=") == 2)  // one pad byte
    #expect(base64DecodedBytes("AA==") == 1)  // two
    // And against a real payload, which is the only check that catches a
    // fencepost: whatever `Data` actually decodes to is what the gateway
    // stamped.
    let bytes = Data((0..<1000).map { UInt8($0 % 251) })
    for trim in 0..<3 {
      let payload = bytes.prefix(bytes.count - trim)
      let encoded = payload.base64EncodedString()
      #expect(base64DecodedBytes(encoded) == payload.count)
    }
  }

  // MARK: - The reducer

  @Test("images ride the tool-call item, and survive a text hydration")
  func hydrationKeepsImages() {
    let call = ToolCallItem(
      id: "t1", name: "Bash", input: .null, status: .settled,
      result: ToolCallResult(
        text: "head", isError: false, truncated: true, totalChars: 90_000, sourceSeq: 7,
        images: [
          ToolResultImageRef(
            partIndex: 2, mediaType: "image/png", bytes: 343_040, sourceSeq: 7)
        ]))
    var state = TranscriptState()
    state.items = [.toolCall(call)]

    let hydrated = hydrateToolResult(state, toolUseId: "t1", text: "the whole thing")
    guard case .toolCall(let after) = hydrated.items[0] else { return #expect(Bool(false)) }
    // The text markers go, exactly as before…
    #expect(after.result?.text == "the whole thing")
    #expect(after.result?.truncated == false)
    #expect(after.result?.sourceSeq == nil)
    // …and the pictures stay, still loadable, because each ref carries the seq
    // the result-level one just gave up.
    #expect(after.result?.images?.count == 1)
    #expect(after.result?.images?[0].sourceSeq == 7)
  }

  // MARK: - The planner

  @Test("each image reserves exactly IMAGE_BOX_LINES of the grid")
  func planReservesTheBox() {
    // The height model inverted: the box is not predicted, it is *planned*, so
    // the placeholder, the loaded picture and the failure notice are the same
    // number of lines by construction and a fetch landing can never reflow the
    // transcript.
    func plan(images: Int) -> [TermLine] {
      let refs = (0..<images).map {
        ToolResultImageRef(partIndex: $0, mediaType: "image/png", bytes: 343_040, sourceSeq: 9)
      }
      let call = ToolCallItem(
        id: "t1", name: "Bash", input: .object(["command": .string("screenshot")]),
        status: .settled,
        result: ToolCallResult(
          text: "", isError: false, images: refs.isEmpty ? nil : refs))
      return TerminalPlanner.plan(TerminalRows.build(items: [.toolCall(call)])[0], metrics: metrics)
    }

    let none = plan(images: 0).count
    #expect(plan(images: 1).count == none + TermImage.boxLines)
    #expect(plan(images: 3).count == none + 3 * TermImage.boxLines)

    // The address rides the box's **first** line and nowhere else — the lines
    // after it merely reserve the grid, which is what the cell places the one
    // picture over.
    let lines = plan(images: 2)
    let heads = lines.compactMap(\.image)
    #expect(heads.count == 2)
    #expect(heads[0].partIndex == 0)
    #expect(heads[1].partIndex == 1)
    #expect(heads[0].toolUseId == "t1")
    #expect(heads[0].sourceSeq == 9)
    #expect(heads[0].lines == TermImage.boxLines)
    // Distinct keys, or a cache would serve the first screenshot for both.
    #expect(heads[0].key != heads[1].key)
  }

  @Test("the box is the same size expanded — a deliberate divergence")
  func boxDoesNotGrowOnExpansion() {
    // The web client mounts an expanded row and measures it, so an image there
    // may reveal its intrinsic size. Here nothing self-measures: the planner
    // wraps and the renderer draws what it returned, so a box that grew on
    // expansion would be a frame the layout got wrong. Recorded like
    // `TerminalDivergences`' run-of-one rather than left to be rediscovered.
    let call = ToolCallItem(
      id: "t1", name: "Bash", input: .null, status: .settled,
      result: ToolCallResult(
        text: "some output", isError: false,
        images: [
          ToolResultImageRef(partIndex: 0, mediaType: "image/png", bytes: 1024, sourceSeq: 3)
        ]))
    let row = TerminalRows.build(items: [.toolCall(call)])[0]
    var open = TerminalExpansion()
    _ = open.apply(.toggle(.call("t1")))

    let collapsed = TerminalPlanner.plan(row, metrics: metrics, expansion: TerminalExpansion())
    let expanded = TerminalPlanner.plan(row, metrics: metrics, expansion: open)
    #expect(collapsed.filter { $0.image != nil }.count == 1)
    #expect(expanded.filter { $0.image != nil }.count == 1)
    #expect(collapsed.compactMap(\.image).first?.lines == TermImage.boxLines)
    #expect(expanded.compactMap(\.image).first?.lines == TermImage.boxLines)
  }

  @Test("the placeholder spells the size the gateway stamped")
  func placeholderSpelling() {
    // One spelling, shared with the web client's `imagePlaceholder`: this
    // string is what the box says before the fetch lands, and the phone and the
    // dashboard must not describe the same screenshot differently.
    #expect(TermImage.placeholder(bytes: 343_040) == "image · 335.0 KB")
    #expect(TermImage.unavailable == "image unavailable")
    #expect(TermImage.boxLines == 12)
  }

  // MARK: - The opt-in

  @Test("imageRefs is its own flag on the attach")
  func attachFlagIsSeparate() throws {
    let client = WorkerClient(baseURL: URL(string: "http://phone.local:8787")!)
    // Off by default and separately from truncation, because this family's
    // "additive on this protocol" argument rests on a client that never asked
    // being unable to receive one.
    #expect(
      try client.webSocketURL(sessionId: "s1", afterSeq: 0).absoluteString
        == "ws://phone.local:8787/sessions/s1/ws?afterSeq=0")
    #expect(
      try client.webSocketURL(sessionId: "s1", afterSeq: 4, imageRefs: true).absoluteString
        == "ws://phone.local:8787/sessions/s1/ws?afterSeq=4&imageRefs=1")
    #expect(
      try client.webSocketURL(
        sessionId: "s1", afterSeq: 0, truncateResults: true, imageRefs: true
      ).absoluteString
        == "ws://phone.local:8787/sessions/s1/ws?afterSeq=0&truncateResults=1&imageRefs=1")
  }
}
