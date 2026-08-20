import Foundation

/// Swift mirror of `@workerdeck/protocol` (packages/protocol/src/index.ts).
///
/// Kept in lockstep with the TypeScript source of truth — when the wire protocol
/// changes there, `PROTOCOL_VERSION` bumps and this file must follow. Decoding is
/// deliberately lenient: an event type (or a payload shape) this version doesn't
/// model becomes `.unknown` instead of failing the stream, matching the protocol's
/// "extend the protocol, don't parse client-side" contract.
///
/// Keys are spelled explicitly per type: workerdeck's own types use camelCase,
/// while Anthropic API mirrors (`ApiMessage`, content blocks) use snake_case.
/// Never decode with a global key-conversion strategy.
public enum WorkerProtocol {
  /// Mirror of PROTOCOL_VERSION. Compare against `AttachedFrame.protocolVersion`.
  public static let version = 7
}

// MARK: - Session lifecycle

public enum SessionStatus: String, Codable, Sendable {
  case starting
  case running
  case awaitingApproval = "awaiting_approval"
  case idle
  case parked
  case failed
  case closed
}

public enum PermissionMode: String, Codable, Sendable, CaseIterable {
  case `default`
  case acceptEdits
  case bypassPermissions
  case plan
  case dontAsk
  case auto
}

// MARK: - API message content (structural mirror of Anthropic message shapes)

public struct ToolResultPart: Codable, Sendable, Equatable {
  public let type: String
  public let text: String?
  /// The three fields of protocol's `ImageRefPart`, carried here rather than in
  /// a part type of their own because `ToolResultContent` decodes one
  /// heterogeneous array and a Swift enum per part kind would turn every fold
  /// below into a switch.
  ///
  /// All optional, and that is the compatibility story: an old gateway — or a
  /// socket that never asked (`WorkerClient.attach(imageRefs:)`) — sends parts
  /// that carry none of them, and a part with no `text` and no ref contributes
  /// nothing to ``ToolResultContent/joinedText`` exactly as the CLI's own
  /// `tool_reference` part already does. That is this rule family's safe
  /// failure: an unaware reader renders what it renders today, which is nothing.
  public let mediaType: String?
  /// Decoded size, which a holder of an address cannot compute. Not cosmetic:
  /// the placeholder drawn before the fetch spells it, and in the terminal
  /// theme a rendered string is a row's measured height.
  public let bytes: Int?
  /// Index of the part in the **stored** block, and the address a fetch is made
  /// with. Never the position it arrived at: a head keeps text parts up to
  /// budget and drops the rest, so positions are renumbered the moment
  /// truncation and this rule compose.
  public let partIndex: Int?

  public init(
    type: String, text: String?, mediaType: String? = nil, bytes: Int? = nil,
    partIndex: Int? = nil
  ) {
    self.type = type
    self.text = text
    self.mediaType = mediaType
    self.bytes = bytes
    self.partIndex = partIndex
  }

  private enum CodingKeys: String, CodingKey {
    case type, text, bytes
    case mediaType = "media_type"
    case partIndex = "part_index"
  }
}

/// How many bytes a base64 payload decodes to, without decoding it — the
/// phone's copy of protocol's `base64Bytes`.
///
/// The projection itself happens on the **gateway**: a ref minted here would be
/// an address with no route behind it, since only the gateway holds the stored
/// log the fetch reads. This exists so the arithmetic the two clients agree on
/// is written down once on this side too and can be pinned by a test against a
/// real payload — the same reason `WorkerDeckKit` mirrors rules it does not
/// drive.
public func base64DecodedBytes(_ data: String) -> Int {
  let padding = data.hasSuffix("==") ? 2 : data.hasSuffix("=") ? 1 : 0
  return max(0, data.count * 3 / 4 - padding)
}

public enum ToolResultContent: Sendable, Equatable {
  case text(String)
  case parts([ToolResultPart])

  /// Flattened text, mirroring the reference reducer's `blockText`.
  public var joinedText: String {
    switch self {
    case .text(let value): return value
    case .parts(let parts):
      return parts.compactMap { $0.text }.filter { !$0.isEmpty }.joined(separator: "\n")
    }
  }

  /// The `image_ref` addresses in this content, or `nil` when it holds none —
  /// which is the common case, and is why this is not an empty array: an absent
  /// field keeps the tool-call item byte-identical, and that item is
  /// `Equatable` and half the row-plan cache's key.
  ///
  /// Mirrors the react reducer's `imageRefsOf`. Reads `part_index` rather than
  /// the array position for the reason the field exists: a truncated head has
  /// already dropped parts by the time this runs.
  public func imageRefs(sourceSeq: Int) -> [ToolResultImageRef]? {
    guard case .parts(let parts) = self else { return nil }
    let refs = parts.enumerated().compactMap { position, part -> ToolResultImageRef? in
      guard part.type == "image_ref" else { return nil }
      return ToolResultImageRef(
        partIndex: part.partIndex ?? position,
        mediaType: part.mediaType ?? "application/octet-stream",
        bytes: part.bytes ?? 0, sourceSeq: sourceSeq)
    }
    return refs.isEmpty ? nil : refs
  }
}

extension ToolResultContent: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(String.self) {
      self = .text(value)
    } else {
      self = .parts(try container.decode([ToolResultPart].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .text(let value): try container.encode(value)
    case .parts(let parts): try container.encode(parts)
    }
  }
}

