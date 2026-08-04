import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

// MARK: - Transport seam

/// The socket `SessionHandle` drives. Internal, but `@testable`-visible so tests
/// can feed frames without a live server; production is
/// `URLSessionWebSocketTransport`.
protocol WebSocketConnecting: AnyObject, Sendable {
  /// Start the handshake and return once the socket is open. Throws if it fails.
  func open() async throws
  /// Next text frame. Any throw is treated by the handle as a disconnect.
  /// (The protocol is JSON text; binary frames are skipped.)
  func receive() async throws -> String
  func send(_ text: String) async throws
  /// Idempotent, and unblocks a pending `receive()`/`open()`.
  func close()
}

/// Bridges `URLSessionWebSocketTask`'s delegate callbacks into `open()`.
///
/// A per-task delegate (`URLSessionTask.delegate`) is used so this works with an
/// injected session — including `URLSession.shared`, which has no delegate of
/// its own.
private final class WebSocketOpenObserver: NSObject, URLSessionWebSocketDelegate, @unchecked
  Sendable
{
  // @unchecked: NSObject isn't Sendable and the delegate callbacks arrive on the
  // session's delegate queue, so the mutable state is guarded by `lock` instead.
  private let lock = NSLock()
  private var outcome: Result<Void, any Error>?
  private var continuation: CheckedContinuation<Void, any Error>?

  func wait() async throws {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        lock.lock()
        if let outcome {
          lock.unlock()
          continuation.resume(with: outcome)
        } else {
          self.continuation = continuation
          lock.unlock()
        }
      }
    } onCancel: {
      settle(.failure(CancellationError()))
    }
  }

  /// First call wins; later ones (e.g. `didComplete` after `didOpen`) are ignored.
  func settle(_ result: Result<Void, any Error>) {
    lock.lock()
    guard outcome == nil else {
      lock.unlock()
      return
    }
    outcome = result
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(with: result)
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    settle(.success(()))
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    settle(
      .failure(
        WorkerClientError(message: "WebSocket closed (code \(closeCode.rawValue))")))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    settle(.failure(error ?? WorkerClientError(message: "WebSocket completed")))
  }
}

/// Production transport: a `URLSessionWebSocketTask` carrying the handshake
/// headers `WorkerClient` put on the request (native clients authenticate with
/// `Authorization`, not a cookie).
final class URLSessionWebSocketTransport: WebSocketConnecting {
  private let task: URLSessionWebSocketTask
  private let observer = WebSocketOpenObserver()

  init(request: URLRequest, urlSession: URLSession) {
    task = urlSession.webSocketTask(with: request)
    task.delegate = observer
  }

  func open() async throws {
    task.resume()
    // Safety net: if the delegate never reports the upgrade (a proxy or a stack
    // that doesn't deliver `didOpenWithProtocol`), proceed optimistically rather
    // than hang — outbound frames are buffered by URLSession until the socket is
    // live anyway, and a truly dead socket still surfaces on the first receive.
    let fallback = Task { [observer] in
      try? await Task.sleep(for: .seconds(5))
      guard !Task.isCancelled else { return }
      observer.settle(.success(()))
    }
    defer { fallback.cancel() }
    try await observer.wait()
  }

  func receive() async throws -> String {
    while true {
      switch try await task.receive() {
      case .string(let text): return text
      case .data: continue
      @unknown default: continue
      }
    }
  }

  func send(_ text: String) async throws {
    try await task.send(.string(text))
  }

  func close() {
    task.cancel(with: .goingAway, reason: nil)
    observer.settle(.failure(WorkerClientError(message: "WebSocket closed by client")))
  }
}

// MARK: - Session handle

