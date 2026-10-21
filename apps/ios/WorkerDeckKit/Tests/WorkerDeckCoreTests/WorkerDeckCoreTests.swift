import Foundation
import Testing
import WorkerDeckCore

private let attached =
  #"{"type":"attached","protocolVersion":2,"replayingFrom":0,"acks":true,"session":{"id":"s1","title":"Deck work","status":"running","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"#

private func corpus(_ name: String) throws -> String {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../../crates/core/tests/conformance")
  return try String(contentsOf: root.appending(path: "\(name).events.jsonl").standardizedFileURL, encoding: .utf8)
}

@Test func theCoreAnswersFromSwift() {
  #expect(resultImagePath(sessionId: "a b", seq: 12, toolUseId: "toolu/1", partIndex: 0)
    == "/sessions/a%20b/events/12/result?toolUseId=toolu%2F1&part=0")
  #expect(imageUnavailable() == "image unavailable")
}

@Test func aReplayedSessionPlansRows() throws {
  let session = Session(afterSeq: 0, reconnect: true, nonce: "n", metrics: Metrics(cell: 8, line: 16, width: 800, fontSize: 13))
  _ = session.opened()
  _ = session.received(text: attached, now: 0)
  _ = session.receivedBatch(frames: try corpus("tool-result-truncated-and-images"), now: 0)
  let layout = [UInt8](session.transcriptLayout())
  #expect(layout.first == snapshotVersion())
  let rows = layout[1..<5].enumerated().reduce(0) { $0 | Int($1.element) << (8 * $1.offset) }
  #expect(rows > 0)
}
