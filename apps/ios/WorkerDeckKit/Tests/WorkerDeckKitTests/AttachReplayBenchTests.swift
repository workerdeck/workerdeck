import Foundation
import Testing

@testable import WorkerDeckKit

/// Where an attach's seconds actually go, measured over a **real** captured
/// replay rather than a synthetic one.
///
/// Written for `_docs/improvements/ios-session-load-time.md`: opening a session
/// takes 2–3s on the phone and under 50ms in VS Code, and the note's first
/// instruction is to measure before designing. The two candidate costs that are
/// pure and therefore measurable off-device are **JSON decode** (`ServerFrame`,
/// once per frame, on the main actor in `SessionHandle`) and the **reducer
/// fold** (`applyEvent`, once per event). Everything else — socket, actor hops,
/// the cold plan — needs the app.
///
/// Opt-in, because it needs a capture:
///
///     pnpm smoke:attach <host> <sessionId> --capture /tmp/attach-big.jsonl
///     WD_ATTACH_CAPTURE=/tmp/attach-big.jsonl swift test --filter AttachReplayBench
///
/// Without the variable it reports that it was skipped and passes, so the suite
/// stays green on a machine with no capture.
@Suite("AttachReplayBench")
struct AttachReplayBenchTests {
  @Test("decode + fold over a captured replay")
  func replayCost() throws {
    guard let path = ProcessInfo.processInfo.environment["WD_ATTACH_CAPTURE"] else {
      print("[bench] skipped — set WD_ATTACH_CAPTURE to a capture from `pnpm smoke:attach --capture`")
      return
    }
    let text = try String(contentsOfFile: path, encoding: .utf8)
    let lines = text.split(separator: "\n").map(String.init)
    let bytes = text.utf8.count
    let decoder = JSONDecoder()

    // Stage 1: decode every frame exactly as `SessionHandle.handle(frame:)` does.
    var frames: [ServerFrame] = []
    frames.reserveCapacity(lines.count)
    let decodeStart = ProcessInfo.processInfo.systemUptime
    for line in lines {
      guard let frame = try? decoder.decode(ServerFrame.self, from: Data(line.utf8)) else { continue }
      frames.append(frame)
    }
    let decodeMs = (ProcessInfo.processInfo.systemUptime - decodeStart) * 1000

    // Stage 2: fold them, exactly as the held replay does.
    var events: [SessionEvent] = []
    for frame in frames { if case .event(let e) = frame { events.append(e) } }
    var state = TranscriptState.initial
    let foldStart = ProcessInfo.processInfo.systemUptime
    for event in events { state = applyEvent(state, event) }
    let foldMs = (ProcessInfo.processInfo.systemUptime - foldStart) * 1000

    print(
      String(
        format:
          "[bench] %d frames / %d KB · decode %.0fms · fold %.0fms (%d events -> %d items)",
        lines.count, bytes / 1024, decodeMs, foldMs, events.count, state.items.count))
  }
}

/// The other half of the same question, and the one the pure benchmark above
/// cannot answer: what the **live pipeline** costs — socket receive, JSON
/// decode, and the main-actor hop per frame — as `SessionHandle` actually runs
/// it, one `await task.receive()` at a time.
///
/// Opt-in against a real gateway, because there is nothing to simulate here:
///
///     WD_ATTACH_HOST=host:8787 WD_ATTACH_SESSION=<id> swift test --filter AttachPipelineBench
///
/// Add `WD_ATTACH_KEY` if the gateway is not running `--insecure-host`.
@Suite("AttachPipelineBench")
struct AttachPipelineBenchTests {
  @Test("live attach, per-stage")
  @MainActor
  func pipelineCost() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let host = env["WD_ATTACH_HOST"], let sessionId = env["WD_ATTACH_SESSION"],
      let base = URL(string: "http://\(host)/v1")
    else {
      print("[bench] skipped — set WD_ATTACH_HOST and WD_ATTACH_SESSION")
      return
    }
    let client = WorkerClient(baseURL: base, authKey: env["WD_ATTACH_KEY"])
    let handle = client.attach(
      sessionId: sessionId, afterSeq: 0, reconnect: false, truncateResults: true, imageRefs: true)
    let started = ProcessInfo.processInfo.systemUptime
    var attachedAt: Double?
    var target = 0
    var events = 0
    var foldSeconds = 0.0
    var state = TranscriptState.initial
    for await event in handle.events {
      switch event {
      case .attached(let frame):
        attachedAt = ProcessInfo.processInfo.systemUptime
        target = frame.session.lastSeq
      case .event(let sessionEvent):
        let t = ProcessInfo.processInfo.systemUptime
        state = applyEvent(state, sessionEvent)
        foldSeconds += ProcessInfo.processInfo.systemUptime - t
        events += 1
        if state.lastSeq >= target, target > 0 { handle.detach() }
      default: break
      }
    }
    let end = ProcessInfo.processInfo.systemUptime
    let replay = (end - (attachedAt ?? started)) * 1000
    print(
      String(
        format:
          "[bench] live · total %.0fms · to attached %.0fms · replay %.0fms "
          + "(fold %.0fms, transport+decode+hop %.0fms) · %d events, %.2fms/event",
        (end - started) * 1000, ((attachedAt ?? started) - started) * 1000, replay,
        foldSeconds * 1000, replay - foldSeconds * 1000, events,
        events > 0 ? (replay - foldSeconds * 1000) / Double(events) : 0))
  }
}
