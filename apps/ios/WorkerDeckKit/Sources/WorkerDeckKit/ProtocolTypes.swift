import Foundation

/// The slice of `@workerdeck/protocol` the REST records and the Live Activity still decode in Swift.
/// The session socket and its events are decoded by the Rust core, not here.
///
/// Keys are spelled explicitly per type. Never decode with a global key-conversion strategy.
public enum WorkerProtocol {
  /// Mirror of PROTOCOL_VERSION. Compare against the attached frame's `protocolVersion`.
  public static let version = 1
  /// Mirror of SHELL_COMMAND_MAX - the longest `$` command the gateway accepts.
  public static let shellCommandMax = 4000
  /// Mirror of SHELL_LABEL_MAX.
  public static let shellLabelMax = 80
  /// Mirror of SHELL_INPUT_MAX - the most a single `shell_input` frame may carry.
  /// The drill-in chunks a paste rather than letting the gateway refuse it.
  public static let shellInputMax = 4096
  /// Mirror of SHELL_COLS and SHELL_ROWS, the size a shell is spawned at. A
  /// client's own size applies on attach and the last attach wins, so these are
  /// only what an unattached shell ran at.
  public static let shellCols = 120
  public static let shellRows = 40
  /// Mirror of SHELL_INLINE_LINES - how much of a shell's output the row carries.
  public static let shellInlineLines = 8
  /// Mirror of SHELL_PROMOTE_MS.
  public static let shellPromoteMs: Double = 3_000
  /// Mirror of SHELL_LINGER_MS.
  public static let shellLingerMs: Double = 60_000
}

// MARK: - Shells

public enum ShellOwner: String, Decodable, Sendable, Equatable, Hashable {
  case user
  case agent
}

public enum ShellStatus: String, Decodable, Sendable, Equatable, Hashable {
  case running
  case exited
}

/// Why a shell stopped. The one union in this mirror that decodes **leniently**,
/// and deliberately: the closed list is protocol 1's final one, so a gateway
/// sending anything else is ahead of this build, and widening the Swift side
/// later would otherwise cost a `PROTOCOL_VERSION` bump (the `ChecklistStatus`
/// argument, applied before it can bite). An unrecognised reason reads as
/// ``unknown`` and the row says "ended", never a failed decode that would take
/// the whole message down with it.
public enum ShellEndReason: String, Decodable, Sendable, Equatable, Hashable {
  case exit
  case killed
  case timeout
  case serverStopped = "server_stopped"
  case serverRestarted = "server_restarted"
  case spawnFailed = "spawn_failed"
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = ShellEndReason(rawValue: raw) ?? .unknown
  }
}

/// One tracked shell - the record every `$` invocation gets, and the entity the
/// transcript row, the session list and (later) the drill-in are all views over.
public struct ShellInfo: Decodable, Sendable, Equatable, Hashable, Identifiable {
  /// Gateway-minted (`sh_` + base32), never the pid.
  public let id: String
  public let sessionId: String
  /// Per-session counter - what "shell #3" means to a person and to the model.
  public let ordinal: Int
  public let command: String
  /// First line of `command`, clipped to ``WorkerProtocol/shellLabelMax``.
  public let label: String
  public let cwd: String
  public let owner: ShellOwner
  public let status: ShellStatus
  public let startedAt: Double
  public let endedAt: Double?
  public let exitCode: Int?
  public let signal: Int?
  public let endReason: ShellEndReason?
  /// Raw bytes captured so far.
  public let bytes: Int
  /// The artifact hit its cap; only the tail ring advanced after.
  public let capped: Bool?
  public let cols: Int
  public let rows: Int
  public let agentWrite: Bool?