public struct ToolResultBlock: Sendable, Equatable {
  public let toolUseId: String
  public let content: ToolResultContent?
  public let isError: Bool?
  /// This block carries only the **head** of the result: the replay truncated it
  /// (protocol's `TOOL_RESULT_HEAD_CHARS`), and the whole thing is one fetch
  /// away (`WorkerClient.toolResult`).
  ///
  /// It can only arrive on a socket that asked for it — see
  /// `WorkerClient.attach(truncateResults:)` — which is why it is additive at
  /// protocol 7 rather than a version bump. Absent means the block is whole.
  public let truncated: Bool?
  /// How many characters the untruncated result had. Set iff `truncated`.
  ///
  /// A client cannot compute it, holding only the head, and it is not cosmetic:
  /// a collapsed row spells "… +N chars" and the planner *wraps that exact
  /// string* to size the row, so a count derived from the head would be both a
  /// lie and a different height.
  public let totalChars: Int?

  public init(
    toolUseId: String, content: ToolResultContent?, isError: Bool?, truncated: Bool? = nil,
    totalChars: Int? = nil
  ) {
    self.toolUseId = toolUseId
    self.content = content
    self.isError = isError
    self.truncated = truncated
    self.totalChars = totalChars
  }
}

public enum ContentBlock: Sendable, Equatable {
  case text(String)
  case thinking(String)
  case toolUse(id: String, name: String, input: JSONValue)
  case toolResult(ToolResultBlock)
  /// Forward-compatible fallback for block types this protocol version doesn't model.
  case unknown(type: String, raw: JSONValue)
}

extension ContentBlock: Decodable {
  private enum CodingKeys: String, CodingKey {
    case type, text, thinking, id, name, input
    case toolUseId = "tool_use_id"
    case content
    case isError = "is_error"
    case truncated
    case totalChars = "total_chars"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    do {
      switch type {
      case "text":
        self = .text(try container.decode(String.self, forKey: .text))
      case "thinking":
        // Encrypted thinking arrives signature-only: `thinking` may be absent or ''.
        self = .thinking(try container.decodeIfPresent(String.self, forKey: .thinking) ?? "")
      case "tool_use":
        self = .toolUse(
          id: try container.decode(String.self, forKey: .id),
          name: try container.decode(String.self, forKey: .name),
          input: try container.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null
        )
      case "tool_result":
        self = .toolResult(
          ToolResultBlock(
            toolUseId: try container.decode(String.self, forKey: .toolUseId),
            content: try container.decodeIfPresent(ToolResultContent.self, forKey: .content),
            isError: try container.decodeIfPresent(Bool.self, forKey: .isError),
            truncated: try container.decodeIfPresent(Bool.self, forKey: .truncated),
            totalChars: try container.decodeIfPresent(Int.self, forKey: .totalChars)
          ))
      default:
        self = .unknown(type: type, raw: (try? JSONValue(from: decoder)) ?? .null)
      }
    } catch {
      self = .unknown(type: type, raw: (try? JSONValue(from: decoder)) ?? .null)
    }
  }
}

public enum MessageContent: Sendable, Equatable {
  case text(String)
  case blocks([ContentBlock])

  /// Normalized block list, mirroring the reference reducer's `contentToBlocks`.
  public var asBlocks: [ContentBlock] {
    switch self {
    case .text(let value): return [.text(value)]
    case .blocks(let blocks): return blocks
    }
  }
}

extension MessageContent: Decodable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(String.self) {
      self = .text(value)
    } else {
      self = .blocks(try container.decode([ContentBlock].self))
    }
  }
}

public struct ApiUsage: Codable, Sendable, Equatable {
  public let inputTokens: Int?
  public let outputTokens: Int?
  public let cacheCreationInputTokens: Int?
  public let cacheReadInputTokens: Int?

  private enum CodingKeys: String, CodingKey {
    case inputTokens = "input_tokens"
    case outputTokens = "output_tokens"
    case cacheCreationInputTokens = "cache_creation_input_tokens"
    case cacheReadInputTokens = "cache_read_input_tokens"
  }

  public init(
    inputTokens: Int? = nil, outputTokens: Int? = nil,
    cacheCreationInputTokens: Int? = nil, cacheReadInputTokens: Int? = nil
  ) {
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.cacheCreationInputTokens = cacheCreationInputTokens
    self.cacheReadInputTokens = cacheReadInputTokens
  }
}

public struct ApiMessage: Decodable, Sendable, Equatable {
  /// 'user' | 'assistant'; kept as String for forward compatibility.
  public let role: String
  public let content: MessageContent
  public let model: String?
  public let stopReason: String?
  public let usage: ApiUsage?

  private enum CodingKeys: String, CodingKey {
    case role, content, model, usage
    case stopReason = "stop_reason"
  }

  public init(
    role: String, content: MessageContent, model: String? = nil,
    stopReason: String? = nil, usage: ApiUsage? = nil
  ) {
    self.role = role
    self.content = content
    self.model = model
    self.stopReason = stopReason
    self.usage = usage
  }
}

// MARK: - Permission requests

public struct PermissionRequest: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let toolName: String
  public let input: JSONValue
  public let toolUseId: String
  /// Full prompt sentence from the SDK, e.g. "Claude wants to read foo.txt".
  public let title: String?
  /// Short noun phrase for the tool action, e.g. "Read file".
  public let displayName: String?
  public let description: String?
  public let decisionReason: String?
  /// If raised from within a subagent, that subagent's id.
  public let agentId: String?
  /// Epoch ms after which the server resolves it via its timeout policy.
  public let expiresAt: Double?

  public init(
    id: String, toolName: String, input: JSONValue, toolUseId: String,
    title: String? = nil, displayName: String? = nil, description: String? = nil,
    decisionReason: String? = nil, agentId: String? = nil, expiresAt: Double? = nil
  ) {
    self.id = id
    self.toolName = toolName
    self.input = input
    self.toolUseId = toolUseId
    self.title = title
    self.displayName = displayName
    self.description = description
    self.decisionReason = decisionReason
    self.agentId = agentId
    self.expiresAt = expiresAt
  }
}

