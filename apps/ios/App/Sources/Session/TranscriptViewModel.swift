import WorkerDeckKit
import Foundation
import Observation

/// Owns one `SessionHandle` and the `TranscriptState` derived from its events.
///
/// Kept view-free on purpose: the whole live-session behaviour (attach, replay,
/// reduce, reconnect, commands) is exercised here, and `SessionView` only renders
/// the result. The event stream is single-consumer, so exactly one `run()` may be
/// in flight — the view's `.task` guarantees that.
@MainActor
@Observable
final class TranscriptViewModel {
  let sessionId: String

  private(set) var state = TranscriptState.initial
  /// WS connectivity, from `connectionChange`. Distinct from session status:
  /// a running session can be temporarily unreachable.
  private(set) var isConnected = false
  /// Snapshot from the most recent `attached` frame.
  private(set) var session: SessionInfo?
  /// Server `PROTOCOL_VERSION` when it disagrees with the mirror in the kit.
  private(set) var protocolMismatch: Int?
  /// Last rejected command, surfaced once rather than logged into the void.
  private(set) var lastProtocolError: String?
  /// Bumped on every applied event — a cheap change signal for auto-scroll that
  /// also fires for streaming deltas (which don't change `items.count`).
  private(set) var revision = 0

  private let client: WorkerClient
  private var handle: SessionHandle?

  init(sessionId: String, client: WorkerClient) {
    self.sessionId = sessionId
    self.client = client
  }

  /// Attach and consume events until the task is cancelled or the stream ends.
  func run() async {
    guard handle == nil else { return }
    // afterSeq 0: full replay, so opening a session mid-run shows its history.
    let handle = client.attach(sessionId: sessionId, afterSeq: 0)
    self.handle = handle
    await withTaskCancellationHandler {
      for await event in handle.events {
        apply(event)
      }
    } onCancel: {
      Task { @MainActor in handle.detach() }
    }
    detach()
  }

  func detach() {
    handle?.detach()
    handle = nil
    isConnected = false
  }

  private func apply(_ event: SessionHandle.Event) {
    switch event {
    case .attached(let frame):
      session = frame.session
      state = seedFromSessionInfo(state, frame.session)
    case .event(let sessionEvent):
      state = applyEvent(state, sessionEvent)
      revision &+= 1
    case .connectionChange(let connected):
      isConnected = connected
    case .protocolError(let message):
      lastProtocolError = message
    case .protocolMismatch(let serverVersion):
      protocolMismatch = serverVersion
    }
  }

  // MARK: - Derived

  var title: String {
    if let title = session?.title, !title.isEmpty { return title }
    if let cwd = state.cwd ?? session?.cwd { return Fmt.lastComponent(cwd) }
    return "Session"
  }

  var cwd: String? { state.cwd ?? session?.cwd }

  /// Engine gate for the permission-mode menu. The snapshot is the only source
  /// (no event carries it); absent reads as claude, per the protocol.
  var engine: ProfileEngine { session?.resolvedEngine ?? state.engine ?? .claude }

  var pendingApproval: PermissionRequest? { state.pendingApprovals.first }

  /// File-store operations bound to this session. Downloads go through the
  /// client rather than the bare URL because the bytes need the auth header.
  var fileAccess: SessionFileAccess {
    let client = client
    let sessionId = sessionId
    return SessionFileAccess(
      list: { try await client.listSessionFiles(sessionId: sessionId) },
      download: { path in
        let data = try await client.fetchSessionFile(sessionId: sessionId, path: path)
        return try SessionFileAccess.writeTemporary(data, named: Fmt.lastComponent(path))
      })
  }

  var rateLimitWindows: [(key: String, info: RateLimitInfo)] {
    // A window with no utilization is unknown, not zero — drop it entirely
    // rather than draw an empty bar that reads as "plenty left".
    (state.rateLimits ?? [:])
      .filter { $0.value.utilization != nil }
      .sorted { $0.key < $1.key }
      .map { (key: $0.key, info: $0.value) }
  }

  // MARK: - Commands

  func send(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    // Nothing is appended locally: the server echoes a `user_message` event and
    // the reducer owns the transcript. Optimistic rows would duplicate.
    handle?.send(trimmed)
  }

  func interrupt() { handle?.interrupt() }

  func approve(_ requestId: String, updatedInput: [String: JSONValue]? = nil) {
    handle?.approve(requestId: requestId, updatedInput: updatedInput)
  }

  func deny(_ requestId: String, message: String? = nil, interrupt: Bool = false) {
    handle?.deny(requestId: requestId, message: message, interrupt: interrupt ? true : nil)
  }

  func setModel(_ model: String?) { handle?.setModel(model) }

  func setPermissionMode(_ mode: PermissionMode) { handle?.setPermissionMode(mode) }

  func closeSession() { handle?.closeSession() }

  /// Skip the reconnect backoff — what returning to the foreground should do.
  func reconnectNow() { handle?.reconnectNow() }

  func dismissProtocolError() { lastProtocolError = nil }
}
