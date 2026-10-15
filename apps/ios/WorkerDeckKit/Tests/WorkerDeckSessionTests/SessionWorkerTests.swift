import Foundation
import Testing
import WorkerDeckSession

private let attached =
  #"{"type":"attached","protocolVersion":1,"replayingFrom":0,"acks":true,"session":{"id":"s1","title":"Deck work","status":"running","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"#

private func corpus(_ name: String) throws -> [String] {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appending(path: "../../../../../crates/core/tests/conformance/\(name).events.jsonl").standardizedFileURL
  return try String(contentsOf: root, encoding: .utf8).split(separator: "\n").map(String.init)
}

private final class Collected: @unchecked Sendable {
  private let lock = NSLock()
  private var effects: [Effect] = []
  func add(_ more: [Effect]) { lock.withLock { effects += more } }
  var all: [Effect] { lock.withLock { effects } }
}

private func eventually(_ what: String, _ check: () -> Bool) async throws {
  for _ in 0..<200 where !check() { try await Task.sleep(for: .milliseconds(10)) }
  #expect(check(), "\(what)")
}

private let metrics = Metrics(cell: 8, line: 16, width: 800, fontSize: 13)

@Test func aReplayThroughTheWorkerDrawsEveryRow() async throws {
  let collected = Collected()
  let worker = SessionWorker(
    session: Session(afterSeq: 0, reconnect: true, nonce: "n", metrics: metrics), onEffects: collected.add)
  worker.opened()
  worker.received(attached)
  for frame in try corpus("tool-result-truncated-and-images") { worker.received(frame) }
  let draw = { try? Snapshots.transcriptFrame(worker.read { $0.transcriptFrame(start: 0, end: 100) }) }
  try await eventually("the folded run") {
    draw()?.lines.rows.joined().contains { $0.text == "Ran 2 tools · 1 browser, 1 shell" } == true
  }
  #expect(collected.all.contains { if case .changed(let c) = $0 { return c.transcript } else { return false } })
  let frame = try #require(draw())
  #expect(!frame.layout.rows.isEmpty)
  #expect(frame.lines.rows.count == frame.layout.rows.count)
  worker.close()
}

@Test func aClosedWorkerIgnoresLateFrames() async throws {
  let collected = Collected()
  let worker = SessionWorker(
    session: Session(afterSeq: 0, reconnect: true, nonce: "n", metrics: metrics), onEffects: collected.add)
  worker.close()
  worker.opened()
  worker.received(attached)
  try await Task.sleep(for: .milliseconds(50))
  #expect(collected.all.isEmpty)
}

@Test func runsComeBackInUtf16Units() throws {
  let session = Session(afterSeq: 0, reconnect: true, nonce: "n", metrics: metrics)
  _ = session.opened()
  _ = session.received(text: attached, now: 0)
  let markdown =
    #"{"type":"event","event":{"type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"😀 **bold** done"}]},"parentToolUseId":null,"uuid":"a-1","seq":1,"ts":1}}"#
  _ = session.received(text: markdown, now: 0)
  let frame = try Snapshots.transcriptFrame(session.transcriptFrame(start: 0, end: 10))
  let line = try #require(frame.lines.rows.joined().first { $0.text.contains("bold") })
  let run = try #require(line.runs.first)
  let utf16 = Array(line.text.utf16)
  #expect(String(decoding: utf16[run.start..<run.end], as: UTF16.self) == "bold")
}
