import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Transcript reducer")
struct TranscriptTests {
  // MARK: - Builders

  private func event(_ seq: Int, _ body: SessionEventBody) -> SessionEvent {
    SessionEvent(seq: seq, ts: 1_722_300_000_000, body: body)
  }

  private func assistant(
    _ seq: Int, uuid: String = "a1", parentToolUseId: String? = nil, _ blocks: [ContentBlock]
  ) -> SessionEvent {
    event(
      seq,
      .assistantMessage(
        AssistantMessageEvent(
          message: ApiMessage(role: "assistant", content: .blocks(blocks)),
          parentToolUseId: parentToolUseId, uuid: uuid)))
  }

  private func user(
    _ seq: Int, uuid: String? = "u1", synthetic: Bool? = nil, _ blocks: [ContentBlock]
  ) -> SessionEvent {
    event(
      seq,
      .userMessage(
        UserMessageEvent(
          message: ApiMessage(role: "user", content: .blocks(blocks)),
          synthetic: synthetic, uuid: uuid)))
  }

  private func textDelta(_ seq: Int, _ text: String, parentToolUseId: String? = nil)
    -> SessionEvent
  {
    event(
      seq,
      .streamDelta(
        StreamDeltaEvent(
          event: .init(type: "content_block_delta", delta: .init(type: "text_delta", text: text)),
          parentToolUseId: parentToolUseId,
          uuid: "s\(seq)")))
  }

  /// A subagent streams concurrently with the thread that spawned it, so the
  /// in-flight item is a singleton **per agent**. Under one id these deltas weld
  /// two agents' half-sentences into a single row, and the first finished
  /// message wipes the one still being written. (Mirrors the react reducer.)
  @Test func concurrentAgentsStreamIntoSeparateRows() {
    var state = reduce([
      textDelta(1, "Main "),
      textDelta(2, "Sub ", parentToolUseId: "toolu_a"),
      textDelta(3, "thread.", parentToolUseId: nil),
      textDelta(4, "agent.", parentToolUseId: "toolu_a"),
    ])
    #expect(
      state.items == [
        .assistantText(id: "streaming", text: "Main thread.", streaming: true, parentToolUseId: nil),
        .assistantText(
          id: "streaming:toolu_a", text: "Sub agent.", streaming: true,
          parentToolUseId: "toolu_a"),
      ])