/// A live connection to one session: replayed + live events out, commands in.
///
/// Swift port of `SessionHandle` (packages/client/src/index.ts), shaped for
/// SwiftUI: main-actor isolated, with a single-consumer `AsyncStream` of events.
///
/// The handle keeps itself alive while its socket is open — call `detach()` when
/// the view goes away, or `closeSession()` to terminate the session too.
@MainActor
public final class SessionHandle {
  /// Everything the handle reports. One stream, one consumer: iterate `events`
  /// once (e.g. from a `.task` modifier) and fan out from there.
  public enum Event: Sendable, Equatable {
    /// Fired on every (re)attach with the server's session snapshot.
    case attached(AttachedFrame)
    /// Every session event, replayed and live, in `seq` order, deduped.
    case event(SessionEvent)
    /// WS connectivity: true on open, false on close.
    case connectionChange(Bool)
    /// The server rejected a command frame. The socket stays up.
    case protocolError(String)
    /// The server speaks a different `PROTOCOL_VERSION` than `WorkerProtocol.version`.
    /// A warning, not a disconnect — decoding is lenient by design.
    case protocolMismatch(serverVersion: Int)
  }

  public let sessionId: String
  /// Highest event `seq` seen. A reconnect resumes from here, so no event is
  /// replayed twice and none is lost across a drop.
  public private(set) var lastSeq: Int
  public let events: AsyncStream<Event>

  private let continuation: AsyncStream<Event>.Continuation
  private let makeSocket: @Sendable (Int) throws -> any WebSocketConnecting
  private let reconnect: Bool
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  private var socket: (any WebSocketConnecting)?
  private var loop: Task<Void, Never>?
  private var backoff: Task<Void, Never>?
  /// Commands raised while disconnected, flushed in order once the socket opens.
  private var outbox: [String] = []
  private var flushing = false
  private var closeAfterFlush = false
  private var connected = false
  private var detached = false
  private var retries = 0

  init(
    sessionId: String,
    afterSeq: Int = 0,
    reconnect: Bool = true,
    makeSocket: @escaping @Sendable (Int) throws -> any WebSocketConnecting
  ) {
    self.sessionId = sessionId
    self.lastSeq = afterSeq
    self.reconnect = reconnect
    self.makeSocket = makeSocket
    let (stream, continuation) = AsyncStream<Event>.makeStream()
    self.events = stream
    self.continuation = continuation
    startLoop()
  }

  deinit {
    continuation.finish()
  }

  // MARK: Commands

  /// Send a user turn.
  public func send(_ text: String) {
    enqueue(.userMessage(text: text))
  }

  /// Approve a pending permission request, optionally rewriting the tool input.
  public func approve(requestId: String, updatedInput: [String: JSONValue]? = nil) {
    enqueue(
      .permissionDecision(requestId: requestId, behavior: .allow, updatedInput: updatedInput))
  }

  /// Deny a pending permission request. `interrupt` also stops the current turn.
  public func deny(requestId: String, message: String? = nil, interrupt: Bool? = nil) {
    enqueue(
      .permissionDecision(
        requestId: requestId, behavior: .deny, message: message, interrupt: interrupt))
  }

  /// Stop the current turn.
  public func interrupt() {
    enqueue(.interrupt)
  }

  public func setPermissionMode(_ mode: PermissionMode) {
    enqueue(.setPermissionMode(mode))
  }

  /// Switch the model for subsequent responses; nil restores the server default.
  public func setModel(_ model: String?) {
    enqueue(.setModel(model))
  }

  /// Ask the server to terminate the session, then detach. When the socket is
  /// open the `close` command is flushed first; when it isn't, the handle simply
  /// detaches (a queued command dies with the handle, as in the reference client).
  public func closeSession() {
    enqueue(.close)
    if connected {
      closeAfterFlush = true
    } else {
      detach()
    }
  }

  /// Disconnect this handle without touching the session: cancels the reconnect
  /// loop, closes the socket, and finishes `events`. Not reversible.
  public func detach() {
    guard !detached else { return }
    detached = true
    backoff?.cancel()
    backoff = nil
    loop?.cancel()
    loop = nil
    socket?.close()
    socket = nil
    if connected {
      connected = false
      continuation.yield(.connectionChange(false))
    }
    continuation.finish()
  }

