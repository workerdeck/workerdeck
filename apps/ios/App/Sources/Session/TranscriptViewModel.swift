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

  /// What the UI renders. **Not** what the replay is folding into — see
  /// `replayBuffer`.
  private(set) var state = TranscriptState.initial
  /// Where a held replay's events are reduced, published in one step when the
  /// hold ends.
  ///
  /// The transcript was already held (`replaying`), but a session screen is more
  /// than its transcript: approvals, the question prompt, the context and usage
  /// readings, the composer's busy state and the empty state all read this same
  /// reduced state, so a replay drove *every one of them* through the session's
  /// entire history on the way past — a permission prompt for a decision made an
  /// hour ago flashing up and vanishing, meters counting themselves up, the
  /// empty state appearing and going. Holding one view was never the fix;
  /// holding the **state** is, and it deletes the question of which views
  /// remembered to opt in.
  private var replayBuffer: TranscriptState?
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
  /// True while the initial attach replay is still landing.
  ///
  /// The transcript is not drawn while this holds — see `ReplayHold.swift`. It
  /// is derived from a stated seq rather than detected from arrival timing, so
  /// it flips exactly once, on the event that completes the replay.
  private(set) var replaying = false
  /// How far the held replay has got, for the placeholder to say so.
  ///
  /// A hold that ends on the stated seq is honest about *when* it ends and
  /// silent about how long that will take, and on a phone attaching to a long
  /// session over a network that silence is seconds of blank screen. The
  /// numbers are already here; not showing them was the omission.
  private(set) var replayProgress: (seq: Int, target: Int)?
  /// When `replayProgress` was last published, so it can be published *rarely*.
  ///
  /// This is the whole of the phone's session-open cost, and it was invisible
  /// until the counter was put on screen. `replayHold` mutates on **every**
  /// applied event; observed, that is one SwiftUI invalidation per event, and
  /// the placeholder — a spinner and a formatted counter — re-laid out 800
  /// times while the replay landed. Measured on a real session: 1,533ms of
  /// which the reducer fold was 6ms. The same replay costs 33ms on a Mac with
  /// no SwiftUI attached to it, which is the 37x nobody could explain.
  ///
  /// So the hold's own state is `@ObservationIgnored` and exact, and what the
  /// screen watches is a throttled copy. A counter is a reassurance that
  /// something is happening; it does not need every value, and it must not cost
  /// more than the thing it reports on.
  @ObservationIgnored private var progressPublishedAt = 0.0
  @ObservationIgnored private var replayHold: ReplayHold?
  @ObservationIgnored private var replayBackstop: Task<Void, Never>?
  /// Stage timings for the attach in flight — see `AttachProfile`. Measurement
  /// scaffolding for `_docs/improvements/ios-session-load-time.md`.
  private var profile: AttachProfile?
  /// The gateway's per-account usage for this session's profile, polled while
  /// the session is on screen. The profile tracker folds in every session's
  /// `rate_limit` events, so this session's own reading can be hours stale the
  /// moment another session burns the window — see `usageWindows`.
  private(set) var profileUsage: ProfileUsage?
  @ObservationIgnored private var usagePollTask: Task<Void, Never>?
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

  /// Where each event's rows landed, for the push deep link — see
  /// `TranscriptSeqIndex`. `@ObservationIgnored` because nothing renders it:
  /// observed, it would invalidate every view watching this model once per
  /// applied event, which is the exact cost `replayProgress` was throttled to
  /// avoid.
  @ObservationIgnored private var seqIndex = TranscriptSeqIndex()

  private let client: WorkerClient
  private var handle: SessionHandle?
  /// Screens currently holding this session open — the session view, plus its
  /// sub-agent takeover while one is pushed. See `holdOpen()`.
  @ObservationIgnored private var screenClaims = 0
  /// The one attach loop, owned here rather than by a view's `.task` — see
  /// `holdOpen()` for why a view's task cannot own it any more.
  @ObservationIgnored private var attachTask: Task<Void, Never>?
  /// Fired on the claim count's 0→1 and 1→0 transitions — "this session came on
  /// screen" / "this session left the screen". The seam the session view hangs
  /// the notification-suppression claim and the unread truing-up on, because
  /// the claim transitions are the only ordering-safe place: during a push or a
  /// pop both screens' appear/disappear events fire, interleaved, and any
  /// per-view release races the other view's claim.
  @ObservationIgnored var onScreenPresence: ((Bool) -> Void)?
  /// Tool results whose rest is in flight — one fetch per row, however many
  /// times it is pressed.
  private var fetchingResults: Set<String> = []

  init(sessionId: String, client: WorkerClient) {
    self.sessionId = sessionId
    self.client = client
  }

  /// Hold the session's one attach open for as long as the calling view is on
  /// screen. Awaited from a `.task` by **both** the session view and the
  /// sub-agent takeover pushed over it.
  ///
  /// Claim-counted because of a fact that was measured, not assumed: on iOS a
  /// `NavigationStack` push fires the covered view's `onDisappear` and cancels
  /// its `.task` about half a second later, at the end of the push animation.
  /// So `SessionView.task { await vm.run() }` — the old shape — would detach
  /// the socket under the takeover, freezing exactly the surface that exists
  /// for watching an agent work, and re-attach with a replay spinner on the way
  /// back. The two views' appearances overlap in both directions (the incoming
  /// view's task starts at the transition's start, the outgoing one's dies at
  /// its end), so the count never touches zero across a push or a pop — and a
  /// path reset that removes both views really does drain it, which is the one
  /// case that must detach.
  ///
  /// A new first claim awaits the previous loop's teardown before attaching, so
  /// `run()`'s one-attach guard can never eat a legitimate re-open.
  func holdOpen() async {
    screenClaims += 1
    if screenClaims == 1 {
      onScreenPresence?(true)
      let previous = attachTask
      attachTask = Task { [weak self] in
        await previous?.value
        await self?.run()
      }
    }
    defer {
      screenClaims -= 1
      if screenClaims == 0 {
        attachTask?.cancel()
        attachTask = nil
        onScreenPresence?(false)
      }
    }
    // Park until the view's `.task` is cancelled; the sleep throws immediately
    // on cancellation, and the defer above settles the claim on this actor.
    while !Task.isCancelled {
      try? await Task.sleep(for: .seconds(3600))
    }
  }

  /// Attach and consume events until the task is cancelled or the stream ends.
  func run() async {
    guard handle == nil else { return }
    // afterSeq 0: full replay, so opening a session mid-run shows its history.
    // `truncateResults` is asked for **here and nowhere else**: the opt-in
    // belongs to the unit that renders, because a caller that cannot fetch a
    // head back would present one as the whole result. Both renderers below can
    // (see `loadFullResult`).
    // `imageRefs` is its own opt-in beside it, and asked for here for the same
    // reason: this is the unit that renders, and it can fetch a picture back
    // (see `loadToolImage`). It is where the bytes actually were — 91% of all
    // tool-result payload, none of it ever drawn.
    profile = AttachProfile()
    let handle = client.attach(
      sessionId: sessionId, afterSeq: 0, truncateResults: true, imageRefs: true)
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

  /// Which transcript item a notification's `seq` points at, or nil when there
  /// is nothing to move to (the event has not landed, or produced no row — the
  /// reader then stays pinned at the tail, where it is about to appear).
  func itemIndex(forSeq seq: Int) -> Int? { seqIndex.item(forSeq: seq) }

  func detach() {
    handle?.detach()
    handle = nil
    usagePollTask?.cancel()
    usagePollTask = nil
    connection = .reconnecting
    endReplayHold()
  }

  /// Hold the transcript until the replay this frame promised has landed.
  ///
  /// The hold **ends on the stated seq** — see `ReplayHold.swift`. What the
  /// backstop below decides is only when to give up, and it gives up on a
  /// *stall* rather than on a flat deadline from the attach: a phone replaying
  /// thousands of events over a tailnet does not finish in 1.5s, and a flat
  /// deadline fired on exactly the sessions the hold exists for. It is not the
  /// quiet-window latch this design refuses; that refusal is about detecting the
  /// replay's *end* by arrival timing, and the end is still stated.
  private func armReplayHold(_ frame: AttachedFrame) {
    replayBackstop?.cancel()
    replayBackstop = nil
    // `endReplayHold`, not `replayHold = nil`: a reconnect arrives here with a
    // buffer possibly still pending, and dropping it rather than publishing it
    // would lose the history it holds.
    guard let target = initialReplayTarget(frame) else { return endReplayHold() }
    var hold = ReplayHold(target: target, now: ProcessInfo.processInfo.systemUptime)
    hold.advance(to: replayBuffer?.lastSeq ?? state.lastSeq, now: hold.startedAt)
    guard !hold.landed else { return endReplayHold() }
    replayHold = hold
    replaying = true
    replayProgress = (hold.seq, hold.target)
    progressPublishedAt = hold.startedAt
    replayBackstop = Task { @MainActor [weak self] in
      // Re-checked rather than slept once: every advance moves the deadline, so
      // this wakes at the current one and only gives up if nothing moved it.
      while let hold = self?.replayHold {
        let now = ProcessInfo.processInfo.systemUptime
        if hold.expired(now: now) { break }
        try? await Task.sleep(for: .seconds(hold.deadline - now))
        if Task.isCancelled { return }
      }
      guard !Task.isCancelled else { return }
      self?.endReplayHold()
    }
  }

  /// Feed the transcript's seq to the hold, ending it on the event that reaches
  /// the stated target — in the same pass that applies it, so the reveal and the
  /// last row land together.
  private func advanceReplayHold(lastSeq: Int) {
    guard var hold = replayHold else { return }
    let now = ProcessInfo.processInfo.systemUptime
    hold.advance(to: lastSeq, now: now)
    // Written back before the landed check so the hold that ends is the
    // advanced one — otherwise every landing reports itself as a stall.
    replayHold = hold
    if hold.landed { return endReplayHold() }
    // Published on a clock, not on an event — see `progressPublishedAt`. Ten a
    // second is more than a reader can follow and 80x fewer than the replay
    // delivers.
    if now - progressPublishedAt >= Self.progressInterval {
      progressPublishedAt = now
      replayProgress = (hold.seq, hold.target)
    }
  }

  /// How often the replay counter is allowed to move the screen.
  private static let progressInterval = 0.1

  /// End the hold and publish in the same pass, so the reveal and everything
  /// the reveal implies land on one frame. Every exit goes through here — the
  /// stated seq, the stall backstop, and a detach — because a buffer left
  /// unpublished is a transcript that silently lost its history.
  private func endReplayHold() {
    if var profile {
      profile.landedAt = ProcessInfo.processInfo.systemUptime
      self.profile = nil
      let reason = replayHold?.landed == true ? "landed" : "released"
      AttachProfile.log.notice("\(profile.report(reason: reason), privacy: .public)")
      print("[attach] " + profile.report(reason: reason))
    }
    replayBackstop?.cancel()
    replayBackstop = nil
    replayHold = nil
    replaying = false
    replayProgress = nil
    guard let buffer = replayBuffer else { return }
    replayBuffer = nil
    state = buffer
    revision &+= 1
  }

  private func apply(_ event: SessionHandle.Event) {
    switch event {
    case .attached(let frame):
      profile?.attachedAt = ProcessInfo.processInfo.systemUptime
      profile?.target = frame.session.lastSeq
      session = frame.session
      state = seedFromSessionInfo(state, frame.session)
      loadCatalogModels(for: frame.session.profile)
      startUsagePoll(profile: frame.session.profile)
      armReplayHold(frame)
    case .event(let sessionEvent):
      let reduceStart = ProcessInfo.processInfo.systemUptime
      if replayHold != nil {
        // Into the buffer, and nothing observable moves. `state` and `revision`
        // are the two things every view watches, so leaving both alone is what
        // makes the hold cover the whole screen rather than one subview.
        var buffer = replayBuffer ?? state
        let before = buffer.items.count
        buffer = applyEvent(buffer, sessionEvent)
        seqIndex.note(
          seq: sessionEvent.seq, itemsBefore: before, itemsAfter: buffer.items.count)
        replayBuffer = buffer
        // Charged before the hold is advanced: `advanceReplayHold` can end the
        // hold, which reports, and the fold that completed the replay is part
        // of what the replay cost.
        profile?.events += 1
        profile?.reduceSeconds += ProcessInfo.processInfo.systemUptime - reduceStart
        profile?.lastEventAt = ProcessInfo.processInfo.systemUptime
        profile?.seq = buffer.lastSeq
        advanceReplayHold(lastSeq: buffer.lastSeq)
      } else {
        let before = state.items.count
        state = applyEvent(state, sessionEvent)
        seqIndex.note(seq: sessionEvent.seq, itemsBefore: before, itemsAfter: state.items.count)
        revision &+= 1
      }
      if case .systemInit(let info) = sessionEvent.body, initModel == nil {
        initModel = info.model
        defaultPermissionMode = info.permissionMode
      }
    case .connectionChange(let connected):
      if connected, profile?.openedAt == nil {
        profile?.openedAt = ProcessInfo.processInfo.systemUptime
      }
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

  /// Poll the gateway's per-account usage for this session's profile, on the
  /// same 60s cadence as the dashboard.
  ///
  /// Seeded from the process-wide cache first: this model is created per
  /// session, so without the seed a session switch would render the incoming
  /// session's own replayed numbers for a whole round trip. Gated on
  /// `capabilities.rateLimits` — an engine with no plan windows has nothing to
  /// ask for.
  private func startUsagePoll(profile: String?) {
    guard usagePollTask == nil, let profile, capabilities.rateLimits else { return }
    if let cached = ProfileUsageCache.read(client: client, profile: profile) {
      profileUsage = cached
    }
    usagePollTask = Task { @MainActor [weak self, client] in
      while !Task.isCancelled {
        do {
          let response = try await client.listProfiles()
          if Task.isCancelled { return }
          let next = response.profiles.first { $0.name == profile }?.usage
          ProfileUsageCache.write(client: client, profile: profile, usage: next)
          self?.profileUsage = next
        } catch {
          // A server predating profiles 404s; stop asking rather than asking
          // it again every minute. Anything else (a blip, a dead socket's
          // sibling) keeps the cadence — the next tick may succeed.
          if (error as? WorkerClientError)?.statusCode == 404 { return }
        }
        try? await Task.sleep(for: .seconds(60))
      }
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

  /// The status bar's usage rings: the first three of `usageWindows`, so the
  /// two named rings always mean the same thing.
  ///
  /// Three is the cap: it is what a subscription reports today and what fits a
  /// phone-width bar beside the model and permission chips. An account
  /// reporting none of them (an API-key profile, or a session before its first
  /// turn with no tracker state) gets no rings at all, and the bar shows cost
  /// instead.
  var hudRateLimits: [UsageWindowRow] { Array(usageWindows.prefix(3)) }

  /// Merged account + session windows in reading order — the protocol's
  /// `orderUsageWindows(mergeUsage(...))`, the same fold the dashboard and the
  /// VS Code panel render. The profile side wins every window it holds; the
  /// transcript's own reading fills in only where the gateway holds nothing (a
  /// restarted tracker, a profile-less session).
  var usageWindows: [UsageWindowRow] {
    orderUsageWindows(
      mergeUsage(
        SessionUsage(rateLimits: state.rateLimits, updatedAt: state.rateLimitsUpdatedAt),
        profileUsage))
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

  /// Re-fetch the REST rollup for this session.
  ///
  /// The watermark's leave-time truing-up needs `activityCount` fresher than the
  /// attach snapshot: the in-view marks ran off that snapshot, so rows produced
  /// since it landed would read as unread even though they were on screen.
  func refreshSessionInfo() async -> SessionInfo? {
    guard let info = try? await client.getSession(id: sessionId) else { return nil }
    session = info
    return info
  }

  /// Fetch the whole of a tool result whose replay delivered only its head, and
  /// hydrate it into transcript state.
  ///
  /// Into the state rather than into the row that asked: the copy action then
  /// copies the whole thing and no later event can re-truncate it. A failure is
  /// **silent on purpose** — a 404 means the log that seq belonged to is gone (a
  /// dormant rebuild, a restart), and the head stays on screen still saying what
  /// it is, which is honest and better than an error about a press.
  func loadFullResult(toolUseId: String) {
    guard !fetchingResults.contains(toolUseId) else { return }
    guard case .toolCall(let call) = state.items.first(where: { $0.id == toolUseId }),
      let result = call.result, result.truncated, let seq = result.sourceSeq
    else { return }
    fetchingResults.insert(toolUseId)
    Task { @MainActor [weak self] in
      guard let self else { return }
      defer { self.fetchingResults.remove(toolUseId) }
      guard
        // `imageRefs` here too: without it this JSON carries every screenshot's
        // base64 and the fold below keeps only the text — bytes paid for and
        // discarded on a press that asked about words.
        let response = try? await self.client.toolResult(
          sessionId: self.sessionId, seq: seq, toolUseId: toolUseId, imageRefs: true)
      else { return }
      let hydrated = hydrateToolResult(self.state, toolUseId: toolUseId, text: response.text)
      guard hydrated != self.state else { return }
      self.state = hydrated
      self.revision &+= 1
    }
  }

  /// One image part's bytes, for a box the reader has scrolled into view.
  ///
  /// Nothing is cached here: the loader that calls this owns an `NSCache` of
  /// *decoded* images, which is the expensive half, and a second copy of the raw
  /// bytes beside it would be the memory this feature exists to stop spending.
  func loadToolImage(seq: Int, toolUseId: String, partIndex: Int) async throws -> Data {
    try await client.toolResultImage(
      sessionId: sessionId, seq: seq, toolUseId: toolUseId, partIndex: partIndex)
  }

  func dismissProtocolError() { lastProtocolError = nil }
}