    state = reduce(
      [
        textDelta(1, "Half a sentence"),
        assistant(2, uuid: "a-sub", parentToolUseId: "toolu_a", [.text("Subagent done.")]),
      ])
    #expect(
      state.items.first == .assistantText(
        id: "streaming", text: "Half a sentence", streaming: true, parentToolUseId: nil))
    #expect(state.items.count == 2)
  }

  private func thinkingDelta(_ seq: Int, _ thinking: String) -> SessionEvent {
    event(
      seq,
      .streamDelta(
        StreamDeltaEvent(
          event: .init(
            type: "content_block_delta", delta: .init(type: "thinking_delta", thinking: thinking)),
          uuid: "s\(seq)")))
  }

  private func reduce(_ events: [SessionEvent], from state: TranscriptState = .initial)
    -> TranscriptState
  {
    events.reduce(state, applyEvent)
  }

  // MARK: - Accessors

  private func toolCall(_ state: TranscriptState, _ id: String) -> ToolCallItem? {
    for case .toolCall(let call) in state.items where call.id == id { return call }
    return nil
  }

  // MARK: - Sequencing

  @Test func replayedEventIsIgnored() {
    let message = assistant(1, [.text("hello")])
    let once = applyEvent(.initial, message)
    let twice = applyEvent(once, message)
    #expect(twice == once)
    #expect(twice.items.count == 1)
    #expect(twice.lastSeq == 1)
  }

  @Test func lowerSeqEventIsIgnoredEntirely() {
    let state = reduce([assistant(5, [.text("hi")])])
    let stale = applyEvent(state, event(4, .sessionError(message: "old")))
    #expect(stale == state)
  }

  @Test func unknownEventAdvancesSeqWithoutItems() {
    let state = reduce([
      event(1, .unknown(type: "future_thing", raw: ["a": 1])),
      event(2, .sdkEvent(payload: .null)),
    ])
    #expect(state.lastSeq == 2)
    #expect(state.items.isEmpty)
  }

  // MARK: - Streaming

  @Test func textDeltasAccumulateThenFinalMessageReplacesThem() {
    var state = reduce([textDelta(1, "Hel"), textDelta(2, "lo")])
    #expect(state.items.count == 1)
    #expect(state.items[0] == .assistantText(
      id: "streaming", text: "Hello", streaming: true, parentToolUseId: nil))

    state = applyEvent(state, assistant(3, uuid: "a1", [.text("Hello there")]))
    #expect(state.items.count == 1)
    #expect(state.items[0] == .assistantText(
      id: "a1-0", text: "Hello there", streaming: false, parentToolUseId: nil))
  }

  @Test func nonContentBlockDeltaChangesNothingButSeq() {
    let state = reduce([
      event(
        1,
        .streamDelta(
          StreamDeltaEvent(
            event: .init(type: "message_start", delta: .init(type: "text_delta", text: "x")),
            uuid: "s1"))),
      event(
        2,
        .streamDelta(
          StreamDeltaEvent(
            event: .init(type: "content_block_delta", delta: .init(type: "signature_delta")),
            uuid: "s2"))),
    ])
    #expect(state.items.isEmpty)
    #expect(state.lastSeq == 2)
  }

  // MARK: - Thinking

  @Test func emptyThinkingBlockBackfillsFromStreamedThinking() {
    let state = reduce([
      thinkingDelta(1, "Let me "),
      thinkingDelta(2, "check."),
      assistant(3, uuid: "a1", [.thinking(""), .text("Done")]),
    ])
    #expect(state.items.count == 2)
    #expect(state.items[0] == .thinking(id: "a1-0", text: "Let me check.", parentToolUseId: nil))
    #expect(state.items[1] == .assistantText(
      id: "a1-1", text: "Done", streaming: false, parentToolUseId: nil))
  }

  @Test func thinkingWithNothingToCarryIsDropped() {
    let state = reduce([assistant(1, uuid: "a1", [.thinking("   "), .text("Done")])])
    #expect(state.items.count == 1)
    #expect(state.items[0].kind == .assistantText)
  }

  @Test func streamedThinkingBackfillsAtMostOneBlock() {
    let state = reduce([
      thinkingDelta(1, "once"),
      assistant(2, uuid: "a1", [.thinking(""), .thinking(""), .thinking("explicit")]),
    ])
    #expect(state.items.count == 2)
    #expect(state.items[0] == .thinking(id: "a1-0", text: "once", parentToolUseId: nil))
    // a1-1 dropped (nothing left to carry); a1-2 keeps its own text.
    #expect(state.items[1] == .thinking(id: "a1-2", text: "explicit", parentToolUseId: nil))
  }

  // MARK: - Tool calls

  @Test func toolUseIsCorrelatedWithItsToolResult() {
    var state = reduce([
      assistant(1, [.toolUse(id: "tu1", name: "Bash", input: ["command": "ls"])])
    ])
    #expect(toolCall(state, "tu1")?.status == .running)
    #expect(toolCall(state, "tu1")?.input == ["command": "ls"])

    state = applyEvent(
      state,
      user(
        2, synthetic: true,
        [
          .toolResult(
            ToolResultBlock(
              toolUseId: "tu1", content: .parts([ToolResultPart(type: "text", text: "a.txt")]),
              isError: false))
        ]))
    #expect(toolCall(state, "tu1")?.status == .settled)
    #expect(toolCall(state, "tu1")?.result == ToolCallResult(text: "a.txt", isError: false))
  }

  @Test func erroredToolResultFlipsStatusToFailed() {
    let state = reduce([
      assistant(1, [.toolUse(id: "tu1", name: "Bash", input: .null)]),
      user(
        2, synthetic: true,
        [.toolResult(ToolResultBlock(toolUseId: "tu1", content: .text("boom"), isError: true))]),
    ])
    #expect(toolCall(state, "tu1")?.status == .failed)
    #expect(toolCall(state, "tu1")?.result == ToolCallResult(text: "boom", isError: true))
  }

  @Test func toolResultForUnknownIdFabricatesNothing() {
    let state = reduce([
      user(
        1, synthetic: true,
        [.toolResult(ToolResultBlock(toolUseId: "ghost", content: .text("x"), isError: false))])
    ])
    #expect(state.items.isEmpty)
    #expect(state.lastSeq == 1)
  }

  // MARK: - User messages

  @Test func syntheticTextIsNotRenderedButToolResultsStillApply() {
    let state = reduce([
      assistant(1, [.toolUse(id: "tu1", name: "Read", input: .null)]),
      user(
        2, synthetic: true,
        [
          .text("Tool ran"),
          .toolResult(ToolResultBlock(toolUseId: "tu1", content: .text("ok"), isError: false)),
        ]),
    ])
    #expect(state.items.count == 1)
    #expect(toolCall(state, "tu1")?.status == .settled)
    #expect(!state.items.contains { $0.kind == .user })
  }

  @Test func plainUserTextBecomesAUserItem() {
    let state = reduce([user(1, uuid: nil, [.text("hi there")])])
    #expect(state.items == [.user(id: "user-1", text: "hi there")])
  }

  @Test func localCommandOutputBecomesANotice() {
    let state = reduce([
      user(1, uuid: "n1", [.text("<local-command-stdout>\n  all good\n</local-command-stdout>")]),
      user(2, uuid: "n2", [.text("<local-command-stderr>bad\n</local-command-stderr>")]),
    ])
    #expect(state.items == [
      .notice(id: "n1", level: .info, text: "all good"),
      .notice(id: "n2", level: .error, text: "bad"),
    ])
  }

  @Test func nonWrappedTextWithTagsInsideStaysAUserItem() {
    let text = "see <local-command-stdout>x</local-command-stdout> above"
    let state = reduce([user(1, [.text(text)])])
    #expect(state.items == [.user(id: "u1", text: text)])
  }

  // MARK: - Permissions

  @Test func permissionRequestsQueueAndResolve() {
    let request = PermissionRequest(
      id: "r1", toolName: "Bash", input: ["command": "rm"], toolUseId: "tu1")
    var state = reduce([event(1, .permissionRequested(request))])
    #expect(state.pendingApprovals.map(\.id) == ["r1"])

    state = applyEvent(
      state,
      event(
        2,
        .permissionResolved(
          requestId: "r1", behavior: .allow, resolvedBy: "client", message: nil)))
    #expect(state.pendingApprovals.isEmpty)
  }

  // MARK: - Execution lifecycle

  @Test func dispatchAndResultUpdateTheMatchingToolCall() {
    var state = reduce([
      assistant(1, [.toolUse(id: "tu1", name: "js", input: .null)]),
      event(
        2,
        .executionDispatched(
          executionId: "tu1", toolName: "js", backend: "browser", deferred: false,
          expiresAt: nil)),
    ])
    #expect(toolCall(state, "tu1")?.status == .pending)
    #expect(toolCall(state, "tu1")?.backend == "browser")
    #expect(toolCall(state, "tu1")?.executionId == "tu1")

    state = applyEvent(
      state,
      event(
        3,
        .executionResult(
          executionId: "tu1", output: .json(["ok": true]), logs: ["log line"], durationMs: 12)))
    #expect(toolCall(state, "tu1")?.status == .settled)
    #expect(toolCall(state, "tu1")?.result == ToolCallResult(text: #"{"ok":true}"#, isError: false))
    #expect(toolCall(state, "tu1")?.logs == ["log line"])
  }

  @Test func deferredDispatchMarksTheCallDeferred() {
    let state = reduce([
      assistant(1, [.toolUse(id: "tu1", name: "js", input: .null)]),
      event(
        2,
        .executionDispatched(
          executionId: "tu1", toolName: "js", backend: "managed", deferred: true, expiresAt: nil)),
    ])
    #expect(toolCall(state, "tu1")?.status == .deferred)
  }

  @Test func executionFailureRendersReasonAndErrorAndKeepsOldLogs() {
    let state = reduce([
      assistant(1, [.toolUse(id: "tu1", name: "js", input: .null)]),
      event(
        2,
        .executionResult(
          executionId: "tu1", output: .text("partial"), logs: ["kept"], durationMs: nil)),
      event(
        3,
        .executionFailed(
          executionId: "tu1", reason: "timeout", error: "took too long", logs: nil,
          durationMs: nil)),
    ])
    #expect(toolCall(state, "tu1")?.status == .failed)
    #expect(
      toolCall(state, "tu1")?.result == ToolCallResult(
        text: "timeout: took too long", isError: true))
    #expect(toolCall(state, "tu1")?.logs == ["kept"])
  }

  @Test func executionEventsForUnknownIdsAreIgnored() {
    let before = reduce([assistant(1, [.toolUse(id: "tu1", name: "js", input: .null)])])
    let after = reduce(
      [
        event(
          2,
          .executionDispatched(
            executionId: "ghost", toolName: "js", backend: "server", deferred: false,
            expiresAt: nil)),
        event(
          3,
          .executionResult(executionId: "ghost", output: .text("x"), logs: nil, durationMs: nil)),
      ], from: before)
    #expect(after.items == before.items)
    #expect(after.lastSeq == 3)
  }

  // MARK: - Session metadata

  @Test func rateLimitsAreKeyedPerWindow() {
    let state = reduce([
      event(1, .rateLimit(RateLimitInfo(status: "allowed", rateLimitType: "five_hour", utilization: 20))),
      event(2, .rateLimit(RateLimitInfo(status: "allowed", rateLimitType: "seven_day", utilization: 5))),
      event(3, .rateLimit(RateLimitInfo(status: "allowed_warning", rateLimitType: "five_hour", utilization: 80))),
      event(4, .rateLimit(RateLimitInfo(status: "allowed", rateLimitType: nil))),
    ])
    #expect(state.rateLimits?.count == 2)
    #expect(state.rateLimits?["five_hour"]?.utilization == 80)
    #expect(state.rateLimits?["seven_day"]?.utilization == 5)
    #expect(state.lastSeq == 4)
  }

  /// The event's own `ts`, never receipt time: a replay delivers yesterday's
  /// reading in milliseconds, and a receipt-time stamp would date it "just now"
  /// — exactly the staleness the freshness line exists to expose.
  @Test func rateLimitStampsTheEventsOwnTime() {
    var state = applyEvent(
      .initial,
      SessionEvent(
        seq: 1, ts: 111,
        body: .rateLimit(
          RateLimitInfo(status: "allowed", rateLimitType: "five_hour", utilization: 20))))
    #expect(state.rateLimitsUpdatedAt == 111)
    // A reading naming no window changes nothing — the stamp included.
    state = applyEvent(
      state, SessionEvent(seq: 2, ts: 222, body: .rateLimit(RateLimitInfo(status: "allowed"))))
    #expect(state.rateLimitsUpdatedAt == 111)
  }

  /// The session-only fold callers with no gateway account state render:
  /// windows in reading order, each dated by the map's one clock.
  @Test func rateLimitWindowsFoldsTheSessionReadingAlone() {
    let state = applyEvent(
      .initial,
      SessionEvent(
        seq: 1, ts: 111,
        body: .rateLimit(
          RateLimitInfo(status: "allowed", rateLimitType: "five_hour", utilization: 20))))
    let rows = rateLimitWindows(state)
    #expect(rows.map(\.key) == ["five_hour"])
    #expect(rows.first?.updatedAt == 111)
    #expect(rows.first?.inferredReset == false)
  }

  @Test func modelChangedWithNilKeepsTheLastKnownModel() {
    let state = reduce([
      event(
        1,
        .systemInit(
          SystemInitEvent(
            sdkSessionId: "sdk1", model: "opus", cwd: "/repo", apiKeySource: "oauth",
            permissionMode: .acceptEdits))),
      event(2, .modelChanged(model: "haiku")),
      event(3, .modelChanged(model: nil)),
    ])
    #expect(state.model == "haiku")
    #expect(state.cwd == "/repo")
    #expect(state.sdkSessionId == "sdk1")
    #expect(state.permissionMode == .acceptEdits)
  }

  @Test func turnResultReplacesCumulativeCostRatherThanSumming() {
    let state = reduce([
      event(
        1,
        .turnResult(
          TurnResultEvent(
            subtype: "success", isError: false, durationMs: 100, numTurns: 1,
            totalCostUsd: 0.02))),
      event(
        2,
        .turnResult(
          TurnResultEvent(
            subtype: "success", isError: false, durationMs: 200, numTurns: 2,
            totalCostUsd: 0.05))),
    ])
    #expect(state.totalCostUsd == 0.05)
    #expect(state.items.count == 2)
    #expect(state.items[0].id == "turn-1")
    #expect(state.items[1].id == "turn-2")
  }

  @Test func lifecycleNoticesAndFilesAppend() {
    let state = reduce([
      event(1, .fileDelivered(path: "out/report.md", bytes: 42, description: "the report")),
      event(2, .sessionError(message: "engine crashed")),
      event(3, .sessionClosed(reason: "client")),
    ])
    #expect(state.items == [
      .fileDelivered(id: "file-1", path: "out/report.md", bytes: 42, description: "the report"),
      .notice(id: "err-2", level: .error, text: "engine crashed"),
      .notice(id: "closed-3", level: .info, text: "Session closed (client)"),
    ])
  }

  @Test func conversationResetEmptiesItemsAndKeepsSessionScopedState() {
    var seeded = reduce([
      event(1, .capabilities(models: [], commands: [], defaultModel: "claude-opus-5")),
      user(2, uuid: "u1", [.text("hi")]),
      assistant(3, [.text("hello")]),
      event(
        4,
        .contextUsage(
          ContextUsage(categories: [], totalTokens: 90_000, maxTokens: 200_000, percentage: 45))),
    ])
    seeded.model = "claude-test-1"
    seeded.cwd = "/tmp/p"
    seeded.sdkSessionId = "sdk-1"

    let state = reduce([event(5, .conversationReset(sdkSessionId: "sdk-2"))], from: seeded)
    // The conversation is gone, its context reading with it…
    #expect(state.items == [])
    #expect(state.contextUsage == nil)
    #expect(state.sdkSessionId == "sdk-2")
    // …and session-scoped state survives.
    #expect(state.model == "claude-test-1")
    #expect(state.cwd == "/tmp/p")
    #expect(state.defaultModel == "claude-opus-5")

    // A reset without a new id keeps the known one; resets stack — only what
    // came after the latest remains.
    let again = reduce(
      [
        user(6, uuid: "u2", [.text("two")]),
        event(7, .conversationReset(sdkSessionId: nil)),
        user(8, uuid: "u3", [.text("three")]),
      ], from: state)
    #expect(again.sdkSessionId == "sdk-2")
    #expect(again.items == [.user(id: "u3", text: "three")])
  }

  @Test func contextCompactedAppendsABoundaryAndLeavesTheReadingAlone() {
    let usage = ContextUsage(
      categories: [], totalTokens: 90_000, maxTokens: 200_000, percentage: 45)
    let seeded = reduce([
      user(1, uuid: "u1", [.text("hi")]),
      assistant(2, [.text("hello")]),
      event(3, .contextUsage(usage)),
    ])

    let state = reduce(
      [event(4, .contextCompacted(uuid: "c1", parentToolUseId: nil))], from: seeded)
    #expect(state.items.count == seeded.items.count + 1)
    #expect(state.items.last == .compaction(id: "c1", parentToolUseId: nil))
    #expect(state.contextUsage == usage)

    // Upserts on id, like every other item, and carries a sub-agent's parent.
    let nested = reduce(
      [
        event(5, .contextCompacted(uuid: "c1", parentToolUseId: nil)),
        event(6, .contextCompacted(uuid: "c2", parentToolUseId: "task-1")),
      ], from: state)
    #expect(nested.items.filter { $0.kind == .compaction }.count == 2)
    #expect(parentToolUseId(of: nested.items[nested.items.count - 1]) == "task-1")
  }

  @Test func statusAndCapabilitiesTrackTheirEvents() {
    let state = reduce([
      event(1, .statusChanged(status: .awaitingApproval, detail: "waiting")),
      event(
        2,
        .capabilities(
          models: [ModelOption(value: "opus", displayName: "Opus")],
          commands: [SlashCommandInfo(name: "wrapup")],
          defaultModel: "claude-opus-5[1m]")),
      event(3, .permissionModeChanged(mode: .plan)),
      event(
        4,
        .contextUsage(
          ContextUsage(categories: [], totalTokens: 10, maxTokens: 100, percentage: 10))),
    ])
    #expect(state.status == .awaitingApproval)
    #expect(state.statusDetail == "waiting")
    #expect(state.models?.count == 1)
    #expect(state.commands?.first?.name == "wrapup")
    // Known from `capabilities`, which lands long before any `system_init`.
    #expect(state.defaultModel == "claude-opus-5[1m]")
    #expect(state.permissionMode == .plan)
    #expect(state.contextUsage?.percentage == 10)
  }

  // MARK: - Seeding

  @Test func seedFillsOnlyWhatEventsHaveNotSet() {
    let info = SessionInfo(
      id: "s1", sdkSessionId: "sdk1", status: .idle, cwd: "/repo", engine: .provider,
      model: "gpt", permissionMode: .dontAsk, createdAt: 0, lastSeq: 3,
      pendingPermissionCount: 0)

    let fresh = seedFromSessionInfo(.initial, info)
    #expect(fresh.status == .idle)
    #expect(fresh.model == "gpt")
    #expect(fresh.cwd == "/repo")
    #expect(fresh.sdkSessionId == "sdk1")
    #expect(fresh.permissionMode == .dontAsk)
    #expect(fresh.engine == .provider)

    // Events already ran: they stay authoritative, but engine still comes from the snapshot.
    let live = reduce([
      event(
        1,
        .systemInit(
          SystemInitEvent(
            sdkSessionId: "sdk-live", model: "opus", cwd: "/live", apiKeySource: "oauth",
            permissionMode: .plan))),
      event(2, .statusChanged(status: .running, detail: nil)),
    ])
    let seeded = seedFromSessionInfo(live, info)
    #expect(seeded.status == .running)
    #expect(seeded.model == "opus")
    #expect(seeded.cwd == "/live")
    #expect(seeded.sdkSessionId == "sdk-live")
    #expect(seeded.permissionMode == .plan)
    #expect(seeded.engine == .provider)
  }
}