/// 'client' | 'timeout' | 'policy'; kept as String so a new source never breaks decoding.
public typealias PermissionDecisionSource = String

public enum PermissionBehavior: String, Codable, Sendable {
  case allow
  case deny
}

// MARK: - User questions (the AskUserQuestion tool)

public struct UserQuestionOption: Decodable, Sendable, Equatable {
  public let label: String
  public let description: String?
  public let preview: String?
}

public struct UserQuestion: Decodable, Sendable, Equatable {
  public let question: String
  public let header: String
  public let options: [UserQuestionOption]
  public let multiSelect: Bool?
}

/// The AskUserQuestion tool's input shape, for rendering a question form from a
/// `PermissionRequest` whose `toolName` is "AskUserQuestion". Decode via
/// `request.input.decoded(as: UserQuestionInput.self)`.
public struct UserQuestionInput: Decodable, Sendable, Equatable {
  public let questions: [UserQuestion]
}

public enum QuestionBehavior: String, Codable, Sendable {
  case ask
  case auto
  case deny
}

// MARK: - Capabilities (models / slash commands)

public struct ModelOption: Codable, Sendable, Equatable, Identifiable {
  /// Model id for createSession.model / set_model.
  public let value: String
  /// Wire id this row resolves to ('sonnet' → 'claude-sonnet-5'). A session
  /// reports the *resolved* model, so this is how the running model is matched
  /// back to the row that names it. Absent on an older server.
  public let resolvedModel: String?
  public let displayName: String
  public let description: String?
  /// Whether this belongs in a picker's main list rather than behind "more
  /// models" — the newest model of each family. Grouped server-side so every
  /// client splits the list identically; absent (an older server) reads as
  /// primary, which shows everything rather than hiding it.
  public let primary: Bool?
  /// Reasoning efforts this model supports at create time (codex catalogs carry
  /// them). Absent = the engine's default set applies. Open strings.
  public let reasoningEfforts: [String]?

  public var id: String { value }

  /// The chip form of the name: `displayName` without a trailing parenthetical,
  /// so "Opus (1M context)" fits a status bar as "Opus" while the picker still
  /// shows the CLI's full string.
  public var shortDisplayName: String {
    guard let paren = displayName.firstIndex(of: "("), paren > displayName.startIndex else {
      return displayName
    }
    return String(displayName[displayName.startIndex..<paren])
      .trimmingCharacters(in: .whitespaces)
  }

  public init(
    value: String, resolvedModel: String? = nil, displayName: String, description: String? = nil,
    primary: Bool? = nil, reasoningEfforts: [String]? = nil
  ) {
    self.value = value
    self.resolvedModel = resolvedModel
    self.displayName = displayName
    self.description = description
    self.primary = primary
    self.reasoningEfforts = reasoningEfforts
  }

  /// Whether this row is the one naming `model`.
  ///
  /// Three passes, narrowest first, because the CLI's rows and the id a session
  /// *reports* are written differently: the rows are aliases ('opus[1m]',
  /// 'sonnet', 'claude-fable-5[1m]') and the session reports a resolved wire id
  /// ('claude-opus-4-8[1m]'). `resolvedModel` is the server's own answer to this
  /// and wins when present; the family fallback covers a CLI that doesn't send
  /// it, which is the difference between the chip reading "Opus" and reading
  /// `claude-opus-4-8[1m]`.
  public func matches(_ model: String) -> Bool {
    if model == value || model == resolvedModel { return true }
    let stripped = Self.dropVariant(model)
    // A row that declares what it resolves to is *authoritative*, including when
    // it disagrees: two rows of the same family ("Opus 5" and "Opus 4.8") differ
    // only here, so falling through to the family would check both.
    if let resolvedModel { return stripped == Self.dropVariant(resolvedModel) }
    // Only for a row that doesn't say: the family token, so 'claude-opus-5'
    // finds the row 'opus' on a server too old to send `resolvedModel`.
    let family = Self.family(stripped)
    return !family.isEmpty && family == Self.family(Self.dropVariant(value))
  }

  /// Everything before a '[1m]'-style context-window suffix.
  private static func dropVariant(_ id: String) -> String {
    guard let bracket = id.firstIndex(of: "[") else { return id }
    return String(id[id.startIndex..<bracket])
  }

  /// 'claude-opus-4-8' → "opus", 'sonnet' → "sonnet". The vendor prefix and the
  /// version tail are dropped; what is left is the name a person would say.
  private static func family(_ id: String) -> String {
    var parts = id.lowercased().split(separator: "-").map(String.init)
    if parts.first == "claude" { parts.removeFirst() }
    return parts.first ?? ""
  }
}

