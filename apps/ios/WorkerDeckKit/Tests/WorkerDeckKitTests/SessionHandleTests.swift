import Foundation
import Testing

@testable import WorkerDeckKit

// MARK: - Fake transport

private enum FakeSocketError: Error { case closed }

/// Scriptable `WebSocketConnecting`: `push` delivers a server frame, `sent`
/// records what the handle wrote, and `gated` holds the handshake open so a test
/// can queue commands "while disconnected".
private final class FakeWebSocket: WebSocketConnecting {
  private let lock = NSLock()
  private let gated: Bool
  // nonisolated(unsafe): every access below is inside `lock`.
  nonisolated(unsafe) private var opened = false
  nonisolated(unsafe) private var closed = false
  nonisolated(unsafe) private var inbox: [String] = []
  nonisolated(unsafe) private var sentFrames: [String] = []
  nonisolated(unsafe) private var receiver: CheckedContinuation<String, any Error>?
  nonisolated(unsafe) private var opener: CheckedContinuation<Void, any Error>?

  init(gated: Bool = false) {
    self.gated = gated
  }

  var sent: [String] { lock.withLock { sentFrames } }
  var isClosed: Bool { lock.withLock { closed } }

  func open() async throws {
    guard gated else {
      lock.withLock { opened = true }
      return
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      lock.lock()
      if closed {
        lock.unlock()
        continuation.resume(throwing: FakeSocketError.closed)
      } else if opened {
        lock.unlock()
        continuation.resume()
      } else {
        opener = continuation
        lock.unlock()
      }
    }
  }

  /// Complete a gated handshake.
  func completeOpen() {
    lock.lock()
    opened = true
    let pending = opener
    opener = nil
    lock.unlock()
    pending?.resume()
  }

  /// Deliver a server frame.
  func push(_ text: String) {
    lock.lock()
    if let receiver {
      self.receiver = nil
      lock.unlock()
      receiver.resume(returning: text)
      return
    }
    inbox.append(text)
    lock.unlock()
  }

  func receive() async throws -> String {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, any Error>) in
      lock.lock()
      if closed {
        lock.unlock()
        continuation.resume(throwing: FakeSocketError.closed)
      } else if !inbox.isEmpty {
        let text = inbox.removeFirst()
        lock.unlock()
        continuation.resume(returning: text)
      } else {
        receiver = continuation
        lock.unlock()
      }
    }
  }

  func send(_ text: String) async throws {
    try lock.withLock {
      if closed { throw FakeSocketError.closed }
      sentFrames.append(text)
    }
  }

  func close() {
    lock.lock()
    closed = true
    let pendingReceive = receiver
    let pendingOpen = opener
    receiver = nil
    opener = nil
    lock.unlock()
    pendingReceive?.resume(throwing: FakeSocketError.closed)
    pendingOpen?.resume(throwing: FakeSocketError.closed)
  }
}

/// Hands out a scripted socket per connect attempt and records the `afterSeq`
/// each attempt resumed from.
private final class SocketFactory: @unchecked Sendable {
  private let lock = NSLock()
  private var queue: [FakeWebSocket]
  private var recorded: [Int] = []

  init(_ sockets: [FakeWebSocket]) {
    queue = sockets
  }

  var afterSeqs: [Int] { lock.withLock { recorded } }

  func make(_ afterSeq: Int) -> FakeWebSocket {
    lock.lock()
    defer { lock.unlock() }
    recorded.append(afterSeq)
    return queue.isEmpty ? FakeWebSocket() : queue.removeFirst()
  }
}

// MARK: - Harness

@MainActor
private final class EventLog {
  private(set) var events: [SessionHandle.Event] = []
  private(set) var finished = false

  init(_ handle: SessionHandle) {
    let stream = handle.events
    Task {
      for await event in stream { self.events.append(event) }
      self.finished = true
    }
  }

  var sessionEvents: [SessionEvent] {
    events.compactMap { if case .event(let event) = $0 { return event } else { return nil } }
  }
}

@MainActor
private func waitUntil(
  _ label: String, timeout: Duration = .seconds(2), _ condition: () -> Bool
) async throws {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while !condition() {
    if ContinuousClock.now > deadline {
      Issue.record("timed out waiting for \(label)")
      return
    }
    try await Task.sleep(for: .milliseconds(2))
  }
}

