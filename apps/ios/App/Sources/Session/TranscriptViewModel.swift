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
  /// WS connectivity, from `connectionChange` and the handle's retry counter.
  /// Distinct from session status: a running session can be temporarily
  /// unreachable — and while it is, the status the app holds is stale.
  private(set) var connection = ConnectionState.reconnecting
  /// Snapshot from the most recent `attached` frame.
  private(set) var session: SessionInfo?
  /// Server `PROTOCOL_VERSION` when it disagrees with the mirror in the kit.
  private(set) var protocolMismatch: Int?
  /// Last rejected command, surfaced once rather than logged into the void.
  private(set) var lastProtocolError: String?
  /// Bumped on every applied event — a cheap change signal for auto-scroll that
  /// also fires for streaming deltas (which don't change `items.count`).
  private(set) var revision = 0
  /// When a rate-limit window last arrived. Local receipt time, not the event's
  /// `ts`: what the usage sheet's freshness line answers is "how stale is what
  /// I'm looking at", and replayed events would date that to the session's start.
  private(set) var rateLimitsUpdatedAt: Date?
  /// What "default" actually resolved to for this session, captured from
  /// `system_init` — which the CLI sends once, before any `set_model` of ours can
  /// have moved it. This is the only way to *name* the default: nothing asks the
  /// CLI "which model would you pick", so the answer is the one it did pick.
  /// Nil until init, which for a promptless session is until the first message.
  private(set) var initModel: String?
  private(set) var defaultPermissionMode: PermissionMode?

  /// What the session's default resolves to. `capabilities` knows it before the
  /// first turn (the CLI's own `default` row says what it points at); the model
  /// reported at `system_init` is the same answer arriving later, and is the
  /// fallback for a server too old to send the first.
  var defaultModel: String? { state.defaultModel ?? initModel }

  /// The model this session answers as — the one it reported, or, before it has
  /// reported anything, the default it will use. A running session always has a
  /// concrete model; this is what makes that true from the first frame.
  var effectiveModel: String? { state.model ?? defaultModel }

  /// The engine's static catalog for this session's profile, fetched once on
  /// attach. Only a fallback, never an override — see {@link availableModels}.
  private(set) var catalogModels: [ModelOption] = []

  /// What the model picker offers.
  ///
  /// Two sources, and which one is authoritative depends on the engine. The
  /// `capabilities` event is the CLI asked what it supports, so for claude it
  /// wins. Codex never sends one — its models are a catalog shipped with the
  /// release and served on the profile — so without this fallback its picker is
  /// permanently empty and the session cannot be switched at all.
  var availableModels: [ModelOption] {
    if let reported = state.models, !reported.isEmpty { return reported }
    return catalogModels
  }

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
    connection = .reconnecting
  }

  private func apply(_ event: SessionHandle.Event) {
    switch event {
    case .attached(let frame):
      session = frame.session
      state = seedFromSessionInfo(state, frame.session)
      loadCatalogModels(for: frame.session.profile)
    case .event(let sessionEvent):
      state = applyEvent(state, sessionEvent)
      revision &+= 1
      if case .rateLimit = sessionEvent.body { rateLimitsUpdatedAt = Date() }
      if case .systemInit(let info) = sessionEvent.body, initModel == nil {
        initModel = info.model
        defaultPermissionMode = info.permissionMode
      }
    case .connectionChange(let connected):
      connection = connected ? .live : .reconnecting
    case .reconnectAttempt(let attempts):
      // The handle retries forever, so "offline" is a judgement about how long
      // it has been failing, not a state it reports. Three in a row is ~3.5s of
      // backoff — past a blip, and the point where "Reconnecting…" stops being
      // the honest word.
      connection = attempts >= 3 ? .offline : .reconnecting
    case .protocolError(let message):
      lastProtocolError = message
    case .protocolMismatch(let serverVersion):
      protocolMismatch = serverVersion
    }
  }

  /// Fetch this session's profile catalog, once, and only when it could matter.
  ///
  /// Fire-and-forget on purpose: an empty catalog is exactly the state the picker
  /// already handles, so a failed or 404'd `/profiles` (a server predating
  /// profiles) degrades to today's behavior rather than surfacing an error about
  /// a list the person may never open.
  private func loadCatalogModels(for profileName: String?) {
    guard catalogModels.isEmpty, let profileName else { return }
    Task { @MainActor [weak self] in
      guard let self else { return }
      guard let response = try? await self.client.listProfiles() else { return }
      self.catalogModels = response.profiles.first { $0.name == profileName }?.models ?? []
    }
  }

  // MARK: - Derived

  var title: String {
    if let title = session?.title, !title.isEmpty { return title }
    if let cwd = state.cwd ?? session?.cwd { return Fmt.lastComponent(cwd) }
    return "Session"
  }

  var cwd: String? { state.cwd ?? session?.cwd }

  /// Host-file access scoped to this session's working directory, or nil until the
  /// cwd is known. Browsing is deliberately session-scoped: the server's roots are
  /// the security boundary, but what a person wants on a phone is *this* project's
  /// tree, so the app never offers the roots list.
  var hostFiles: HostFileScope? {
    guard let cwd else { return nil }
    return HostFileScope(client: client, cwd: cwd)
  }

  /// Engine gate for the permission-mode menu. The snapshot is the only source
  /// (no event carries it); absent reads as claude, per the protocol.
  var engine: ProfileEngine { session?.resolvedEngine ?? state.engine ?? .claude }

  /// The capability record the session surface renders around: the
  /// runner-reported copy from the attach snapshot when present, else the
  /// engine's static default. Gates the MCP screens, the usage/context menu
  /// items, and the permission-mode list.
  var capabilities: EngineCapabilities {
    session?.resolvedCapabilities ?? engine.defaultCapabilities
  }

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

  /// The status bar's usage rings, in reading order: the session window, the
  /// weekly window, then whichever per-model weekly windows this session reports.
  ///
  /// Discovered rather than hardcoded — the SDK's set of windows is an open union
  /// and has grown before — but ordered, so the first two rings always mean the
  /// same thing. Three is the cap: it is what a subscription session reports today
  /// and what fits a phone-width bar beside the model and permission chips. A
  /// session reporting none of them (an API-key session, or one before its first
  /// turn) gets no rings at all, and the bar shows cost instead.
  var hudRateLimits: [(key: String, info: RateLimitInfo)] {
    let windows = rateLimitWindows
    let named = ["five_hour", "seven_day"].compactMap { key in
      windows.first { $0.key == key }
    }
    let perModel = windows.filter { $0.key.hasPrefix("seven_day_") }
    return Array((named + perModel).prefix(3))
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

  /// Send a turn. `attachmentIds` come from the composer's staging area, which
  /// uploaded them as they were picked — a message may be attachments alone.
  func send(_ text: String, attachmentIds: [String] = []) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty || !attachmentIds.isEmpty else { return }
    // Nothing is appended locally: the server echoes a `user_message` event and
    // the reducer owns the transcript. Optimistic rows would duplicate.
    handle?.send(trimmed, attachmentIds: attachmentIds)
  }

  /// Upload one file for the next message; the returned id is what `send` names.
  func uploadAttachment(name: String, mediaType: String, data: Data) async throws
    -> MessageAttachment
  {
    try await client.uploadAttachment(
      sessionId: sessionId, name: name, mediaType: mediaType, data: data)
  }

  /// Bytes for an attachment already in the transcript (thumbnails).
  func attachmentData(_ attachmentId: String) async throws -> Data {
    try await client.fetchAttachment(sessionId: sessionId, attachmentId: attachmentId)
  }

  /// Bytes of a file this session's engine produced (a generated image). Needs
  /// no host-file roots — see `readProducedFile`.
  func producedFileData(_ fileId: String) async throws -> Data {
    try await client.readProducedFile(sessionId: sessionId, fileId: fileId)
  }

  /// The session's MCP servers, live from the engine.
  func mcpServers() async throws -> [McpServerStatusInfo] {
    try await client.listMcpServers(sessionId: sessionId)
  }

  func mcpAction(_ serverName: String, _ action: McpServerActionRequest.Action) async throws
    -> [McpServerStatusInfo]
  {
    try await client.mcpServerAction(sessionId: sessionId, serverName: serverName, action: action)
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
