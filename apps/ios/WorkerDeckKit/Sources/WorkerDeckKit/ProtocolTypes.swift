import Foundation

/// The slice of `@workerdeck/protocol` the REST records and the Live Activity still decode in Swift.
/// The session socket and its events are decoded by the Rust core, not here.
///
/// Keys are spelled explicitly per type. Never decode with a global key-conversion strategy.
public enum WorkerProtocol {
  /// Mirror of PROTOCOL_VERSION. Compare against the attached frame's `protocolVersion`.
  public static let version = 2
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