/// The replay hold — what stops a session opening in a flicker of its own
/// history. See `ReplayHold.swift`; the rules are the web client's.
@Suite("ReplayHold")
struct ReplayHoldTests {
  private func frame(replayingFrom: Int, lastSeq: Int) -> AttachedFrame {
    AttachedFrame(
      protocolVersion: WorkerProtocol.version,
      session: SessionInfo(
        id: "sess-1", status: .idle, cwd: "/w", createdAt: 0, lastSeq: lastSeq,
        pendingPermissionCount: 0),
      replayingFrom: replayingFrom)
  }

  @Test("a fresh attach holds until the seq the frame named")
  func freshAttachHolds() {
    #expect(initialReplayTarget(frame(replayingFrom: 0, lastSeq: 812)) == 812)
  }

  @Test("a reconnect never holds")
  func reconnectDoesNotHold() {
    // A reconnect replays into a transcript the reader is already looking at.
    // Blanking it mid-turn would be a worse bug than the flicker.
    #expect(initialReplayTarget(frame(replayingFrom: 400, lastSeq: 812)) == nil)
  }

  @Test("a brand-new session has nothing to hold for")
  func emptySessionDoesNotHold() {
    #expect(initialReplayTarget(frame(replayingFrom: 0, lastSeq: 0)) == nil)
  }