/// A skill the engine can decide to use — **not** a command.
///
/// The distinction is why this is its own type. A slash command is wire syntax
/// the CLI parses out of the message; a skill is a capability the model chooses
/// from its description, and there is no `/skillname` any engine recognises. So
/// a skill may be listed, and may be offered as a typing aid that inserts
/// editable prose (`defaultPrompt`) — but never as a command chip.
public struct SkillInfo: Decodable, Sendable, Equatable, Identifiable {
  /// Directory name under the skills root — the identity the model refers to.
  public let name: String
  /// What the skill is for, as its own manifest states it. This is the text the
  /// MODEL selects on, so it is also the most honest thing to show a human.
  public let description: String?
  public let shortDescription: String?
  public let displayName: String?
  /// The engine's own suggested opening message. Inserted for the user to
  /// finish and send — a draft, never something submitted on selection.
  public let defaultPrompt: String?
  /// 'user' | 'repo' | 'system' | 'admin' — kept as String, the set may grow.
  public let scope: String?
  /// False when the operator has it switched off: still listed, because
  /// "installed but off" is a different answer from "not installed".
  public let enabled: Bool

  public var id: String { name }

  public init(
    name: String, description: String? = nil, shortDescription: String? = nil,
    displayName: String? = nil, defaultPrompt: String? = nil, scope: String? = nil,
    enabled: Bool = true
  ) {
    self.name = name
    self.description = description
    self.shortDescription = shortDescription
    self.displayName = displayName
    self.defaultPrompt = defaultPrompt
    self.scope = scope
    self.enabled = enabled
  }

  // Spelled out, not synthesized: a custom `init(from:)` suppresses synthesis,
  // and every key here is one the gateway may omit.
  private enum CodingKeys: String, CodingKey {
    case name, description, shortDescription, displayName, defaultPrompt, scope, enabled
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    description = try c.decodeIfPresent(String.self, forKey: .description)
    shortDescription = try c.decodeIfPresent(String.self, forKey: .shortDescription)
    displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
    defaultPrompt = try c.decodeIfPresent(String.self, forKey: .defaultPrompt)
    scope = try c.decodeIfPresent(String.self, forKey: .scope)
    enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
  }
}

/// One file an engine wrote on the host, from a `file_produced` event. Fetch it
/// at `GET /sessions/:id/produced/:fileId` — no host-file roots to declare and
/// no byte cap, because the allowlist is "paths this session's runner reported
/// producing" rather than "anywhere under a root".
public struct ProducedFile: Sendable, Equatable, Identifiable {
  public let fileId: String
  /// Absolute host path, as the engine reported it.
  public let path: String
  public let mediaType: String?
  public let bytes: Int?
  public let toolUseId: String?

  public var id: String { fileId }

  public init(
    fileId: String, path: String, mediaType: String? = nil, bytes: Int? = nil,
    toolUseId: String? = nil
  ) {
    self.fileId = fileId
    self.path = path
    self.mediaType = mediaType
    self.bytes = bytes
    self.toolUseId = toolUseId
  }
}

public struct SlashCommandInfo: Decodable, Sendable, Equatable, Identifiable {
  /// Command name without the leading slash.
  public let name: String
  public let description: String?
  public let argumentHint: String?
  public let aliases: [String]?

  public var id: String { name }

  public init(
    name: String, description: String? = nil, argumentHint: String? = nil, aliases: [String]? = nil
  ) {
    self.name = name
    self.description = description
    self.argumentHint = argumentHint
    self.aliases = aliases
  }
}

// MARK: - Usage telemetry

public struct ContextUsageCategory: Decodable, Sendable, Equatable {
  public let name: String
  public let tokens: Int
  /// Often a CLI theme token name ('inactive', ...), not a CSS color — validate before styling.
  public let color: String

  public init(name: String, tokens: Int, color: String) {
    self.name = name
    self.tokens = tokens
    self.color = color
  }
}

public struct ContextUsage: Decodable, Sendable, Equatable {
  public let categories: [ContextUsageCategory]
  public let totalTokens: Int
  public let maxTokens: Int
  /// Used share of the window, 0–100.
  public let percentage: Double
  public let model: String?

  public init(
    categories: [ContextUsageCategory], totalTokens: Int, maxTokens: Int,
    percentage: Double, model: String? = nil
  ) {
    self.categories = categories
    self.totalTokens = totalTokens
    self.maxTokens = maxTokens
    self.percentage = percentage
    self.model = model
  }
}

/// The context reading that rides the **sessions list**, as opposed to the full
/// ``ContextUsage`` that rides the event stream.
///
/// Three numbers, and the omission is the design: the category breakdown belongs
/// to a sheet with a live session behind it, and this rides every row of a list
/// polled at 1.2s. `percentage` alone would size a ring; the token pair is what
/// lets a row *say* `142k / 200k` without a second round trip.
public struct ContextReading: Decodable, Sendable, Equatable {
  public let totalTokens: Int
  public let maxTokens: Int
  /// Used share of the window, 0–100.
  public let percentage: Double

  public init(totalTokens: Int, maxTokens: Int, percentage: Double) {
    self.totalTokens = totalTokens
    self.maxTokens = maxTokens
    self.percentage = percentage
  }
}

/// Emitted only for claude.ai subscription sessions — API-key sessions may never
/// produce one, so clients must render nothing (not 0%) until data arrives.
public struct RateLimitInfo: Decodable, Sendable, Equatable {
  /// 'allowed' | 'allowed_warning' | 'rejected' — kept as String, the SDK union may grow.
  public let status: String
  /// 'five_hour' | 'seven_day' | ... — kept as String, the SDK union may grow.
  public let rateLimitType: String?
  /// Used share of the window, 0–100. Absent = unknown, never 0.
  public let utilization: Double?
  /// Epoch **seconds** when the window resets.
  public let resetsAt: Double?
  public let isUsingOverage: Bool?

