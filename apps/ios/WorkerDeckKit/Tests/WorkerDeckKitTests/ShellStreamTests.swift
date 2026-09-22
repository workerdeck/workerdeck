import Foundation
import Testing

@testable import WorkerDeckKit

/// The drill-in's wire: the four `shell_*` commands, the three frames, and the
/// one rule the client side owns - that a paste is split on the byte budget the
/// gateway enforces rather than refused.
@Suite("Shell stream")
struct ShellStreamTests {
  private func object(_ command: SessionCommand) throws -> [String: Any] {
    let data = try JSONEncoder().encode(command)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  // MARK: - Commands

  @Test func encodesTheAttachCommandWithItsSize() throws {
    let frame = try object(.shellAttach(shellId: "sh_1", cols: 80, rows: 24))
    #expect(frame["type"] as? String == "shell_attach")
    #expect(frame["shellId"] as? String == "sh_1")
    #expect(frame["cols"] as? Int == 80)
    #expect(frame["rows"] as? Int == 24)
    #expect(frame.count == 4)
  }

  @Test func encodesInputResizeAndDetach() throws {
    let input = try object(.shellInput(shellId: "sh_1", data: "ls\r"))
    #expect(input["type"] as? String == "shell_input")
    #expect(input["data"] as? String == "ls\r")

    let resize = try object(.shellResize(shellId: "sh_1", cols: 100, rows: 30))
    #expect(resize["type"] as? String == "shell_resize")
    #expect(resize["cols"] as? Int == 100)

    let detach = try object(.shellDetach(shellId: "sh_1"))
    #expect(detach["type"] as? String == "shell_detach")
    #expect(detach.count == 2)
  }

  // MARK: - Frames

  /// The scrollback is raw PTY text, escape sequences and all, because it is fed
  /// to the emulator exactly like a live chunk. A stripped replay would lose the
  /// screen that made the last command mean something.
  @Test func decodesTheAttachedFrame() throws {
    let json = """
      {"type":"shell_attached","shellId":"sh_1","cols":80,"rows":24,
       "scrollback":"\\u001b[32mok\\u001b[0m\\r\\n",
       "shell":{"id":"sh_1","sessionId":"s1","ordinal":3,"command":"npm run dev",
         "label":"npm run dev","cwd":"/work","owner":"user","status":"running",
         "startedAt":1000,"bytes":12,"cols":120,"rows":40}}
      """
    let frame = try JSONDecoder().decode(ServerFrame.self, from: Data(json.utf8))
    guard case .shellAttached(let attached) = frame else {
      Issue.record("expected shell_attached, got \(frame)")
      return
    }
    #expect(attached.shellId == "sh_1")
    #expect(attached.cols == 80)
    #expect(attached.shell.ordinal == 3)
    #expect(attached.scrollback == "\u{1b}[32mok\u{1b}[0m\r\n")
  }

  @Test func decodesOutputAndDetached() throws {
    let output = try JSONDecoder().decode(
      ServerFrame.self, from: Data(#"{"type":"shell_output","shellId":"sh_1","data":"hi"}"#.utf8))
    #expect(output == .shellOutput(shellId: "sh_1", data: "hi"))

    let detached = try JSONDecoder().decode(
      ServerFrame.self,
      from: Data(#"{"type":"shell_detached","shellId":"sh_1","reason":"exited"}"#.utf8))
    #expect(detached == .shellDetached(shellId: "sh_1", reason: "exited"))
  }

  /// A frame this mirror does not model reads as `.unknown` rather than failing
  /// the stream - the rule the whole decoder follows, pinned here too because a
  /// shell frame arrives on the hot path where a thrown error would be a
  /// disconnect.
  @Test func anUnmodelledShellFrameIsNotAnError() throws {
    let frame = try JSONDecoder().decode(
      ServerFrame.self, from: Data(#"{"type":"shell_reflowed","shellId":"sh_1"}"#.utf8))
    guard case .unknown(let type, _) = frame else {
      Issue.record("expected unknown, got \(frame)")
      return
    }
    #expect(type == "shell_reflowed")
  }

  // MARK: - Chunking

  @Test func shortInputIsOneFrame() {
    #expect(SessionHandle.chunk("ls -la\r", max: 4096) == ["ls -la\r"])
  }

  /// Split on the **UTF-8** length, which is what the gateway bounds, and never
  /// mid-scalar: a chunk boundary inside an escape sequence is harmless (the far
  /// side resumes mid-sequence) but one inside a character is corruption.
  @Test func aLongPasteIsSplitOnTheByteBudget() {
    let chunks = SessionHandle.chunk(String(repeating: "a", count: 10_000), max: 4096)
    #expect(chunks.count == 3)
    #expect(chunks.map(\.utf8.count) == [4096, 4096, 1808])
    #expect(chunks.joined() == String(repeating: "a", count: 10_000))
  }

  @Test func aMultibyteCharacterIsNeverSplit() {
    // Three bytes each, so a budget of 4 can only ever carry one per chunk.
    let text = String(repeating: "あ", count: 5)
    let chunks = SessionHandle.chunk(text, max: 4)
    #expect(chunks == ["あ", "あ", "あ", "あ", "あ"])
    #expect(chunks.joined() == text)
  }

  /// A single character larger than the budget still has to go somewhere, and
  /// dropping it would silently eat what the reader typed. One over-budget
  /// frame is the gateway's problem to refuse, and it can say so.
  @Test func oneOversizedCharacterStillGoes() {
    #expect(SessionHandle.chunk("あ", max: 2) == ["あ"])
  }
}
