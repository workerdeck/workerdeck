import Foundation

/// Pure transcript state machine over the wire-protocol event stream.
///
/// A line-by-line port of `packages/react/src/transcript.ts` — the semantics are
/// the contract, not the shape of the code. When the reducer changes there, it
/// changes here. UI-free on purpose: `applyEvent` is a pure function so it can be
/// unit-tested and driven from anywhere (a store, a preview, a replay harness).

// MARK: - Items

/// Discriminator mirroring the TS union's `kind` tag. Upserts match on id **and**
/// kind, so two items may legitimately share an id across kinds.
public enum TranscriptItemKind: String, Sendable, Equatable {
  case user
  case assistantText
  case thinking
  case toolCall
  case turnResult
  case notice
  case fileDelivered
}

/// Lifecycle of a tool call.
///
/// - `running` — the model called it; execution has not been reported
/// - `pending` — dispatched to an executor (bridged to this client, queued)
/// - `deferred` — parked beyond this turn; may outlive the session's liveness
/// - `settled` / `failed` — terminal
///
/// Derive UI from this, not from `result` being present: a pending or deferred
/// call has no result yet and is not the same as a running one.
public enum ToolCallStatus: String, Sendable, Equatable {
  case running
  case pending
  case deferred
  case settled
  case failed
}

/// Terminal output of a tool call, however it was produced (model loop or executor).
public struct ToolCallResult: Sendable, Equatable {
  public var text: String
  public var isError: Bool

  public init(text: String, isError: Bool) {
    self.text = text
    self.isError = isError
  }
}

public struct ToolCallItem: Sendable, Equatable, Identifiable {
  /// The `tool_use` block id; also the executionId for calls the model made.
  public var id: String
  public var name: String
  public var input: JSONValue
  /// Set when the call was made inside a subagent (Task tool).
  public var parentToolUseId: String?
  public var status: ToolCallStatus
  public var result: ToolCallResult?
  /// Correlation id when this call is executed outside the model loop.
  public var executionId: String?
  /// Which backend is executing it, when known.
  public var backend: ToolExecutionBackend?
  /// Logs captured by the executor (guest console output).
  public var logs: [String]?

  public init(
    id: String, name: String, input: JSONValue, parentToolUseId: String? = nil,
    status: ToolCallStatus, result: ToolCallResult? = nil, executionId: String? = nil,
    backend: ToolExecutionBackend? = nil, logs: [String]? = nil
  ) {
    self.id = id
    self.name = name
    self.input = input
    self.parentToolUseId = parentToolUseId
    self.status = status
    self.result = result
    self.executionId = executionId
    self.backend = backend
    self.logs = logs
  }
}

public enum NoticeLevel: String, Sendable, Equatable {
  case info
  case error
}

public enum TranscriptItem: Sendable, Equatable, Identifiable {
  case user(id: String, text: String)
  case assistantText(id: String, text: String, streaming: Bool, parentToolUseId: String?)
  case thinking(id: String, text: String, parentToolUseId: String?)
  case toolCall(ToolCallItem)
  case turnResult(
    id: String, subtype: String, isError: Bool, durationMs: Double, totalCostUsd: Double,
    errors: [String]?)
  case notice(id: String, level: NoticeLevel, text: String)
  /// The agent handed over a session file (`file_delivered`). Render a download
  /// card; the file is served by GET /sessions/:id/files/<path> while the session
  /// lives.
  case fileDelivered(id: String, path: String, bytes: Int, description: String?)

  public var id: String {
    switch self {
    case .user(let id, _): return id
    case .assistantText(let id, _, _, _): return id
    case .thinking(let id, _, _): return id
    case .toolCall(let call): return call.id
    case .turnResult(let id, _, _, _, _, _): return id
    case .notice(let id, _, _): return id
    case .fileDelivered(let id, _, _, _): return id
    }
  }

  public var kind: TranscriptItemKind {
    switch self {
    case .user: return .user
    case .assistantText: return .assistantText
    case .thinking: return .thinking
    case .toolCall: return .toolCall
    case .turnResult: return .turnResult
    case .notice: return .notice
    case .fileDelivered: return .fileDelivered
    }
  }
}

// MARK: - State