  public init(
    status: String, rateLimitType: String? = nil, utilization: Double? = nil,
    resetsAt: Double? = nil, isUsingOverage: Bool? = nil
  ) {
    self.status = status
    self.rateLimitType = rateLimitType
    self.utilization = utilization
    self.resetsAt = resetsAt
    self.isUsingOverage = isUsingOverage
  }
}

// MARK: - Tool execution

/// 'server' | 'browser' | 'managed' | 'remote'; kept as String (advisory, for display).
public typealias ToolExecutionBackend = String

public enum ToolExecutionOutput: Sendable, Equatable {
  case text(String)
  case json(JSONValue)
}

extension ToolExecutionOutput: Codable {
  private enum CodingKeys: String, CodingKey { case type, value }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .type) {
    case "text":
      self = .text(try container.decode(String.self, forKey: .value))
    default:
      self = .json(try container.decodeIfPresent(JSONValue.self, forKey: .value) ?? .null)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .text(let value):
      try container.encode("text", forKey: .type)
      try container.encode(value, forKey: .value)
    case .json(let value):
      try container.encode("json", forKey: .type)
      try container.encode(value, forKey: .value)
    }
  }
}

// MARK: - Session events (server -> client)

public struct SystemInitEvent: Decodable, Sendable, Equatable {
  public let sdkSessionId: String
  public let model: String
  public let cwd: String
  /// 'oauth' = claude.ai subscription; other values are API-key provenance. Kept as String.
  public let apiKeySource: String
  public let tools: [String]
  public let skills: [String]
  public let slashCommands: [String]
  public let permissionMode: PermissionMode
  public let claudeCodeVersion: String
  public let mcpServers: [McpServerStatus]

  public struct McpServerStatus: Decodable, Sendable, Equatable {
    public let name: String
    public let status: String

    public init(name: String, status: String) {
      self.name = name
      self.status = status
    }
  }

  public init(
    sdkSessionId: String, model: String, cwd: String, apiKeySource: String,
    tools: [String] = [], skills: [String] = [], slashCommands: [String] = [],
    permissionMode: PermissionMode = .default, claudeCodeVersion: String = "",
    mcpServers: [McpServerStatus] = []
  ) {
    self.sdkSessionId = sdkSessionId
    self.model = model
    self.cwd = cwd
    self.apiKeySource = apiKeySource
    self.tools = tools
    self.skills = skills
    self.slashCommands = slashCommands
    self.permissionMode = permissionMode
    self.claudeCodeVersion = claudeCodeVersion
    self.mcpServers = mcpServers
  }
}

public struct AssistantMessageEvent: Decodable, Sendable, Equatable {
  public let message: ApiMessage
  /// Set when the message was produced inside a subagent (Task tool).
  public let parentToolUseId: String?
  /// True when backfilled from a resumed session's history.
  public let replay: Bool?
  public let uuid: String

  public init(message: ApiMessage, parentToolUseId: String? = nil, replay: Bool? = nil, uuid: String) {
    self.message = message
    self.parentToolUseId = parentToolUseId
    self.replay = replay
    self.uuid = uuid
  }
}

/// One hunk of a file edit, in unified-diff terms.
///
/// The numbers are the **engine's own**, never this client's: `newStart` is
/// where the hunk begins in the file *after* the edit, which is what a reader
/// needs to jump to the change. No client has read the file, so one that
/// computed them would point confidently at the wrong line.
public struct PatchHunk: Codable, Sendable, Equatable {
  public let oldStart: Int
  public let oldLines: Int
  public let newStart: Int
  public let newLines: Int
  /// Body lines, each prefixed ' ' (context), '-' (removed) or '+' (added), as
  /// unified diff spells them. The prefix is part of the string.
  public let lines: [String]

  public init(oldStart: Int, oldLines: Int, newStart: Int, newLines: Int, lines: [String]) {
    self.oldStart = oldStart
    self.oldLines = oldLines
    self.newStart = newStart
    self.newLines = newLines
    self.lines = lines
  }
}

/// What a file-editing tool changed — the renderable half of an engine's edit
/// output, and deliberately only that half.
///
/// The Claude SDK's `FileEditOutput` also carries `originalFile`, the entire
/// pre-edit file. That must not travel: this log is replayed to every attaching
/// client and captured into parking snapshots, so a whole file on every edit is
/// paid for again on every attach, forever. The runner projects it down to the
/// hunks, which is exactly what a diff renders and nothing more.
public struct FilePatch: Codable, Sendable, Equatable {
  /// Absolute path the engine reported, when it named one.
  public let path: String?
  /// `create` when the file did not exist before this edit.
  public let kind: String?
  public let hunks: [PatchHunk]
  /// Hunks were dropped to keep the event small. A renderer must say so rather
  /// than present a partial diff as the whole change.
  public let truncated: Bool?

  public init(path: String? = nil, kind: String? = nil, hunks: [PatchHunk], truncated: Bool? = nil) {
    self.path = path
    self.kind = kind
    self.hunks = hunks
    self.truncated = truncated
  }
}

public struct UserMessageEvent: Decodable, Sendable, Equatable {
  public let message: ApiMessage
  public let parentToolUseId: String?
  public let replay: Bool?
  /// True for tool results and other synthetic user-role messages.
  public let synthetic: Bool?
  /// Files sent with this message, by reference. `message` carries the typed text
  /// alone — the bytes went to the model, not into the event log.
  public let attachments: [MessageAttachment]?
  /// What a file-editing tool changed, when this message carries that tool's
  /// result. Set by the runner from the engine's own structured output — never
  /// derived by a client from the result text — and only when the message
  /// carries exactly one `tool_result` block, which is what both engines send.
  /// With two, nothing says which call the patch belongs to, and guessing would
  /// hang a diff off the wrong row.
  public let patch: FilePatch?
  public let uuid: String?