  /// Reconnect immediately instead of waiting out the backoff — what the app
  /// calls when it returns to the foreground or the network path changes.
  /// No-op while connected or after `detach()`.
  public func reconnectNow() {
    guard !detached, !connected else { return }
    retries = 0
    backoff?.cancel()
  }

  // MARK: Connection loop

  private func startLoop() {
    loop = Task { [weak self] in
      while true {
        guard let self, !self.detached else { return }
        await self.connectOnce()
        guard !self.detached else { return }
        guard self.reconnect else {
          // Nothing more will ever arrive on this handle.
          self.continuation.finish()
          return
        }
        let delay = min(0.5 * pow(2, Double(self.retries)), 10)
        self.retries += 1
        await self.sleepBackoff(delay)
      }
    }
  }

  private func connectOnce() async {
    var opened = false
    var current: (any WebSocketConnecting)?
    do {
      let socket = try makeSocket(lastSeq)
      current = socket
      self.socket = socket
      try await socket.open()
      guard !detached else {
        socket.close()
        return
      }
      opened = true
      retries = 0
      connected = true
      continuation.yield(.connectionChange(true))
      flushOutbox()
      while !detached {
        handle(frame: try await socket.receive())
      }
    } catch {
      // Any failure — handshake, receive, or cancellation — is a disconnect.
    }
    connected = false
    current?.close()
    if socket === current { socket = nil }
    if opened {
      continuation.yield(.connectionChange(false))
    }
  }

  private func sleepBackoff(_ seconds: Double) async {
    let timer = Task { _ = try? await Task.sleep(for: .seconds(seconds)) }
    backoff = timer
    await timer.value
    backoff = nil
  }

  // MARK: Frames

  private func handle(frame text: String) {
    guard let frame = try? decoder.decode(ServerFrame.self, from: Data(text.utf8)) else { return }
    switch frame {
    case .attached(let attached):
      continuation.yield(.attached(attached))
      if attached.protocolVersion != WorkerProtocol.version {
        continuation.yield(.protocolMismatch(serverVersion: attached.protocolVersion))
      }
    case .event(let event):
      // Replay dedupe: a reconnect resumes at `lastSeq`, but a server that
      // replays generously must never surface the same event twice.
      guard event.seq > lastSeq else { return }
      lastSeq = event.seq
      continuation.yield(.event(event))
    case .toolCallRequest(let request):
      // This client hosts no sandbox. Answer immediately rather than let the
      // server's watchdog expire the call — the failure is fed to the model as
      // tool output, so the agent adapts instead of stalling.
      enqueue(
        .toolCallError(
          executionId: request.executionId,
          reason: "unsupported",
          error:
            "This client cannot execute bridged tool calls: it has no sandbox. "
            + "Run the tool server-side, or attach a browser client to host it."))
    case .toolCallCanceled:
      // Nothing was started, so nothing to abandon.
      break
    case .protocolError(let message):
      continuation.yield(.protocolError(message))
    case .unknown:
      // A frame type this mirror doesn't model — ignore, never an error.
      break
    }
  }

  // MARK: Outbox

  private func enqueue(_ command: SessionCommand) {
    guard let data = try? encoder.encode(command) else { return }
    outbox.append(String(decoding: data, as: UTF8.self))
    flushOutbox()
  }

  /// Drains the outbox through the socket one frame at a time. Everything goes
  /// through the outbox — even while connected — so command order survives the
  /// hop onto the socket's async send.
  private func flushOutbox() {
    guard !flushing, connected, let socket else { return }
    flushing = true
    Task {
      defer { self.flushing = false }
      while self.connected, let payload = self.outbox.first {
        do {
          try await socket.send(payload)
        } catch {
          break  // stays queued for the next open
        }
        if !self.outbox.isEmpty { self.outbox.removeFirst() }
      }
      if self.closeAfterFlush, self.outbox.isEmpty {
        self.closeAfterFlush = false
        self.detach()
      }
    }
  }
}