public struct TranscriptState: Sendable, Equatable {
  public var status: SessionStatus
  public var statusDetail: String?
  public var model: String?
  public var cwd: String?
  public var sdkSessionId: String?
  /// Engine running the session, from the attach snapshot. Gates CLI-only
  /// affordances; absent (an older server) reads as `.claude`.
  public var engine: ProfileEngine?
  /// Models the session can switch to (from the `capabilities` event).
  public var models: [ModelOption]?
  /// Slash commands the CLI accepts (from the `capabilities` event).
  public var commands: [SlashCommandInfo]?
  /// Seeded from `system_init`, updated on `permission_mode_changed`.
  public var permissionMode: PermissionMode?
  /// Latest context-window snapshot; absent until the first turn completes.
  public var contextUsage: ContextUsage?
  /// Latest rate-limit snapshot per window ('five_hour', 'seven_day', ...).
  /// Absent for API-key sessions — render nothing, not 0%.
  public var rateLimits: [String: RateLimitInfo]?
  public var items: [TranscriptItem]
  public var pendingApprovals: [PermissionRequest]
  public var totalCostUsd: Double
  public var lastSeq: Int

  public init(
    status: SessionStatus = .starting, statusDetail: String? = nil, model: String? = nil,
    cwd: String? = nil, sdkSessionId: String? = nil, engine: ProfileEngine? = nil,
    models: [ModelOption]? = nil, commands: [SlashCommandInfo]? = nil,
    permissionMode: PermissionMode? = nil, contextUsage: ContextUsage? = nil,
    rateLimits: [String: RateLimitInfo]? = nil, items: [TranscriptItem] = [],
    pendingApprovals: [PermissionRequest] = [], totalCostUsd: Double = 0, lastSeq: Int = 0
  ) {
    self.status = status
    self.statusDetail = statusDetail
    self.model = model
    self.cwd = cwd
    self.sdkSessionId = sdkSessionId
    self.engine = engine
    self.models = models
    self.commands = commands
    self.permissionMode = permissionMode
    self.contextUsage = contextUsage
    self.rateLimits = rateLimits
    self.items = items
    self.pendingApprovals = pendingApprovals
    self.totalCostUsd = totalCostUsd
    self.lastSeq = lastSeq
  }

  public static let initial = TranscriptState()
}

// MARK: - Internals

/// Id of the in-flight assistant text item assembled from `text_delta`s.
private let streamingId = "streaming"
/// Id of the in-flight thinking item assembled from `thinking_delta`s.
private let streamingThinkingId = "streaming-thinking"