  public init(
    message: ApiMessage, parentToolUseId: String? = nil, replay: Bool? = nil,
    synthetic: Bool? = nil, attachments: [MessageAttachment]? = nil,
    patch: FilePatch? = nil, uuid: String? = nil
  ) {
    self.message = message
    self.parentToolUseId = parentToolUseId
    self.replay = replay
    self.synthetic = synthetic
    self.attachments = attachments
    self.patch = patch
    self.uuid = uuid
  }
}

/// A file the user attached to a message.
///
/// The bytes never ride the protocol: an attachment is uploaded first
/// (`POST /sessions/:id/attachments`), the message names it by id, and this
/// reference is what lands in the replayed event log. Fetch
/// `GET /sessions/:id/attachments/:id` to render it.
public struct MessageAttachment: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let mediaType: String
  public let bytes: Int

  public init(id: String, name: String, mediaType: String, bytes: Int) {
    self.id = id
    self.name = name
    self.mediaType = mediaType
    self.bytes = bytes
  }

  /// Images render as a thumbnail; everything else gets a named chip.
  public var isImage: Bool { mediaType.hasPrefix("image/") }
}

/// Raw Anthropic streaming event; only the fields the transcript needs are modeled.
public struct StreamDeltaEvent: Decodable, Sendable, Equatable {
  public let event: Body
  public let parentToolUseId: String?
  public let uuid: String

  public struct Body: Decodable, Sendable, Equatable {
    public let type: String
    public let delta: Delta?

    public init(type: String, delta: Delta? = nil) {
      self.type = type
      self.delta = delta
    }
  }

  public struct Delta: Decodable, Sendable, Equatable {
    public let type: String?
    public let text: String?
    public let thinking: String?

    public init(type: String? = nil, text: String? = nil, thinking: String? = nil) {
      self.type = type
      self.text = text
      self.thinking = thinking
    }
  }

  public init(event: Body, parentToolUseId: String? = nil, uuid: String) {
    self.event = event
    self.parentToolUseId = parentToolUseId
    self.uuid = uuid
  }
}

public struct TurnResultEvent: Decodable, Sendable, Equatable {
  /// 'success' | 'error_during_execution' | 'error_max_turns' | ... — kept as String.
  public let subtype: String
  public let isError: Bool
  public let durationMs: Double
  public let numTurns: Int
  public let totalCostUsd: Double
  /// Final text of the turn (success only).
  public let result: String?
  public let errors: [String]?
  public let usage: JSONValue?

  public init(
    subtype: String, isError: Bool, durationMs: Double, numTurns: Int, totalCostUsd: Double,
    result: String? = nil, errors: [String]? = nil, usage: JSONValue? = nil
  ) {
    self.subtype = subtype
    self.isError = isError
    self.durationMs = durationMs
    self.numTurns = numTurns
    self.totalCostUsd = totalCostUsd
    self.result = result
    self.errors = errors
    self.usage = usage
  }
}

public enum SessionEventBody: Sendable, Equatable {
  case systemInit(SystemInitEvent)
  case statusChanged(status: SessionStatus, detail: String?)
  case capabilities(
    models: [ModelOption], commands: [SlashCommandInfo], defaultModel: String?)
  /// The skills this engine can reach, replaced whole each time. Only engines
  /// whose record sets `skillsList` ever send it.
  case skills([SkillInfo])
  /// The engine wrote a host file and handed over its path — the
  /// host-filesystem sibling of `fileDelivered`.
  case fileProduced(ProducedFile)
  /// `model` nil = back to the server default.
  case modelChanged(model: String?)
  case permissionModeChanged(mode: PermissionMode)
  case contextUsage(ContextUsage)
  case rateLimit(RateLimitInfo)
  /// Which claude.ai plan the rate-limit windows belong to ('pro', 'max', ...).
  /// Never sent for an API-key session, which has no plan.
  case planInfo(subscriptionType: String)
  /// The engine started a fresh conversation inside the same session (`/clear`,
  /// plan-mode exit). The transcript empties; session-scoped state survives.
  /// `sdkSessionId` is the fresh conversation's engine session id, when the
  /// engine reported one — the follow-up `system_init` stays authoritative.
  case conversationReset(sdkSessionId: String?)
  case assistantMessage(AssistantMessageEvent)
  case userMessage(UserMessageEvent)
  case streamDelta(StreamDeltaEvent)
  case turnResult(TurnResultEvent)
  case permissionRequested(PermissionRequest)
  case permissionResolved(
    requestId: String, behavior: PermissionBehavior,
    resolvedBy: PermissionDecisionSource, message: String?)
  case executionDispatched(
    executionId: String, toolName: String, backend: ToolExecutionBackend,
    deferred: Bool, expiresAt: Double?)
  case executionResult(
    executionId: String, output: ToolExecutionOutput, logs: [String]?, durationMs: Double?)
  case executionFailed(
    executionId: String, reason: String, error: String, logs: [String]?, durationMs: Double?)
  case fileDelivered(path: String, bytes: Int, description: String?)
  /// Any SDKMessage this protocol version doesn't model first-class.
  case sdkEvent(payload: JSONValue)
  case sessionError(message: String)
  /// reason: 'client' | 'server' | 'error'; kept as String.
  case sessionClosed(reason: String)
  /// An event type (or payload shape) this Swift mirror doesn't model — never a stream error.
  case unknown(type: String, raw: JSONValue)
}