  public init(
    id: String, sessionId: String, ordinal: Int, command: String, label: String, cwd: String,
    owner: ShellOwner = .user, status: ShellStatus = .running, startedAt: Double,
    endedAt: Double? = nil, exitCode: Int? = nil, signal: Int? = nil,
    endReason: ShellEndReason? = nil, bytes: Int = 0, capped: Bool? = nil, cols: Int = 120,
    rows: Int = 40, agentWrite: Bool? = nil
  ) {
    self.id = id
    self.sessionId = sessionId
    self.ordinal = ordinal
    self.command = command
    self.label = label
    self.cwd = cwd
    self.owner = owner
    self.status = status
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.exitCode = exitCode
    self.signal = signal
    self.endReason = endReason
    self.bytes = bytes
    self.capped = capped
    self.cols = cols
    self.rows = rows
    self.agentWrite = agentWrite
  }
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
  /// All optional, and that is the compatibility story: a socket that never
  /// asked (`WorkerClient.attach(imageRefs:)`) is sent parts
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

/// How many bytes a base64 payload decodes to, without decoding it - the
/// phone's copy of protocol's `base64Bytes`.
///
/// The projection itself happens on the **gateway**: a ref minted here would be
/// an address with no route behind it, since only the gateway holds the stored
/// log the fetch reads. This exists so the arithmetic the two clients agree on
/// is written down once on this side too and can be pinned by a test against a
/// real payload - the same reason `WorkerDeckKit` mirrors rules it does not
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

// MARK: - Capabilities (models / slash commands)

public struct ModelOption: Codable, Sendable, Equatable, Identifiable {
  /// Model id for createSession.model / set_model.
  public let value: String
  /// Wire id this row resolves to ('sonnet' → 'claude-sonnet-5'). A session
  /// reports the *resolved* model, so this is how the running model is matched
  /// back to the row that names it.
  public let resolvedModel: String?
  public let displayName: String
  public let description: String?
  /// Whether this belongs in a picker's main list rather than behind "more
  /// models" - the newest model of each family. Grouped server-side so every
  /// client splits the list identically; absent reads as primary, which shows
  /// everything rather than hiding it.
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
  /// *reports* are written differently: the rows are aliases ('opus',
  /// 'sonnet', 'haiku') and the session reports a resolved wire id
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

/// A skill the engine can decide to use - **not** a command.
///
/// The distinction is why this is its own type. A slash command is wire syntax
/// the CLI parses out of the message; a skill is a capability the model chooses
/// from its description, and there is no `/skillname` any engine recognises. So
/// a skill may be listed, and may be offered as a typing aid that inserts
/// editable prose (`defaultPrompt`) - but never as a command chip.
public struct SkillInfo: Decodable, Sendable, Equatable, Identifiable {
  /// Directory name under the skills root - the identity the model refers to.
  public let name: String
  /// What the skill is for, as its own manifest states it. This is the text the
  /// MODEL selects on, so it is also the most honest thing to show a human.
  public let description: String?
  public let shortDescription: String?
  public let displayName: String?
  /// The engine's own suggested opening message. Inserted for the user to
  /// finish and send - a draft, never something submitted on selection.
  public let defaultPrompt: String?
  /// 'user' | 'repo' | 'system' | 'admin' - kept as String, the set may grow.
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
  /// Used share of the window, 0-100.
  public let percentage: Double

  public init(totalTokens: Int, maxTokens: Int, percentage: Double) {
    self.totalTokens = totalTokens
    self.maxTokens = maxTokens
    self.percentage = percentage
  }
}

/// Emitted only for claude.ai subscription sessions - API-key sessions may never
/// produce one, so clients must render nothing (not 0%) until data arrives.
public struct RateLimitInfo: Codable, Sendable, Equatable {
  /// 'allowed' | 'allowed_warning' | 'rejected' - kept as String, the SDK union may grow.
  public let status: String
  /// 'five_hour' | 'seven_day' | ... - kept as String, the SDK union may grow.
  public let rateLimitType: String?
  /// Used share of the window, 0-100. Absent = unknown, never 0.
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

// The wire's `effort: string | null`. `unsupported` is the null: the model takes no effort
// parameter. Absent on the wire is the Swift nil around it.
public enum SessionEffort: Decodable, Sendable, Equatable {
  case unsupported
  case level(String)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    self = container.decodeNil() ? .unsupported : .level(try container.decode(String.self))
  }

  public var level: String? {
    if case .level(let value) = self { return value }
    return nil
  }
}

public enum ChecklistStatus: String, Decodable, Sendable, Equatable, Hashable {
  case pending
  case inProgress = "in_progress"
  case completed
}

public struct ChecklistItem: Decodable, Sendable, Equatable, Hashable {
  public let text: String
  public let status: ChecklistStatus

  public init(text: String, status: ChecklistStatus) {
    self.text = text
    self.status = status
  }
}

extension KeyedDecodingContainer {
  public func decodeIfPresent(_ type: SessionEffort.Type, forKey key: Key) throws -> SessionEffort? {
    guard contains(key) else { return nil }
    if try decodeNil(forKey: key) { return .unsupported }
    return (try? decode(String.self, forKey: key)).map(SessionEffort.level)
  }
}