  @Test("the hold ends on the stated seq, not on a timer")
  func landsOnTarget() {
    var hold = ReplayHold(target: 812, now: 0)
    hold.advance(to: 811, now: 0.1)
    #expect(!hold.landed)
    hold.advance(to: 812, now: 0.2)
    #expect(hold.landed)
  }

  @Test("a replay still arriving extends past the old flat deadline")
  func progressExtendsTheDeadline() {
    // The bug this fixes: a flat 1.5s from the attach fired on exactly the
    // sessions the hold exists for — a big transcript replayed over a tailnet.
    var hold = ReplayHold(target: 5000, now: 0)
    for t in stride(from: 1.0, through: 6.0, by: 1.0) {
      hold.advance(to: Int(t) * 500, now: t)
      #expect(!hold.expired(now: t))
    }
    #expect(!hold.landed)
  }

  @Test("a stalled replay gives up — a blank screen forever is the worse failure")
  func stallGivesUp() {
    var hold = ReplayHold(target: 5000, now: 0)
    hold.advance(to: 400, now: 1.0)
    #expect(!hold.expired(now: 1.0 + replayHoldStallSeconds - 0.01))
    #expect(hold.expired(now: 1.0 + replayHoldStallSeconds))
  }

  @Test("a seq that did not advance does not move the deadline")
  func noProgressDoesNotExtend() {
    // Progress is `lastSeq`, not raw arrival: a reconnect storm delivers events
    // that are not this replay, and must not hold the transcript open.
    var hold = ReplayHold(target: 5000, now: 0)
    hold.advance(to: 400, now: 0)
    #expect(hold.advance(to: 400, now: 1.4) == false)
    #expect(hold.expired(now: replayHoldStallSeconds))
  }

  @Test("the ceiling still bounds a replay that dribbles forever")
  func ceilingBounds() {
    var hold = ReplayHold(target: 1_000_000, now: 0)
    var t = 0.0
    while t < replayHoldCeilingSeconds {
      t += 1.0
      hold.advance(to: Int(t), now: t)
    }
    #expect(hold.expired(now: replayHoldCeilingSeconds))
    #expect(hold.deadline == replayHoldCeilingSeconds)
  }
}