private func attachedFrame(protocolVersion: Int) -> String {
  """
  {"type":"attached","protocolVersion":\(protocolVersion),"replayingFrom":0,
   "session":{"id":"s1","status":"running","cwd":"/repo","createdAt":1,"lastSeq":0,
   "pendingPermissionCount":0}}
  """
}

private func eventFrame(seq: Int) -> String {
  #"{"type":"event","event":{"type":"status_changed","status":"idle","seq":\#(seq),"ts":1}}"#
}

private func decodeJSON(_ text: String) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

// MARK: - Tests

@Suite("SessionHandle")
@MainActor
struct SessionHandleTests {
  private func makeHandle(
    _ socket: FakeWebSocket, afterSeq: Int = 0, reconnect: Bool = false
  ) -> SessionHandle {
    SessionHandle(sessionId: "s1", afterSeq: afterSeq, reconnect: reconnect) { _ in socket }
  }

  @Test func emitsAttachedFrameOnConnect() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    let log = EventLog(handle)
    defer { handle.detach() }

    try await waitUntil("open") { log.events.contains(.connectionChange(true)) }
    socket.push(attachedFrame(protocolVersion: WorkerProtocol.version))

    try await waitUntil("attached") { log.events.count >= 2 }
    guard case .attached(let frame) = log.events[1] else {
      Issue.record("expected attached, got \(log.events)")
      return
    }
    #expect(frame.protocolVersion == WorkerProtocol.version)
    #expect(frame.session.id == "s1")
    // A matching version must not produce a mismatch warning.
    #expect(!log.events.contains(.protocolMismatch(serverVersion: WorkerProtocol.version)))
  }

  @Test func warnsOnProtocolMismatchWithoutDisconnecting() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    let log = EventLog(handle)
    defer { handle.detach() }

    socket.push(attachedFrame(protocolVersion: WorkerProtocol.version + 1))

    try await waitUntil("mismatch") {
      log.events.contains(.protocolMismatch(serverVersion: WorkerProtocol.version + 1))
    }
    #expect(!socket.isClosed)
    #expect(!log.finished)
  }

  @Test func dedupesReplayedEventsBySeq() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    let log = EventLog(handle)
    defer { handle.detach() }

    socket.push(eventFrame(seq: 1))
    socket.push(eventFrame(seq: 2))
    try await waitUntil("two events") { log.sessionEvents.count == 2 }
    #expect(handle.lastSeq == 2)

    // A reconnect replays generously — the same seqs must not surface twice.
    socket.push(eventFrame(seq: 1))
    socket.push(eventFrame(seq: 2))
    socket.push(eventFrame(seq: 3))
    try await waitUntil("third event") { log.sessionEvents.count == 3 }
    #expect(log.sessionEvents.map(\.seq) == [1, 2, 3])
    #expect(handle.lastSeq == 3)
  }

  @Test func honorsAfterSeqAsTheStartingWatermark() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket, afterSeq: 5)
    let log = EventLog(handle)
    defer { handle.detach() }

    socket.push(eventFrame(seq: 4))
    socket.push(eventFrame(seq: 6))
    try await waitUntil("event 6") { log.sessionEvents.count == 1 }
    #expect(log.sessionEvents.map(\.seq) == [6])
  }

  @Test func flushesQueuedCommandsInOrderOnOpen() async throws {
    let socket = FakeWebSocket(gated: true)
    let handle = makeHandle(socket)
    defer { handle.detach() }

    handle.send("first")
    handle.interrupt()
    handle.setPermissionMode(.acceptEdits)
    #expect(socket.sent.isEmpty)

    socket.completeOpen()

    try await waitUntil("flush") { socket.sent.count == 3 }
    #expect(
      try socket.sent.map(decodeJSON) == [
        ["type": "user_message", "text": "first"],
        ["type": "interrupt"],
        ["type": "set_permission_mode", "mode": "acceptEdits"],
      ])
  }

  @Test func encodesUserMessageCommandOnTheWire() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    defer { handle.detach() }

    handle.send("hello")

    try await waitUntil("sent") { socket.sent.count == 1 }
    #expect(try decodeJSON(socket.sent[0]) == ["type": "user_message", "text": "hello"])
  }

  @Test func answersBridgedToolCallsItCannotRun() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    defer { handle.detach() }

    socket.push(
      #"{"type":"tool_call_request","executionId":"exec_1","toolName":"Bash","input":{}}"#)

    try await waitUntil("reply") { socket.sent.count == 1 }
    let reply = try decodeJSON(socket.sent[0])
    #expect(reply["type"] == "tool_call_error")
    #expect(reply["executionId"] == "exec_1")
    #expect(reply["reason"] == "unsupported")
    #expect(reply["error"]?.stringValue?.isEmpty == false)
  }

  @Test func ignoresCanceledAndUnknownFrames() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    let log = EventLog(handle)
    defer { handle.detach() }

    socket.push(#"{"type":"tool_call_canceled","executionId":"exec_1","reason":"timeout"}"#)
    socket.push(#"{"type":"something_new","payload":{}}"#)
    socket.push("not json at all")
    socket.push(eventFrame(seq: 1))

    try await waitUntil("event") { log.sessionEvents.count == 1 }
    #expect(socket.sent.isEmpty)
    #expect(log.events.filter { $0 == .connectionChange(true) }.count == 1)
  }

  @Test func surfacesProtocolErrors() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    let log = EventLog(handle)
    defer { handle.detach() }

    socket.push(#"{"type":"protocol_error","message":"unknown command"}"#)

    try await waitUntil("protocol error") {
      log.events.contains(.protocolError("unknown command"))
    }
    #expect(!log.finished)
  }

  @Test func detachClosesTheSocketAndFinishesTheStream() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    let log = EventLog(handle)

    try await waitUntil("open") { log.events.contains(.connectionChange(true)) }
    handle.detach()

    try await waitUntil("stream finished") { log.finished }
    #expect(socket.isClosed)
    #expect(log.events.last == .connectionChange(false))

    // Detach is terminal: nothing reconnects, nothing new is emitted.
    let countAfterDetach = log.events.count
    socket.push(eventFrame(seq: 9))
    try await Task.sleep(for: .milliseconds(20))
    #expect(log.events.count == countAfterDetach)
    #expect(handle.lastSeq == 0)
  }

  @Test func reconnectsAndResumesFromLastSeq() async throws {
    let first = FakeWebSocket()
    let factory = SocketFactory([first, FakeWebSocket()])
    let handle = SessionHandle(sessionId: "s1", reconnect: true) { factory.make($0) }
    let log = EventLog(handle)
    defer { handle.detach() }

    try await waitUntil("open") { log.events.contains(.connectionChange(true)) }
    first.push(eventFrame(seq: 4))
    try await waitUntil("event") { handle.lastSeq == 4 }

    first.close()  // the server drops the socket
    // `contains`, not `last`: the retry counter is emitted right behind the drop.
    try await waitUntil("disconnect") { log.events.contains(.connectionChange(false)) }
    handle.reconnectNow()  // skip the backoff, as foregrounding does

    try await waitUntil("resume") { factory.afterSeqs.count == 2 }
    #expect(factory.afterSeqs == [0, 4])
    try await waitUntil("reconnected") { log.events.last == .connectionChange(true) }
  }

  @Test func countsFailedReconnectAttemptsSoTheUiCanEscalate() async throws {
    // A socket that never opens: the handle keeps retrying forever, so the only
    // honest signal for "offline" is how far the counter has climbed.
    let handle = SessionHandle(sessionId: "s1", reconnect: true) { _ in
      throw FakeSocketError.closed
    }
    let log = EventLog(handle)
    defer { handle.detach() }

    try await waitUntil("second attempt") { log.events.contains(.reconnectAttempt(2)) }
    // Nothing ever opened, so there is no connectionChange to pair it with —
    // which is exactly why the counter is its own event.
    #expect(!log.events.contains(.connectionChange(true)))

    // Foregrounding restarts the count rather than leaving the UI pessimistic.
    handle.reconnectNow()
    try await waitUntil("counter reset") { log.events.contains(.reconnectAttempt(0)) }
  }

  @Test func closeSessionSendsCloseThenDetaches() async throws {
    let socket = FakeWebSocket()
    let handle = makeHandle(socket)
    let log = EventLog(handle)

    try await waitUntil("open") { log.events.contains(.connectionChange(true)) }
    handle.closeSession()

    try await waitUntil("close sent") { socket.sent.count == 1 }
    #expect(try decodeJSON(socket.sent[0]) == ["type": "close"])
    try await waitUntil("stream finished") { log.finished }
    #expect(socket.isClosed)
  }
}