/// CLI-side command output arrives as user text wrapped in local-command tags.
/// (Mirrors `LOCAL_COMMAND_OUTPUT`; NSRegularExpression is thread-safe.)
private let localCommandOutput = try! NSRegularExpression(
  pattern: #"^<local-command-(stdout|stderr)>([\s\S]*?)</local-command-\1>$"#)

/// JS-`trim()`-equivalent whitespace stripping.
private func trimmed(_ value: String) -> String {
  value.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Replace the item with the same id **and** kind, else append.
private func upsert(_ items: [TranscriptItem], _ item: TranscriptItem) -> [TranscriptItem] {
  guard
    let index = items.firstIndex(where: { $0.id == item.id && $0.kind == item.kind })
  else { return items + [item] }
  var next = items
  next[index] = item
  return next
}

/// Rewrite the one tool call with this id, leaving everything else alone. Events
/// for an unknown id are ignored rather than fabricating an item: the `tool_use`
/// that explains it may simply not have arrived (or belongs to another session).
private func mapToolCall(
  _ items: [TranscriptItem], id: String, _ transform: (ToolCallItem) -> ToolCallItem
) -> [TranscriptItem] {
  items.map { item in
    guard case .toolCall(let call) = item, call.id == id else { return item }
    return .toolCall(transform(call))
  }
}

/// Text of the in-flight item with this id, if any.
private func streamedText(_ items: [TranscriptItem], kind: TranscriptItemKind, id: String) -> String
{
  for item in items where item.id == id && item.kind == kind {
    switch item {
    case .assistantText(_, let text, _, _): return text
    case .thinking(_, let text, _): return text
    default: return ""
    }
  }
  return ""
}

/// Render an execution's by-value output for the transcript (`outputText`).
func executionOutputText(_ output: ToolExecutionOutput) -> String {
  switch output {
  case .text(let value): return value
  case .json(let value): return jsonStringify(value)
  }
}

/// `JSON.stringify` for a `JSONValue`. Object keys are emitted sorted — the
/// decoded representation is an unordered dictionary, so insertion order (which
/// JS would preserve) no longer exists by the time we get here.
func jsonStringify(_ value: JSONValue) -> String {
  switch value {
  case .null:
    return "null"
  case .bool(let flag):
    return flag ? "true" : "false"
  case .number(let number):
    guard number.isFinite else { return "null" }
    if number == number.rounded(), abs(number) < 1e15 { return String(Int64(number)) }
    return String(number)
  case .string(let text):
    return jsonQuote(text)
  case .array(let values):
    return "[" + values.map(jsonStringify).joined(separator: ",") + "]"
  case .object(let entries):
    let body = entries.keys.sorted()
      .map { "\(jsonQuote($0)):\(jsonStringify(entries[$0]!))" }
      .joined(separator: ",")
    return "{" + body + "}"
  }
}

private func jsonQuote(_ text: String) -> String {
  var out = "\""
  for scalar in text.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    case "\u{08}": out += "\\b"
    case "\u{0C}": out += "\\f"
    default:
      if scalar.value < 0x20 {
        out += String(format: "\\u%04x", scalar.value)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out + "\""
}

// MARK: - Reducers

/// Seed transcript state from the attach snapshot (the `attached` frame's SessionInfo).
/// A promptless session emits no `system_init` until its first message, so fields like
/// `permissionMode` and `model` would otherwise stay empty — fill only what events
/// haven't set yet; the event stream stays authoritative.
public func seedFromSessionInfo(_ state: TranscriptState, _ info: SessionInfo) -> TranscriptState {
  var next = state
  // Before any event has arrived, the snapshot status is fresher than 'starting'.
  if state.lastSeq == 0 { next.status = info.status }
  next.model = state.model ?? info.model
  next.permissionMode = state.permissionMode ?? info.permissionMode
  next.cwd = state.cwd ?? info.cwd
  next.sdkSessionId = state.sdkSessionId ?? info.sdkSessionId
  // Never changes for a live session, and no event carries it — the snapshot is
  // the only source, so take it whenever it is present.
  next.engine = info.engine ?? state.engine
  return next
}

public func applyEvent(_ state: TranscriptState, _ event: SessionEvent) -> TranscriptState {
  guard event.seq > state.lastSeq else { return state }
  var next = state
  next.lastSeq = event.seq

  switch event.body {
  case .systemInit(let info):
    next.model = info.model
    next.cwd = info.cwd
    next.sdkSessionId = info.sdkSessionId
    next.permissionMode = info.permissionMode

  case .statusChanged(let status, let detail):
    next.status = status
    next.statusDetail = detail

  case .capabilities(let models, let commands):
    next.models = models
    next.commands = commands

  case .modelChanged(let model):
    // nil = reset to the server default; keep showing the last known model.
    if let model { next.model = model }

  case .permissionModeChanged(let mode):
    next.permissionMode = mode

  case .contextUsage(let usage):
    next.contextUsage = usage

  case .rateLimit(let info):
    // Keyed by window so five_hour and seven_day updates don't clobber each other.
    guard let key = info.rateLimitType, !key.isEmpty else { break }
    var limits = next.rateLimits ?? [:]
    limits[key] = info
    next.rateLimits = limits

  case .userMessage(let payload):
    var items = next.items
    for block in payload.message.content.asBlocks {
      switch block {
      case .toolResult(let toolResult):
        let isError = toolResult.isError == true
        items = mapToolCall(items, id: toolResult.toolUseId) { call in
          var updated = call
          updated.status = isError ? .failed : .settled
          updated.result = ToolCallResult(
            text: toolResult.content?.joinedText ?? "", isError: isError)
          return updated
        }
      case .text(let text) where payload.synthetic != true:
        let id = payload.uuid ?? "user-\(event.seq)"
        if let local = matchLocalCommandOutput(trimmed(text)) {
          items = upsert(
            items,
            .notice(id: id, level: local.stream == "stderr" ? .error : .info,
              text: trimmed(local.body)))
        } else {
          items = upsert(items, .user(id: id, text: text))
        }
      default:
        break
      }
    }
    next.items = items

  case .assistantMessage(let payload):
    // Encrypted thinking arrives as a signature-only block on the final message:
    // `thinking` is '' and the human-readable summary, when the model surfaces one at
    // all, exists only in the thinking_delta stream. Carry the streamed text over
    // rather than let the full message overwrite it with nothing.
    var streamedThinking = streamedText(
      next.items, kind: .thinking, id: streamingThinkingId)
    // The full message supersedes any in-flight streamed text/thinking.
    var items = next.items.filter { item in
      !(item.kind == .assistantText && item.id == streamingId)
        && !(item.kind == .thinking && item.id == streamingThinkingId)
    }
    for (index, block) in payload.message.content.asBlocks.enumerated() {
      let id = "\(payload.uuid)-\(index)"
      switch block {
      case .text(let text):
        items = upsert(
          items,
          .assistantText(
            id: id, text: text, streaming: false, parentToolUseId: payload.parentToolUseId))
      case .thinking(let thinking):
        let text = thinking.isEmpty ? streamedThinking : thinking
        // One streamed thought backfills at most one block, so a multi-block message
        // doesn't repeat it.
        streamedThinking = ""
        // No summary anywhere: drop the block instead of leaving a "Thought process"
        // row that expands to nothing (and, across consecutive messages, stacks up).
        if trimmed(text).isEmpty { continue }
        items = upsert(
          items, .thinking(id: id, text: text, parentToolUseId: payload.parentToolUseId))
      case .toolUse(let toolUseId, let name, let input):
        items = upsert(
          items,
          .toolCall(
            ToolCallItem(
              id: toolUseId, name: name, input: input,
              parentToolUseId: payload.parentToolUseId, status: .running)))
      default:
        break
      }
    }
    next.items = items

  case .streamDelta(let payload):
    guard payload.event.type == "content_block_delta", let delta = payload.event.delta else {
      break
    }
    if delta.type == "text_delta" {
      let existing = streamedText(next.items, kind: .assistantText, id: streamingId)
      next.items = upsert(
        next.items,
        .assistantText(
          id: streamingId, text: existing + (delta.text ?? ""), streaming: true,
          parentToolUseId: payload.parentToolUseId))
    } else if delta.type == "thinking_delta" {
      let existing = streamedText(next.items, kind: .thinking, id: streamingThinkingId)
      next.items = upsert(
        next.items,
        .thinking(
          id: streamingThinkingId, text: existing + (delta.thinking ?? ""),
          parentToolUseId: payload.parentToolUseId))
    }

  case .turnResult(let payload):
    // totalCostUsd is session-cumulative on each SDK result message.
    next.totalCostUsd = payload.totalCostUsd
    next.items.append(
      .turnResult(
        id: "turn-\(event.seq)", subtype: payload.subtype, isError: payload.isError,
        durationMs: payload.durationMs, totalCostUsd: payload.totalCostUsd,
        errors: payload.errors))

  case .permissionRequested(let request):
    next.pendingApprovals.append(request)

  case .permissionResolved(let requestId, _, _, _):
    next.pendingApprovals.removeAll { $0.id == requestId }

  // Execution lifecycle for tool calls that run outside the model loop (bridged to
  // this client, queued, or deferred). Keyed by executionId, which equals the
  // tool_use id for calls the model made.
  case .executionDispatched(let executionId, _, let backend, let deferred, _):
    next.items = mapToolCall(next.items, id: executionId) { call in
      var updated = call
      updated.status = deferred ? .deferred : .pending
      updated.executionId = executionId
      updated.backend = backend
      return updated
    }

  case .executionResult(let executionId, let output, let logs, _):
    next.items = mapToolCall(next.items, id: executionId) { call in
      var updated = call
      updated.status = .settled
      updated.executionId = executionId
      updated.result = ToolCallResult(text: executionOutputText(output), isError: false)
      updated.logs = logs ?? call.logs
      return updated
    }

  case .executionFailed(let executionId, let reason, let error, let logs, _):
    next.items = mapToolCall(next.items, id: executionId) { call in
      var updated = call
      updated.status = .failed
      updated.executionId = executionId
      updated.result = ToolCallResult(text: "\(reason): \(error)", isError: true)
      updated.logs = logs ?? call.logs
      return updated
    }

  case .fileDelivered(let path, let bytes, let description):
    next.items.append(
      .fileDelivered(
        id: "file-\(event.seq)", path: path, bytes: bytes, description: description))

  case .sessionError(let message):
    next.items.append(.notice(id: "err-\(event.seq)", level: .error, text: message))

  case .sessionClosed(let reason):
    next.items.append(
      .notice(id: "closed-\(event.seq)", level: .info, text: "Session closed (\(reason))"))

  case .sdkEvent, .unknown:
    // Nothing to render — but lastSeq still advances, so a replay resumes past it.
    break
  }

  return next
}

/// Match the local-command wrapper, returning the stream name and the wrapped body.
private func matchLocalCommandOutput(_ text: String) -> (stream: String, body: String)? {
  let range = NSRange(text.startIndex..<text.endIndex, in: text)
  guard let match = localCommandOutput.firstMatch(in: text, range: range),
    let streamRange = Range(match.range(at: 1), in: text),
    let bodyRange = Range(match.range(at: 2), in: text)
  else { return nil }
  return (String(text[streamRange]), String(text[bodyRange]))
}