public struct SessionEvent: Sendable, Equatable {
  /// Monotonic per-session sequence number, starting at 1.
  public let seq: Int
  /// Epoch ms when the server emitted the event.
  public let ts: Double
  public let body: SessionEventBody

  public init(seq: Int, ts: Double, body: SessionEventBody) {
    self.seq = seq
    self.ts = ts
    self.body = body
  }
}

extension SessionEvent: Decodable {
  private enum CodingKeys: String, CodingKey {
    case seq, ts, type, status, detail, models, commands, model, mode, usage, info
    case subscriptionType, defaultModel
    case requestId, behavior, resolvedBy, message, request
    case executionId, toolName, backend, deferred, expiresAt, output, logs, durationMs
    case reason, error, path, bytes, description, payload
    case skills, fileId, mediaType, toolUseId
    case sdkSessionId
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    seq = try container.decode(Int.self, forKey: .seq)
    ts = try container.decode(Double.self, forKey: .ts)
    let type = try container.decode(String.self, forKey: .type)
    do {
      switch type {
      case "system_init":
        body = .systemInit(try SystemInitEvent(from: decoder))
      case "status_changed":
        body = .statusChanged(
          status: try container.decode(SessionStatus.self, forKey: .status),
          detail: try container.decodeIfPresent(String.self, forKey: .detail))
      case "capabilities":
        body = .capabilities(
          models: try container.decode([ModelOption].self, forKey: .models),
          commands: try container.decode([SlashCommandInfo].self, forKey: .commands),
          defaultModel: try container.decodeIfPresent(String.self, forKey: .defaultModel))
      case "skills":
        body = .skills(try container.decode([SkillInfo].self, forKey: .skills))
      case "file_produced":
        body = .fileProduced(
          ProducedFile(
            fileId: try container.decode(String.self, forKey: .fileId),
            path: try container.decode(String.self, forKey: .path),
            mediaType: try container.decodeIfPresent(String.self, forKey: .mediaType),
            bytes: try container.decodeIfPresent(Int.self, forKey: .bytes),
            toolUseId: try container.decodeIfPresent(String.self, forKey: .toolUseId)))
      case "model_changed":
        body = .modelChanged(model: try container.decodeIfPresent(String.self, forKey: .model))
      case "permission_mode_changed":
        body = .permissionModeChanged(mode: try container.decode(PermissionMode.self, forKey: .mode))
      case "context_usage":
        body = .contextUsage(try container.decode(ContextUsage.self, forKey: .usage))
      case "rate_limit":
        body = .rateLimit(try container.decode(RateLimitInfo.self, forKey: .info))
      case "plan_info":
        body = .planInfo(
          subscriptionType: try container.decode(String.self, forKey: .subscriptionType))
      case "conversation_reset":
        body = .conversationReset(
          sdkSessionId: try container.decodeIfPresent(String.self, forKey: .sdkSessionId))
      case "assistant_message":
        body = .assistantMessage(try AssistantMessageEvent(from: decoder))
      case "user_message":
        body = .userMessage(try UserMessageEvent(from: decoder))
      case "stream_delta":
        body = .streamDelta(try StreamDeltaEvent(from: decoder))
      case "turn_result":
        body = .turnResult(try TurnResultEvent(from: decoder))
      case "permission_requested":
        body = .permissionRequested(try container.decode(PermissionRequest.self, forKey: .request))
      case "permission_resolved":
        body = .permissionResolved(
          requestId: try container.decode(String.self, forKey: .requestId),
          behavior: try container.decode(PermissionBehavior.self, forKey: .behavior),
          resolvedBy: try container.decode(String.self, forKey: .resolvedBy),
          message: try container.decodeIfPresent(String.self, forKey: .message))
      case "execution_dispatched":
        body = .executionDispatched(
          executionId: try container.decode(String.self, forKey: .executionId),
          toolName: try container.decode(String.self, forKey: .toolName),
          backend: try container.decode(String.self, forKey: .backend),
          deferred: try container.decodeIfPresent(Bool.self, forKey: .deferred) ?? false,
          expiresAt: try container.decodeIfPresent(Double.self, forKey: .expiresAt))
      case "execution_result":
        body = .executionResult(
          executionId: try container.decode(String.self, forKey: .executionId),
          output: try container.decode(ToolExecutionOutput.self, forKey: .output),
          logs: try container.decodeIfPresent([String].self, forKey: .logs),
          durationMs: try container.decodeIfPresent(Double.self, forKey: .durationMs))
      case "execution_failed":
        body = .executionFailed(
          executionId: try container.decode(String.self, forKey: .executionId),
          reason: try container.decode(String.self, forKey: .reason),
          error: try container.decode(String.self, forKey: .error),
          logs: try container.decodeIfPresent([String].self, forKey: .logs),
          durationMs: try container.decodeIfPresent(Double.self, forKey: .durationMs))
      case "file_delivered":
        body = .fileDelivered(
          path: try container.decode(String.self, forKey: .path),
          bytes: try container.decode(Int.self, forKey: .bytes),
          description: try container.decodeIfPresent(String.self, forKey: .description))
      case "sdk_event":
        body = .sdkEvent(payload: try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null)
      case "session_error":
        body = .sessionError(message: try container.decode(String.self, forKey: .message))
      case "session_closed":
        body = .sessionClosed(reason: try container.decode(String.self, forKey: .reason))
      default:
        body = .unknown(type: type, raw: (try? JSONValue(from: decoder)) ?? .null)
      }
    } catch {
      // A known type whose payload doesn't decode (a newer server extended it in a
      // way this mirror doesn't model) degrades to .unknown, never a stream error.
      body = .unknown(type: type, raw: (try? JSONValue(from: decoder)) ?? .null)
    }
  }
}

// MARK: - Commands (client -> server)

public enum SessionCommand: Sendable, Equatable {
  case userMessage(text: String, attachmentIds: [String]? = nil)
  case permissionDecision(
    requestId: String, behavior: PermissionBehavior,
    updatedInput: [String: JSONValue]? = nil, message: String? = nil, interrupt: Bool? = nil)
  case interrupt
  case setPermissionMode(PermissionMode)
  /// nil model = back to the server default.
  case setModel(String?)
  case toolCallResult(executionId: String, output: ToolExecutionOutput, logs: [String]? = nil)
  case toolCallError(executionId: String, reason: String, error: String, logs: [String]? = nil)
  case close
}

extension SessionCommand: Encodable {
  private enum CodingKeys: String, CodingKey {
    case type, text, requestId, behavior, updatedInput, message, interrupt, mode, model
    case executionId, output, logs, reason, error, attachmentIds
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .userMessage(let text, let attachmentIds):
      try container.encode("user_message", forKey: .type)
      try container.encode(text, forKey: .text)
      try container.encodeIfPresent(attachmentIds, forKey: .attachmentIds)
    case .permissionDecision(let requestId, let behavior, let updatedInput, let message, let interrupt):
      try container.encode("permission_decision", forKey: .type)
      try container.encode(requestId, forKey: .requestId)
      try container.encode(behavior, forKey: .behavior)
      try container.encodeIfPresent(updatedInput, forKey: .updatedInput)
      try container.encodeIfPresent(message, forKey: .message)
      try container.encodeIfPresent(interrupt, forKey: .interrupt)
    case .interrupt:
      try container.encode("interrupt", forKey: .type)
    case .setPermissionMode(let mode):
      try container.encode("set_permission_mode", forKey: .type)
      try container.encode(mode, forKey: .mode)
    case .setModel(let model):
      try container.encode("set_model", forKey: .type)
      try container.encodeIfPresent(model, forKey: .model)
    case .toolCallResult(let executionId, let output, let logs):
      try container.encode("tool_call_result", forKey: .type)
      try container.encode(executionId, forKey: .executionId)
      try container.encode(output, forKey: .output)
      try container.encodeIfPresent(logs, forKey: .logs)
    case .toolCallError(let executionId, let reason, let error, let logs):
      try container.encode("tool_call_error", forKey: .type)
      try container.encode(executionId, forKey: .executionId)
      try container.encode(reason, forKey: .reason)
      try container.encode(error, forKey: .error)
      try container.encodeIfPresent(logs, forKey: .logs)
    case .close:
      try container.encode("close", forKey: .type)
    }
  }
}

// MARK: - WebSocket frames

/// First frame the server sends after a successful attach.
public struct AttachedFrame: Decodable, Sendable, Equatable {
  public let protocolVersion: Int
  public let session: SessionInfo
  /// Events with seq > the client's `afterSeq` follow as `event` frames.
  public let replayingFrom: Int

  public init(protocolVersion: Int, session: SessionInfo, replayingFrom: Int) {
    self.protocolVersion = protocolVersion
    self.session = session
    self.replayingFrom = replayingFrom
  }
}

/// Ask the attached client to execute a tool call in its own sandbox (browser
/// bridge). An iOS remote-control client typically ignores these — the server
/// fails the execution at `expiresAt`.
public struct ToolCallRequestFrame: Decodable, Sendable, Equatable {
  public let executionId: String
  public let toolName: String
  public let input: JSONValue
  public let vfsSeed: [String: String]?
  public let limits: Limits?
  public let expiresAt: Double?

  public struct Limits: Decodable, Sendable, Equatable {
    public let timeoutMs: Double?
    public let memoryLimitBytes: Double?
  }
}

public enum ServerFrame: Sendable, Equatable {
  case attached(AttachedFrame)
  case event(SessionEvent)
  case toolCallRequest(ToolCallRequestFrame)
  case toolCallCanceled(executionId: String, reason: String)
  case protocolError(message: String)
  /// A frame type this mirror doesn't model — ignore, never a stream error.
  case unknown(type: String, raw: JSONValue)
}

extension ServerFrame: Decodable {
  private enum CodingKeys: String, CodingKey {
    case type, event, executionId, reason, message
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    do {
      switch type {
      case "attached":
        self = .attached(try AttachedFrame(from: decoder))
      case "event":
        self = .event(try container.decode(SessionEvent.self, forKey: .event))
      case "tool_call_request":
        self = .toolCallRequest(try ToolCallRequestFrame(from: decoder))
      case "tool_call_canceled":
        self = .toolCallCanceled(
          executionId: try container.decode(String.self, forKey: .executionId),
          reason: try container.decode(String.self, forKey: .reason))
      case "protocol_error":
        self = .protocolError(message: try container.decode(String.self, forKey: .message))
      default:
        self = .unknown(type: type, raw: (try? JSONValue(from: decoder)) ?? .null)
      }
    } catch {
      self = .unknown(type: type, raw: (try? JSONValue(from: decoder)) ?? .null)
    }
  }
}
